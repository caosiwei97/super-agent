NODE ?= node
MUSL_CC ?= musl-gcc
CFLAGS ?= -Os -pipe -fno-ident -fno-asynchronous-unwind-tables

.PHONY: all check helpers clean

all:
	$(NODE) ./build-profile.mjs

check:
	$(NODE) ./build-profile.mjs --check

# Build static helpers inside the pinned target rootfs toolchain. The release
# attestation records helper and rootfs digests; a macOS build is not a Linux
# release artifact.
helpers:
	mkdir -p build
	SOURCE_DATE_EPOCH=0 $(MUSL_CC) $(CFLAGS) -static -pthread -Wl,--build-id=none -o build/seccomp-probe probe-v1.c
	SOURCE_DATE_EPOCH=0 $(MUSL_CC) $(CFLAGS) -static -Wl,--build-id=none -o build/workspace-inspect workspace-inspect-v1.c
	SOURCE_DATE_EPOCH=0 $(MUSL_CC) $(CFLAGS) -static -Wl,--build-id=none -o build/sandbox-release-probe release-probe-v1.c

clean:
	rm -rf artifacts build
