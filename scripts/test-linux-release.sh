#!/bin/bash
# Install, inspect, and uninstall both Linux release archives in matching containers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${INTERCEPTOR_VERSION:-$(grep -E '"version"' "$REPO_ROOT/package.json" | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')}"
RELEASE_DIR="$REPO_ROOT/dist/release/linux"

run_inner() {
  local platform="$1" archive="$2"
  local command="set -e; mkdir -p /tmp/check /tmp/home; tar -xzf /release/$archive -C /tmp/check; root=/tmp/check/${archive%.tar.gz}; HOME=/tmp/home bash \"\$root/scripts/install.sh\" --browser-only --chrome --skip-extension; test -L /tmp/home/.config/google-chrome/NativeMessagingHosts/com.interceptor.host.json; \"\$root/dist/interceptor\" --version | grep -F '$VERSION'; \"\$root/dist/interceptor\" status | grep -F 'mode: browser-only'; HOME=/tmp/home bash \"\$root/scripts/uninstall.sh\"; test ! -e /tmp/home/.config/google-chrome/NativeMessagingHosts/com.interceptor.host.json"
  if command -v container >/dev/null 2>&1 && container system status >/dev/null 2>&1; then
    local arch="arm64" rosetta=()
    if [[ "$platform" == "linux/amd64" ]]; then arch="amd64"; rosetta=(--rosetta); fi
    container run --rm --arch "$arch" "${rosetta[@]}" --volume "$RELEASE_DIR:/release:ro" docker.io/library/ubuntu:24.04 bash -lc "$command"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm --platform "$platform" -v "$RELEASE_DIR:/release:ro" ubuntu:24.04 bash -lc "$command"
  else
    echo "ERROR: Apple container or Docker is required for Linux archive checks." >&2
    return 1
  fi
}

(cd "$RELEASE_DIR" && shasum -a 256 -c SHA256SUMS)
run_inner linux/amd64 "Interceptor-Browser-$VERSION-linux-x64.tar.gz"
run_inner linux/arm64 "Interceptor-Browser-$VERSION-linux-arm64.tar.gz"
echo "Both Linux archives passed install, version, mode, and uninstall checks."
