#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RELEASE_WRITE_PATH "/workspace/release-write-test"
#define OUTPUT_BYTES (1024U * 1024U)
#define MAX_FORK_CHILDREN 64U
#define MAX_OPEN_DESCRIPTORS 2048U
#define CPU_TARGET_NANOSECONDS (250ULL * 1000ULL * 1000ULL)

static void fail(const char *message) {
  (void)dprintf(STDERR_FILENO, "release-probe: %s (errno=%d)\n", message, errno);
  exit(2);
}

static void write_all(int descriptor, const char *buffer, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t result = write(descriptor, buffer + written, length - written);
    if (result < 0) {
      if (errno == EINTR) continue;
      fail("output write failed");
    }
    if (result == 0) fail("output write made no progress");
    written += (size_t)result;
  }
}

static uint64_t nanoseconds(struct timespec value) {
  return (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
}

static void probe_readonly(void) {
  errno = 0;
  int descriptor = open(
    RELEASE_WRITE_PATH,
    O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
    0600
  );
  if (descriptor >= 0) {
    close(descriptor);
    fail("read-only workspace accepted a create");
  }
  if (errno != EROFS && errno != EACCES && errno != EPERM) {
    fail("read-only workspace returned an unexpected error");
  }
  (void)dprintf(STDOUT_FILENO, "release:readonly-ok\n");
}

static void probe_output(void) {
  char block[4096];
  memset(block, 'x', sizeof(block));
  for (size_t written = 0; written < OUTPUT_BYTES; written += sizeof(block)) {
    write_all(STDOUT_FILENO, block, sizeof(block));
  }
  fail("output ceiling did not terminate the probe");
}

static void sleep_for_seconds(time_t seconds) {
  struct timespec remaining = { .tv_sec = seconds, .tv_nsec = 0 };
  while (nanosleep(&remaining, &remaining) != 0) {
    if (errno != EINTR) fail("nanosleep failed");
  }
}

static void probe_sleep(void) {
  sleep_for_seconds(30);
  fail("deadline or cancellation did not terminate the probe");
}

static void release_children(
  int barrier_read,
  int barrier_write,
  pid_t *children,
  size_t count
) {
  if (close(barrier_write) != 0) fail("barrier release failed");
  if (close(barrier_read) != 0) fail("barrier close failed");
  for (size_t index = 0; index < count; index++) {
    int status = 0;
    while (waitpid(children[index], &status, 0) < 0) {
      if (errno == EINTR) continue;
      if (errno == ECHILD) break;
      fail("child reap failed");
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
      fail("child did not exit cleanly");
    }
  }
}

static void probe_fork(void) {
  pid_t children[MAX_FORK_CHILDREN];
  int barrier[2];
  if (pipe2(barrier, O_CLOEXEC) != 0) fail("barrier pipe failed");
  size_t count = 0;
  int limited = 0;
  while (count < MAX_FORK_CHILDREN) {
    errno = 0;
    pid_t child = fork();
    if (child == 0) {
      char value;
      if (close(barrier[1]) != 0) _exit(3);
      while (read(barrier[0], &value, sizeof(value)) < 0) {
        if (errno != EINTR) _exit(4);
      }
      if (close(barrier[0]) != 0) _exit(5);
      _exit(0);
    }
    if (child < 0) {
      if (errno == EAGAIN) {
        limited = 1;
        break;
      }
      int failure_errno = errno;
      release_children(barrier[0], barrier[1], children, count);
      errno = failure_errno;
      fail("fork failed unexpectedly");
    }
    children[count++] = child;
  }
  release_children(barrier[0], barrier[1], children, count);
  if (!limited) fail("pids ceiling was not reached");
  (void)dprintf(STDOUT_FILENO, "release:pids-limited:%zu\n", count);
}

static void probe_fd(void) {
  int descriptors[MAX_OPEN_DESCRIPTORS];
  size_t count = 0;
  int limited = 0;
  while (count < MAX_OPEN_DESCRIPTORS) {
    errno = 0;
    int descriptor = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) {
      if (errno == EMFILE) {
        limited = 1;
        break;
      }
      fail("descriptor open failed unexpectedly");
    }
    descriptors[count++] = descriptor;
  }
  for (size_t index = 0; index < count; index++) close(descriptors[index]);
  if (!limited) fail("open-files ceiling was not reached");
  (void)dprintf(STDOUT_FILENO, "release:fd-limited:%zu\n", count);
}

static void probe_cpu(void) {
  struct timespec cpu_start;
  struct timespec wall_start;
  struct timespec cpu_now;
  struct timespec wall_now;
  if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &cpu_start) != 0
      || clock_gettime(CLOCK_MONOTONIC, &wall_start) != 0) {
    fail("clock_gettime failed");
  }

  volatile uint64_t accumulator = 0;
  do {
    for (uint64_t index = 0; index < 100000ULL; index++) {
      accumulator = accumulator * 6364136223846793005ULL + index + 1ULL;
    }
    if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &cpu_now) != 0) {
      fail("CPU clock failed");
    }
  } while (nanoseconds(cpu_now) - nanoseconds(cpu_start) < CPU_TARGET_NANOSECONDS);

  if (clock_gettime(CLOCK_MONOTONIC, &wall_now) != 0) fail("wall clock failed");
  uint64_t cpu_microseconds = (
    nanoseconds(cpu_now) - nanoseconds(cpu_start)
  ) / 1000ULL;
  uint64_t wall_microseconds = (
    nanoseconds(wall_now) - nanoseconds(wall_start)
  ) / 1000ULL;
  (void)dprintf(
    STDOUT_FILENO,
    "release:cpu:%llu:%llu:%llu\n",
    (unsigned long long)cpu_microseconds,
    (unsigned long long)wall_microseconds,
    (unsigned long long)(accumulator & 0xffffULL)
  );
}

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "v1") != 0) fail("invalid protocol");
  if (strcmp(argv[2], "readonly") == 0) probe_readonly();
  else if (strcmp(argv[2], "output") == 0) probe_output();
  else if (strcmp(argv[2], "sleep") == 0) probe_sleep();
  else if (strcmp(argv[2], "fork") == 0) probe_fork();
  else if (strcmp(argv[2], "fd") == 0) probe_fd();
  else if (strcmp(argv[2], "cpu") == 0) probe_cpu();
  else fail("unknown action");
  return 0;
}
