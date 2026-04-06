#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="host"
BUILD_ALL=0

for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
    --all) BUILD_ALL=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

build_extension() {
  echo "Building extension..."
  bun build extension/src/background.ts --outdir=extension/dist --target=browser
  bun build extension/src/content.ts --outdir=extension/dist --target=browser
  bun build extension/src/inject-net.ts --outdir=extension/dist --target=browser
  cp extension/manifest.json extension/dist/
  cp extension/offscreen.html extension/dist/
  cp extension/offscreen.js extension/dist/
}

build_host() {
  echo "Building CLI (host)..."
  bun build cli/index.ts --compile --outfile=dist/slop
  echo "Building daemon (host)..."
  bun build daemon/index.ts --compile --outfile=daemon/slop-daemon
}

build_macos() {
  echo "Building CLI (macOS arm64)..."
  bun build cli/index.ts --compile --target=bun-darwin-arm64 --outfile=dist/slop
  echo "Building daemon (macOS arm64)..."
  bun build daemon/index.ts --compile --target=bun-darwin-arm64 --outfile=daemon/slop-daemon
}

build_windows() {
  echo "Building CLI (Windows x64)..."
  bun build cli/index.ts --compile --target=bun-windows-x64 --outfile=dist/slop.exe
  echo "Building daemon (Windows x64)..."
  bun build daemon/index.ts --compile --target=bun-windows-x64 --outfile=daemon/slop-daemon.exe
}

build_extension

if [[ "$BUILD_ALL" == "1" ]]; then
  build_host
  build_macos
  build_windows
elif [[ "$TARGET" == "host" ]]; then
  build_host
elif [[ "$TARGET" == "macos" ]]; then
  build_macos
elif [[ "$TARGET" == "windows" ]]; then
  build_windows
else
  echo "Unsupported target: $TARGET" >&2
  exit 1
fi

echo "Build complete."
echo "  Extension: extension/dist/"
if [[ "$BUILD_ALL" == "1" ]]; then
  echo "  Host CLI:   dist/slop"
  echo "  Host Daemon: daemon/slop-daemon"
  echo "  macOS CLI:  dist/slop"
  echo "  macOS Daemon: daemon/slop-daemon"
  echo "  Windows CLI: dist/slop.exe"
  echo "  Windows Daemon: daemon/slop-daemon.exe"
elif [[ "$TARGET" == "windows" ]]; then
  echo "  CLI:       dist/slop.exe"
  echo "  Daemon:    daemon/slop-daemon.exe"
else
  echo "  CLI:       dist/slop"
  echo "  Daemon:    daemon/slop-daemon"
fi
