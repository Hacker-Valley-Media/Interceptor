#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Reuse the qualified compiler and native link inputs. This script builds the
# provider only; release-linux.sh still owns archive staging and signing.
ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) TARGET=aarch64-unknown-linux-gnu; DEB_ARCH=arm64; TRIPLET=aarch64-linux-gnu ;;
  x64) TARGET=x86_64-unknown-linux-gnu; DEB_ARCH=amd64; TRIPLET=x86_64-linux-gnu ;;
  *) echo 'Usage: build-desktop-linux.sh [arm64|x64] [cargo build options]' >&2; exit 1 ;;
esac
if [[ $# -gt 0 ]]; then shift; fi
# Keep build-machine paths out of the shipped binaries: the cargo registry, the Rust
# toolchain's library sources and this checkout.
remap_flags() {
  printf -- '--remap-path-prefix=%s=/cargo --remap-path-prefix=%s=/rust/toolchain --remap-path-prefix=%s=/src/interceptor' \
    "${CARGO_HOME:-$HOME/.cargo}" "$(rustc --print sysroot)" "$PWD"
}
if [[ "$(uname -s)" == Linux ]]; then
  export RUSTFLAGS="${RUSTFLAGS:-} $(remap_flags)"
  pkg-config --atleast-version=1.24 gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 || { echo 'Linux provider builds require GStreamer 1.24+ core/app/video development inputs.' >&2; exit 1; }
  if [[ $# -gt 0 ]]; then exec cargo build --locked --release --target "$TARGET" --manifest-path interceptor-desktop/Cargo.toml "$@"; fi
  cargo build --locked --release --target "$TARGET" --manifest-path interceptor-desktop/Cargo.toml --no-default-features
  cargo build --locked --release --target "$TARGET" --manifest-path interceptor-desktop/Cargo.toml --target-dir interceptor-desktop/target/overlay
  cp "interceptor-desktop/target/overlay/$TARGET/release/interceptor-desktop" "interceptor-desktop/target/$TARGET/release/interceptor-overlay"
  exit 0
fi
[[ "$(uname -s)" == Darwin ]] || { echo 'Linux native builds require Linux or the qualified Mac cross compiler.' >&2; exit 1; }
# The pinned cross toolchain and one Debian sysroot per architecture live in .interceptor/toolchain.
TOOLCHAIN="${INTERCEPTOR_TOOLCHAIN:-$PWD/.interceptor/toolchain}"
SYSROOT="$TOOLCHAIN/linux-sysroot/$DEB_ARCH"
ALSA_ROOT="${INTERCEPTOR_LINUX_ALSA_ROOT:-$SYSROOT}"
LINK_ROOT="${INTERCEPTOR_LINUX_LINK_ROOT:-$SYSROOT/usr/lib/$TRIPLET}"
GSTREAMER_ROOT="${INTERCEPTOR_LINUX_GSTREAMER_ROOT:-$SYSROOT}"
[[ -f "$ALSA_ROOT/usr/lib/$TRIPLET/pkgconfig/alsa.pc" && -f "$ALSA_ROOT/usr/lib/$TRIPLET/libasound.so" && -f "$LINK_ROOT/libatspi.so" && -f "$LINK_ROOT/libgio-2.0.so" ]] || { echo 'Matching ALSA, GIO development/runtime and platform link inputs are missing.' >&2; exit 1; }
[[ -f "$GSTREAMER_ROOT/usr/lib/$TRIPLET/pkgconfig/gstreamer-app-1.0.pc" && -f "$GSTREAMER_ROOT/usr/lib/$TRIPLET/pkgconfig/gstreamer-video-1.0.pc" && -f "$GSTREAMER_ROOT/usr/lib/$TRIPLET/libgstreamer-1.0.so" && -f "$GSTREAMER_ROOT/usr/lib/$TRIPLET/pkgconfig/glib-2.0.pc" ]] || { echo 'Matching Linux GStreamer core/app/video and GLib development/runtime inputs are missing. Set INTERCEPTOR_LINUX_GSTREAMER_ROOT to the staged sysroot.' >&2; exit 1; }
# zig comes from INTERCEPTOR_ZIG, then PATH, then the pinned copy in the toolchain folder.
ZIG="${INTERCEPTOR_ZIG:-$(command -v zig || echo "$TOOLCHAIN/mise/installs/zig/0.15.2/zig")}"
[[ -x "$ZIG" ]] || { echo 'zig 0.15.2 not found. Put it on PATH or set INTERCEPTOR_ZIG.' >&2; exit 1; }
command -v "${PKG_CONFIG:-pkg-config}" >/dev/null || { echo 'pkg-config not found. Put it on PATH or set PKG_CONFIG.' >&2; exit 1; }
export PATH="$TOOLCHAIN/cargo/bin:$(dirname "$ZIG"):$HOME/.cargo/bin:$PATH"
export PKG_CONFIG_ALLOW_CROSS=1
export PKG_CONFIG_SYSROOT_DIR="$GSTREAMER_ROOT"
export PKG_CONFIG_LIBDIR="$GSTREAMER_ROOT/usr/lib/$TRIPLET/pkgconfig:$GSTREAMER_ROOT/usr/share/pkgconfig:$ALSA_ROOT/usr/lib/$TRIPLET/pkgconfig"
export RUSTFLAGS="${RUSTFLAGS:-} -L native=$LINK_ROOT -L native=$ALSA_ROOT/usr/lib/$TRIPLET -L native=$GSTREAMER_ROOT/usr/lib/$TRIPLET $(remap_flags)"
if [[ $# -gt 0 ]]; then exec cargo zigbuild --locked --release --target "$TARGET.2.39" --manifest-path interceptor-desktop/Cargo.toml "$@"; fi
cargo zigbuild --locked --release --target "$TARGET.2.39" --manifest-path interceptor-desktop/Cargo.toml --no-default-features
cargo zigbuild --locked --release --target "$TARGET.2.39" --manifest-path interceptor-desktop/Cargo.toml --target-dir interceptor-desktop/target/overlay
cp "interceptor-desktop/target/overlay/$TARGET/release/interceptor-desktop" "interceptor-desktop/target/$TARGET/release/interceptor-overlay"
