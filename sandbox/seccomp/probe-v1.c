#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stddef.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static const char marker[] = "super-agent-seccomp-policy-ok\n";

static int denied_with_eperm(long result) {
  return result == -1 && errno == EPERM;
}

static int syscall_is_denied(long number) {
  errno = 0;
  return denied_with_eperm(syscall(number, 0, 0, 0, 0, 0, 0));
}

static void *thread_probe(void *unused) {
  (void)unused;
  return NULL;
}

static int must_allow_matrix(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;

  void *mapping = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (mapping == MAP_FAILED) return 0;
  ((volatile char *)mapping)[0] = 1;
  if (munmap(mapping, 4096) != 0) return 0;

  pthread_t thread;
  if (pthread_create(&thread, NULL, thread_probe, NULL) != 0) return 0;
  if (pthread_join(thread, NULL) != 0) return 0;
  return 1;
}

static int must_deny_matrix(void) {
  const long denied[] = {
    SYS_ptrace,
    SYS_mount,
    SYS_umount2,
    SYS_unshare,
    SYS_setns,
    SYS_bpf,
    SYS_perf_event_open,
    SYS_userfaultfd,
    SYS_keyctl,
    SYS_add_key,
    SYS_request_key,
    SYS_init_module,
    SYS_finit_module,
    SYS_delete_module,
    SYS_kexec_load,
    SYS_kexec_file_load,
    SYS_reboot,
    SYS_swapon,
    SYS_swapoff,
    SYS_process_vm_readv,
    SYS_process_vm_writev,
    SYS_pidfd_getfd,
  };
  for (size_t index = 0; index < sizeof(denied) / sizeof(denied[0]); index++) {
    if (!syscall_is_denied(denied[index])) return 0;
  }
  return 1;
}

static int process_boundary_is_active(void) {
  char buffer[4096];
  int descriptor = open("/proc/self/status", O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) return 0;
  ssize_t length = read(descriptor, buffer, sizeof(buffer) - 1);
  close(descriptor);
  if (length <= 0) return 0;
  buffer[length] = '\0';
  return strstr(buffer, "NoNewPrivs:\t1\n") != NULL
    && strstr(buffer, "CapEff:\t0000000000000000\n") != NULL;
}

int main(void) {
  if (syscall(SYS_getpid) <= 0) return 10;
  if (!process_boundary_is_active()) return 17;
  if (!must_allow_matrix()) return 18;
  if (!must_deny_matrix()) return 19;

  errno = 0;
  long inet_socket = syscall(SYS_socket, AF_INET, SOCK_STREAM, 0);
  if (inet_socket >= 0) {
    close((int)inet_socket);
    return 12;
  }
  if (errno != EPERM) return 13;

  errno = 0;
  long unix_socket = syscall(SYS_socket, AF_UNIX, SOCK_STREAM, 0);
  if (unix_socket >= 0) {
    close((int)unix_socket);
    return 14;
  }
  if (errno != EPERM) return 15;

  if (write(STDOUT_FILENO, marker, sizeof(marker) - 1) != (ssize_t)(sizeof(marker) - 1)) {
    return 16;
  }
  return 0;
}
