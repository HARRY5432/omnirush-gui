#!/usr/bin/env bash
# The static bubblewrap OmniRush ships in its Linux packages (box/bwrap/linux-<arch>/bwrap), for
# systems without a usable bwrap of their own.
#
#   box/bwrap/build.sh            build both arches and check them against box/bwrap/SHA256SUMS
#   box/bwrap/build.sh --update   build both and write SHA256SUMS (after a version bump)
#
# Reproducible: every input is pinned by sha256 (the bubblewrap and libcap release tarballs, the
# Zig toolchain that cross-compiles both arches from one x86_64 host, the Alpine image the build
# runs in for libcap's make), the paths are fixed, timestamps and build ids are left out. Two builds
# give the same bytes; the release ships the committed binaries and the release guard
# (scripts/check-bwrap.mjs) checks them against SHA256SUMS.
#
# bubblewrap is LGPL-2.0-or-later and libcap (linked statically) is BSD-3-Clause or GPL-2.0:
# both are built unmodified from the tarballs below, which are their complete corresponding
# source; their licence texts (and musl's, the C library) go next to the binaries (COPYING.*) and
# into the platform packages, with the source pointers in THIRD_PARTY_NOTICES.md.
set -euo pipefail
BWRAP_VERSION=0.11.0
BWRAP_SHA256=988fd6b232dafa04b8b8198723efeaccdb3c6aa9c1c7936219d5791a8b7a8646
LIBCAP_VERSION=2.76
LIBCAP_SHA256=629da4ab29900d0f7fcc36227073743119925fd711c99a1689bbf5c9b40c8e6f
ZIG_VERSION=0.13.0
ZIG_SHA256=d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea
ALPINE=alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
HERE=$(cd "$(dirname "$0")" && pwd)
MODE=${1:-check}

docker run --rm --name sux-bwrap-build --platform linux/amd64 -v "$HERE:/out" -e SOURCE_DATE_EPOCH=0 "$ALPINE" sh -euc "
  apk add -q --no-cache make perl curl xz gcc musl-dev file >/dev/null
  mkdir -p /build && cd /build
  fetch() { curl -fsSLo \"\$1\" \"\$2\" && echo \"\$3  \$1\" | sha256sum -c - >/dev/null || { echo \"sha256 mismatch: \$2\" >&2; exit 1; }; }
  fetch zig.tar.xz https://ziglang.org/download/$ZIG_VERSION/zig-linux-x86_64-$ZIG_VERSION.tar.xz $ZIG_SHA256
  fetch bwrap.tar.xz https://github.com/containers/bubblewrap/releases/download/v$BWRAP_VERSION/bubblewrap-$BWRAP_VERSION.tar.xz $BWRAP_SHA256
  fetch libcap.tar.xz https://mirrors.edge.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-$LIBCAP_VERSION.tar.xz $LIBCAP_SHA256
  tar -xJf zig.tar.xz && mv zig-linux-x86_64-$ZIG_VERSION zig
  export ZIG_GLOBAL_CACHE_DIR=/build/zig-cache ZIG_LOCAL_CACHE_DIR=/build/zig-cache
  for arch in amd64 arm64; do
    case \$arch in amd64) target=x86_64-linux-musl; cpu=x86_64;; arm64) target=aarch64-linux-musl; cpu=aarch64;; esac
    flags=\"-target \$target -O2 -ffile-prefix-map=/build=. -fno-ident\"
    printf '#!/bin/sh\nexec /build/zig/zig cc %s \"\$@\"\n' \"\$flags\" > /build/cc-\$arch && chmod +x /build/cc-\$arch
    printf '#!/bin/sh\nexec /build/zig/zig ar \"\$@\"\n' > /build/ar && chmod +x /build/ar
    # libcap: the static library only (its own _makenames runs on the build host).
    rm -rf libcap-\$arch && mkdir libcap-\$arch && tar -xJf libcap.tar.xz -C libcap-\$arch --strip-components=1
    make -s -C libcap-\$arch/libcap CC=/build/cc-\$arch BUILD_CC=gcc AR=/build/ar RANLIB=true SHARED=no PTHREADS=no libcap.a >/dev/null
    # bubblewrap: its four C files (what its meson.build compiles), SELinux off, linked statically with musl and libcap.
    rm -rf bwrap-\$arch && mkdir bwrap-\$arch && tar -xJf bwrap.tar.xz -C bwrap-\$arch --strip-components=1
    cd bwrap-\$arch
    printf '#define PACKAGE_STRING \"bubblewrap $BWRAP_VERSION\"\n' > config.h
    /build/cc-\$arch -D_GNU_SOURCE -I. -I/build/libcap-\$arch/libcap/include -static -s -Wl,--build-id=none \
      bubblewrap.c bind-mount.c network.c utils.c /build/libcap-\$arch/libcap/libcap.a -o bwrap
    file bwrap | grep -q 'statically linked' || { echo \"bwrap (\$arch) is not static\" >&2; exit 1; }
    mkdir -p /out/linux-\$arch && install -m 0755 bwrap /out/linux-\$arch/bwrap
    cd /build
  done
  cp bwrap-amd64/COPYING /out/COPYING.bubblewrap && cp libcap-amd64/License /out/COPYING.libcap && cp zig/lib/libc/musl/COPYRIGHT /out/COPYING.musl
  chown -R $(id -u):$(id -g) /out/linux-amd64 /out/linux-arm64 /out/COPYING.bubblewrap /out/COPYING.libcap /out/COPYING.musl
"
cd "$HERE"
"./linux-amd64/bwrap" --version
sums=$(sha256sum linux-amd64/bwrap linux-arm64/bwrap COPYING.bubblewrap COPYING.libcap COPYING.musl)
if [ "$MODE" = "--update" ]; then
  printf '%s\n' "$sums" > SHA256SUMS
  echo "wrote SHA256SUMS"
else
  sha256sum -c SHA256SUMS
fi
