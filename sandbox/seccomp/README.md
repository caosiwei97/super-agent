# Seccomp policy v1

This directory contains the source contract for the first production process
lane. It is intentionally limited to the fixed `workspace_inspect` helper,
read-only workspace access and an offline network namespace.

## Reproducible BPF

`policy-v1.mjs` owns the Linux UAPI syscall numbers for `x86_64` and `aarch64`.
`build-profile.mjs` emits classic BPF `struct sock_filter` records in explicit
little-endian encoding, so output does not depend on host headers, libseccomp,
locale, timestamps or object-file metadata.

```sh
node sandbox/seccomp/build-profile.mjs
node sandbox/seccomp/build-profile.mjs --check
```

The generated manifest binds policy version, target architecture, generator,
policy/helper source digests, complete allow set, probe contract and artifact SHA-256. Runtime deployment must set
`SUPER_AGENT_SANDBOX_SECCOMP_PROFILE` to the architecture-matching `.bpf` and
`SUPER_AGENT_SANDBOX_SECCOMP_SHA256` to its manifest digest. Architecture
mismatch kills the process; an unknown syscall returns `EPERM`.

Generated files are labelled `candidate-linux-release-gate-required`. They are
not canonical release artifacts until a clean target-Linux gate regenerates the
same bytes, installs the probe at
`/usr/libexec/super-agent/seccomp-probe`, and passes all release probes.

## Probe contract

`probe-v1.c` must be built inside the pinned rootfs toolchain. Its exact success
output is `super-agent-seccomp-policy-ok`. Success proves all of the following in
one sandbox process:

- `getpid` and stdout `write` are allowed;
- `/proc/self/status` reports `NoNewPrivs: 1` and an empty effective
  capability set;
- the full manifest `mustAllowProbes` matrix succeeds, including mmap, thread
  creation and clocks;
- every `mustDenyProbes` syscall returns `EPERM`, including ptrace, mount,
  namespace, BPF, perf, keyring, module, kexec, swap and cross-process access;
- both INET and UNIX `socket` creation return `EPERM`.

`SandboxExecutor.probe()` runs this enhanced helper through the same
bwrap/seccomp/cgroup path. A digest match without this functional probe is
insufficient proof of the complete policy.

## Release gate

For each supported architecture:

1. Start from a clean, pinned Linux builder and run `make -C sandbox/seccomp`.
2. Run `make -C sandbox/seccomp helpers` with the pinned musl toolchain. Install
   `seccomp-probe`, `workspace-inspect` and `sandbox-release-probe` under
   `/usr/libexec/super-agent/` in the immutable rootfs.
3. Regenerate BPF twice from clean directories and compare both bytes and
   manifest SHA-256.
4. Run the allow and deny probe matrix through the same bwrap/rootfs/cgroup path
   used by `SandboxExecutor`.
5. Record the builder image digest, rootfs digest, helper digest, BPF digest and
   test evidence in the release attestation.

The `sandbox-release-probe` helper is not a user-facing tool. `SandboxExecutor` can map
only the internal `sandbox-release-probe` name and the fixed v1 action set
`readonly`, `output`, `sleep`, `fork`, `fd`, and `cpu`; no executable path,
argument, count, duration or shell text crosses that boundary. The actions
exercise the real read-only mount, output/deadline/cancellation termination,
`pids.max`, launcher `RLIMIT_NOFILE`, and `cpu.max`. All stressors are bounded:
at most 64 child processes, 2,048 descriptors, 1 MiB output, 30 seconds sleep,
and 250 ms process CPU.

Run the non-skippable matrix only in its prepared target-Linux environment:

```sh
ulimit -n 256
pnpm test:linux-release
```

The matrix requires `SUPER_AGENT_BWRAP_PATH`,
`SUPER_AGENT_SANDBOX_ROOTFS`, `SUPER_AGENT_SANDBOX_SECCOMP_PROFILE`,
`SUPER_AGENT_SANDBOX_SECCOMP_SHA256`, `SUPER_AGENT_SANDBOX_CGROUP_ROOT`,
`SUPER_AGENT_SANDBOX_CRASH_SUPERVISOR`, and a dedicated
`SUPER_AGENT_SANDBOX_STAGING_PARENT`. It deliberately fails on
non-Linux hosts and when any variable is missing. The delegated cgroup root
must permit the matrix's stricter 256 MiB memory, zero swap, 8 PID and 10% CPU
limits. The immutable rootfs must contain all three freshly built helpers.

The 2026-07-15 arm64 Linux gate passed with freshly rebuilt helpers, but x86_64
target-kernel and external supervisor attestations are still absent. Keep both
generated artifacts in candidate status; neither a local
`build-profile.mjs --check` nor one architecture's pass certifies the other.
