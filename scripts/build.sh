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

stamp_version() {
  local sha date pkg_version
  sha=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
  date=$(date -u +%Y-%m-%d)
  pkg_version=$(grep '"version"' package.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  cat > cli/version.ts <<EOF
// Sentinel values used when running from source (\`bun run cli\`).
// scripts/build.sh stamps real build values into this file just before
// each \`bun build --compile\` and restores it afterwards via \`git checkout\`.
export const VERSION = "$pkg_version"
export const BUILD_SHA = "$sha"
export const BUILD_DATE = "$date"
EOF
  # Keep extension/manifest.json#version in lockstep with package.json so the
  # extension reports the same version as the CLI / pkg / Sparkle artifacts.
  # Source manifest is restored via `git checkout` after build (same shape as
  # cli/version.ts). Without this, the manifest is whatever someone hand-bumped
  # last and silently drifts every release that forgets to bump it.
  if [[ -f extension/manifest.json ]]; then
    sed -i.bak -E 's|("version":[[:space:]]*)"[^"]+"|\1"'"$pkg_version"'"|' extension/manifest.json
    rm -f extension/manifest.json.bak
  fi
}

restore_version() {
  git checkout cli/version.ts 2>/dev/null || true
  git checkout extension/manifest.json 2>/dev/null || true
}

trap restore_version EXIT
stamp_version

build_extension() {
  echo "Building extension..."
  rm -rf extension/dist
  mkdir -p extension/dist
  bun build extension/src/background.ts --outdir=extension/dist --target=browser
  bun build extension/src/content.ts --outdir=extension/dist --target=browser
  bun build extension/src/inject-net.ts --outdir=extension/dist --target=browser
  bun build extension/src/inject-canvas.ts --outdir=extension/dist --target=browser
  bun build extension/src/screenshot-runner.ts --outdir=extension/dist --target=browser
  bun build extension/src/offscreen.ts --outfile=extension/dist/offscreen.js --target=browser
  cp extension/manifest.json extension/dist/
  cp extension/offscreen.html extension/dist/
  rm -rf extension/dist/icons
  cp -R extension/icons extension/dist/icons
  chmod 644 extension/dist/* 2>/dev/null || true
  chmod -R u+rwX,go+rX extension/dist/icons 2>/dev/null || true
}

build_host() {
  echo "Building CLI (host)..."
  bun build cli/index.ts --compile --outfile=dist/interceptor
  echo "Building daemon (host)..."
  bun build daemon/index.ts --compile --outfile=daemon/interceptor-daemon
}

build_macos() {
  echo "Building CLI (macOS arm64)..."
  bun build cli/index.ts --compile --target=bun-darwin-arm64 --outfile=dist/interceptor
  echo "Building daemon (macOS arm64)..."
  bun build daemon/index.ts --compile --target=bun-darwin-arm64 --outfile=daemon/interceptor-daemon
}

build_windows() {
  echo "Building CLI (Windows x64)..."
  bun build cli/index.ts --compile --target=bun-windows-x64 --outfile=dist/interceptor.exe
  echo "Building daemon (Windows x64)..."
  bun build daemon/index.ts --compile --target=bun-windows-x64 --outfile=daemon/interceptor-daemon.exe
}

build_bridge() {
  # Swift-only, macOS-only. Warn-and-continue on CI/linux hosts.
  if ! command -v swift >/dev/null 2>&1; then
    echo "Skipping interceptor-bridge (swift toolchain not found)"
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Skipping interceptor-bridge (not on macOS)"
    return 0
  fi
  echo "Building interceptor-bridge (macOS native)..."
  bash scripts/build-bridge.sh
}

build_extension

if [[ "$BUILD_ALL" == "1" ]]; then
  build_host
  build_macos
  build_windows
  build_bridge
elif [[ "$TARGET" == "host" ]]; then
  build_host
  build_bridge
elif [[ "$TARGET" == "macos" ]]; then
  build_macos
  build_bridge
elif [[ "$TARGET" == "windows" ]]; then
  build_windows
else
  echo "Unsupported target: $TARGET" >&2
  exit 1
fi

echo "Build complete."
echo "  Extension: extension/dist/"
if [[ "$BUILD_ALL" == "1" ]]; then
  echo "  Host CLI:   dist/interceptor"
  echo "  Host Daemon: daemon/interceptor-daemon"
  echo "  macOS CLI:  dist/interceptor"
  echo "  macOS Daemon: daemon/interceptor-daemon"
  echo "  macOS Bridge: dist/interceptor-bridge"
  echo "  Windows CLI: dist/interceptor.exe"
  echo "  Windows Daemon: daemon/interceptor-daemon.exe"
elif [[ "$TARGET" == "windows" ]]; then
  echo "  CLI:       dist/interceptor.exe"
  echo "  Daemon:    daemon/interceptor-daemon.exe"
else
  echo "  CLI:       dist/interceptor"
  echo "  Daemon:    daemon/interceptor-daemon"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "  Bridge:    dist/interceptor-bridge"
  fi
fi
