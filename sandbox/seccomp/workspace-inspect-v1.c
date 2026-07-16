#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define WORKSPACE_ROOT "/workspace"
#define MAX_LIMIT 200
#define MAX_PATH_BYTES 256
#define MAX_QUERY_BYTES 256
#define MAX_RENDERED_LINE_BYTES 4096

static void fail(const char *message) {
  (void)dprintf(STDERR_FILENO, "workspace-inspect: %s\n", message);
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

static int parse_limit(const char *value) {
  char *end = NULL;
  errno = 0;
  long result = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || result < 1 || result > MAX_LIMIT) {
    fail("invalid limit");
  }
  return (int)result;
}

static int safe_relative_path(const char *path) {
  size_t length = strlen(path);
  if (length == 0 || length > MAX_PATH_BYTES || path[0] == '/') return 0;
  if (strcmp(path, ".") == 0) return 1;
  const char *segment = path;
  for (const char *cursor = path; ; cursor++) {
    unsigned char value = (unsigned char)*cursor;
    if (value == '\0' || value == '/') {
      size_t segment_length = (size_t)(cursor - segment);
      if (segment_length == 0
          || (segment_length == 1 && segment[0] == '.')
          || (segment_length == 2 && segment[0] == '.' && segment[1] == '.')) {
        return 0;
      }
      if (value == '\0') return 1;
      segment = cursor + 1;
      continue;
    }
    if (value == '\\' || value == '\r' || value == '\n' || value < 0x20) return 0;
  }
}

static int open_relative(const char *path, int final_flags) {
  int current = open(WORKSPACE_ROOT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) fail("workspace root unavailable");
  if (strcmp(path, ".") == 0) return current;

  char copy[MAX_PATH_BYTES + 1];
  memcpy(copy, path, strlen(path) + 1);
  char *save = NULL;
  char *part = strtok_r(copy, "/", &save);
  while (part != NULL) {
    char *next = strtok_r(NULL, "/", &save);
    int flags = next == NULL
      ? final_flags
      : O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
    int opened = openat(current, part, flags);
    close(current);
    if (opened < 0) fail("path unavailable or unsafe");
    current = opened;
    part = next;
  }
  return current;
}

static int compare_names(const void *left, const void *right) {
  const char *const *a = left;
  const char *const *b = right;
  return strcmp(*a, *b);
}

static void list_files(const char *path, int limit) {
  int descriptor = open_relative(
    path,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  );
  DIR *directory = fdopendir(descriptor);
  if (directory == NULL) {
    close(descriptor);
    fail("path is not a directory");
  }

  char *names[MAX_LIMIT];
  size_t count = 0;
  int read_error = 0;
  while (count < (size_t)limit) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) {
      read_error = errno;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    names[count] = strdup(entry->d_name);
    if (names[count] == NULL) {
      closedir(directory);
      fail("out of memory");
    }
    count++;
  }
  if (read_error != 0) {
    closedir(directory);
    fail("directory read failed");
  }
  qsort(names, count, sizeof(names[0]), compare_names);
  for (size_t index = 0; index < count; index++) {
    struct stat metadata;
    if (fstatat(descriptor, names[index], &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
      closedir(directory);
      fail("directory entry changed");
    }
    if (S_ISDIR(metadata.st_mode)) {
      (void)dprintf(STDOUT_FILENO, "%s/\n", names[index]);
    } else if (S_ISREG(metadata.st_mode)) {
      (void)dprintf(STDOUT_FILENO, "%s\n", names[index]);
    } else {
      closedir(directory);
      fail("special directory entry rejected");
    }
    free(names[index]);
  }
  closedir(directory);
}

static FILE *open_text_file(const char *path) {
  int descriptor = open_relative(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  struct stat metadata;
  if (fstat(descriptor, &metadata) != 0
      || !S_ISREG(metadata.st_mode)
      || metadata.st_nlink != 1) {
    close(descriptor);
    fail("path is not a regular single-link file");
  }
  FILE *file = fdopen(descriptor, "r");
  if (file == NULL) {
    close(descriptor);
    fail("file stream unavailable");
  }
  return file;
}

static size_t rendered_length(const char *line, size_t length) {
  if (memchr(line, '\0', length) != NULL) fail("binary file rejected");
  return length > MAX_RENDERED_LINE_BYTES ? MAX_RENDERED_LINE_BYTES : length;
}

static void read_text(const char *path, int limit) {
  FILE *file = open_text_file(path);
  char *line = NULL;
  size_t capacity = 0;
  for (int line_number = 0; line_number < limit; line_number++) {
    errno = 0;
    ssize_t length = getline(&line, &capacity, file);
    if (length < 0) {
      if (errno != 0) {
        free(line);
        fclose(file);
        fail("file read failed");
      }
      break;
    }
    size_t visible = rendered_length(line, (size_t)length);
    write_all(STDOUT_FILENO, line, visible);
    if (visible < (size_t)length || (visible > 0 && line[visible - 1] != '\n')) {
      write_all(STDOUT_FILENO, "\n", 1);
    }
  }
  free(line);
  fclose(file);
}

static void search_text(const char *path, int limit, const char *query) {
  size_t query_length = strlen(query);
  if (query_length == 0 || query_length > MAX_QUERY_BYTES
      || memchr(query, '\n', query_length) != NULL
      || memchr(query, '\r', query_length) != NULL) {
    fail("invalid query");
  }
  FILE *file = open_text_file(path);
  char *line = NULL;
  size_t capacity = 0;
  unsigned long line_number = 0;
  int matches = 0;
  while (matches < limit) {
    errno = 0;
    ssize_t length = getline(&line, &capacity, file);
    if (length < 0) {
      if (errno != 0) {
        free(line);
        fclose(file);
        fail("file read failed");
      }
      break;
    }
    line_number++;
    if (memmem(line, (size_t)length, query, query_length) == NULL) continue;
    size_t visible = rendered_length(line, (size_t)length);
    (void)dprintf(STDOUT_FILENO, "%lu:", line_number);
    write_all(STDOUT_FILENO, line, visible);
    if (visible < (size_t)length || (visible > 0 && line[visible - 1] != '\n')) {
      write_all(STDOUT_FILENO, "\n", 1);
    }
    matches++;
  }
  free(line);
  fclose(file);
}

int main(int argc, char **argv) {
  if (argc < 5 || argc > 6 || strcmp(argv[1], "v1") != 0) fail("invalid protocol");
  const char *action = argv[2];
  int limit = parse_limit(argv[3]);
  const char *path = argv[4];
  if (!safe_relative_path(path)) fail("invalid path");

  if (strcmp(action, "list_files") == 0 && argc == 5) {
    list_files(path, limit);
  } else if (strcmp(action, "read_text") == 0 && argc == 5) {
    read_text(path, limit);
  } else if (strcmp(action, "search_text") == 0 && argc == 6) {
    search_text(path, limit, argv[5]);
  } else {
    fail("invalid action arguments");
  }
  return 0;
}
