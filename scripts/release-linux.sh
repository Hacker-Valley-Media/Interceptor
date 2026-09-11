#!/bin/bash
# Build browser-only Linux archives for the two Bun-supported release targets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${INTERCEPTOR_VERSION:-$(grep -E '"version"' package.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')}"
RELEASE_DIR="$REPO_ROOT/dist/release/linux"
STAGE_ROOT="$RELEASE_DIR/staging"

bash "$REPO_ROOT/scripts/build.sh" --target=linux
rm -rf "$RELEASE_DIR"
mkdir -p "$STAGE_ROOT"

for arch in x64 arm64; do
  name="Interceptor-Browser-$VERSION-linux-$arch"
  stage="$STAGE_ROOT/$name"
  mkdir -p "$stage/dist" "$stage/daemon" "$stage/extension" "$stage/scripts"
  cp "$REPO_ROOT/dist/linux/$arch/interceptor" "$stage/dist/interceptor"
  cp "$REPO_ROOT/dist/linux/$arch/daemon/interceptor-daemon" "$stage/daemon/interceptor-daemon"
  cp "$REPO_ROOT/daemon/com.interceptor.host.json" "$stage/daemon/com.interceptor.host.json"
  cp -R "$REPO_ROOT/extension/dist/." "$stage/extension/dist"
  cp "$REPO_ROOT/scripts/install.sh" "$stage/scripts/install.sh"
  cp "$REPO_ROOT/scripts/uninstall.sh" "$stage/scripts/uninstall.sh"
  cp "$REPO_ROOT/README.md" "$REPO_ROOT/LICENSE" "$REPO_ROOT/package.json" "$stage/"
  printf '%s\n' "$VERSION" > "$stage/VERSION"
  chmod 755 "$stage/dist/interceptor" "$stage/daemon/interceptor-daemon" "$stage/scripts/install.sh" "$stage/scripts/uninstall.sh"
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$RELEASE_DIR/$name.tar.gz" -C "$STAGE_ROOT" "$name"
done

(cd "$RELEASE_DIR" && shasum -a 256 Interceptor-Browser-*.tar.gz > SHA256SUMS)
rm -rf "$STAGE_ROOT"

echo "Linux browser-only archives:"
ls -lh "$RELEASE_DIR"/Interceptor-Browser-*.tar.gz "$RELEASE_DIR/SHA256SUMS"
