export const POLICY_VERSION = 'super-agent-workspace-inspect-v1'
export const POLICY_FORMAT = 'linux-classic-bpf-sock-filter-le-v1'
export const DEFAULT_ACTION = 'errno:EPERM'
export const ARCH_MISMATCH_ACTION = 'kill-process'

export const MUST_ALLOW_PROBES = Object.freeze([
  'getpid',
  'read-only-openat',
  'read',
  'write-stdout',
  'mmap',
  'thread-create',
  'clock_gettime',
])

export const MUST_DENY_PROBES = Object.freeze([
  'ptrace',
  'socket-inet',
  'socket-unix',
  'mount',
  'umount2',
  'unshare',
  'setns',
  'bpf',
  'perf_event_open',
  'userfaultfd',
  'keyctl',
  'add_key',
  'request_key',
  'init_module',
  'finit_module',
  'delete_module',
  'kexec_load',
  'kexec_file_load',
  'reboot',
  'swapon',
  'swapoff',
  'process_vm_readv',
  'process_vm_writev',
  'pidfd_getfd',
])

// Syscall numbers are Linux UAPI ABI numbers, not host-derived values. Keeping
// them in the versioned source makes cross-host generation byte deterministic.
const X86_64 = Object.freeze({
  auditArch: 0xc000003e,
  syscalls: Object.freeze({
    read: 0, write: 1, close: 3, fstat: 5, poll: 7, lseek: 8,
    mmap: 9, mprotect: 10, munmap: 11, brk: 12, rt_sigaction: 13,
    rt_sigprocmask: 14, rt_sigreturn: 15, ioctl: 16, pread64: 17,
    readv: 19, writev: 20, access: 21, sched_yield: 24, mremap: 25,
    madvise: 28, dup: 32, dup2: 33, nanosleep: 35, getpid: 39,
    clone: 56, execve: 59, exit: 60, wait4: 61, kill: 62, uname: 63,
    fcntl: 72, getcwd: 79, chdir: 80, fchdir: 81, readlink: 89,
    gettimeofday: 96, getrlimit: 97, getrusage: 98, sysinfo: 99,
    getuid: 102, getgid: 104, geteuid: 107, getegid: 108, getppid: 110,
    sigaltstack: 131, statfs: 137, fstatfs: 138, prctl: 157,
    arch_prctl: 158, gettid: 186, readahead: 187, getdents64: 217,
    set_tid_address: 218, restart_syscall: 219, fadvise64: 221,
    clock_gettime: 228, clock_getres: 229, clock_nanosleep: 230,
    exit_group: 231, tgkill: 234, waitid: 247, openat: 257,
    newfstatat: 262, readlinkat: 267, faccessat: 269, pselect6: 270,
    ppoll: 271, set_robust_list: 273, get_robust_list: 274,
    epoll_create1: 291, dup3: 292, pipe2: 293, prlimit64: 302,
    getcpu: 309, getrandom: 318, execveat: 322, membarrier: 324,
    statx: 332, rseq: 334, clone3: 435, close_range: 436, openat2: 437,
    faccessat2: 439, futex_waitv: 449,
    // x86_64 futex has a stable legacy number used by glibc and musl.
    futex: 202,
  }),
})

const AARCH64 = Object.freeze({
  auditArch: 0xc00000b7,
  syscalls: Object.freeze({
    getcwd: 17, epoll_create1: 20, dup: 23, dup3: 24, fcntl: 25,
    ioctl: 29, statfs: 43, fstatfs: 44, faccessat: 48, chdir: 49,
    fchdir: 50, openat: 56, close: 57, pipe2: 59, getdents64: 61,
    lseek: 62, read: 63, write: 64, readv: 65, writev: 66,
    pread64: 67, pselect6: 72, ppoll: 73, readlinkat: 78,
    newfstatat: 79, fstat: 80, exit: 93, exit_group: 94, waitid: 95,
    set_tid_address: 96, futex: 98, set_robust_list: 99,
    nanosleep: 101, clock_gettime: 113, clock_getres: 114,
    clock_nanosleep: 115, sched_yield: 124, tgkill: 131,
    sigaltstack: 132, rt_sigaction: 134, rt_sigprocmask: 135,
    rt_sigreturn: 139, getrlimit: 163, getrusage: 165, prctl: 167,
    getcpu: 168, gettimeofday: 169, getpid: 172, getppid: 173,
    getuid: 174, geteuid: 175, getgid: 176, getegid: 177, gettid: 178,
    sysinfo: 179, brk: 214, munmap: 215, mremap: 216, clone: 220,
    execve: 221, mmap: 222, mprotect: 226, madvise: 233, wait4: 260,
    prlimit64: 261, getrandom: 278, execveat: 281, membarrier: 283,
    statx: 291, rseq: 293, clone3: 435, close_range: 436, openat2: 437,
    faccessat2: 439, futex_waitv: 449,
  }),
})

export const TARGETS = Object.freeze({
  x86_64: X86_64,
  aarch64: AARCH64,
})

export function resolveTargetPolicy(architecture) {
  const target = TARGETS[architecture]
  if (!target) throw new TypeError(`unsupported seccomp architecture: ${architecture}`)
  const entries = Object.entries(target.syscalls)
  const numbers = entries.map(([, number]) => number)
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`${architecture} policy contains duplicate syscall numbers`)
  }
  return Object.freeze({
    architecture,
    auditArch: target.auditArch,
    allowedSyscalls: Object.freeze(entries.map(([name]) => name).sort()),
    allowedNumbers: Object.freeze([...numbers].sort((left, right) => left - right)),
  })
}
