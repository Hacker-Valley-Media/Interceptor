#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="host"
BUILD_ALL=0
ORIG_MANIFEST_VERSION=""
ORIG_NATIVE_BUILD_CONFIG=""

for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
    --all) BUILD_ALL=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

stamp_version() {
  local sha date pkg_version platform_targets agent_dylibs_bundled
  sha=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
  date=$(date -u +%Y-%m-%d)
  pkg_version=$(grep '"version"' package.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
  if [[ -f shared/native-build-config.ts && -z "$ORIG_NATIVE_BUILD_CONFIG" ]]; then
    ORIG_NATIVE_BUILD_CONFIG="$(cat shared/native-build-config.ts)"
  fi
  cat > cli/version.ts <<EOF
// Sentinel values used when running from source (\`bun run cli\`).
// scripts/build.sh stamps real build values into this file just before
// each \`bun build --compile\` and restores it afterwards via \`git checkout\`.
export const VERSION = "$pkg_version"
export const BUILD_SHA = "$sha"
export const BUILD_DATE = "$date"
EOF
  platform_targets="false"
  if [[ "${INTERCEPTOR_ENABLE_PLATFORM_TARGETS:-0}" == "1" ]]; then
    platform_targets="true"
  fi
  agent_dylibs_bundled="false"
  if [[ "${INTERCEPTOR_INCLUDE_AGENT_DYLIBS:-0}" == "1" ]]; then
    agent_dylibs_bundled="true"
  fi
  cat > shared/native-build-config.ts <<EOF
/**
 * Build-time defaults for the Runtime Agent surface.
 *
 * scripts/build.sh stamps this file for compiled release artifacts and restores
 * it afterward. Source/dev defaults are the public profile: platform target
 * support and bundled agent dylibs are off unless an explicit research build
 * enables them.
 */
export const NATIVE_PLATFORM_TARGETS_ENABLED = $platform_targets
export const NATIVE_AGENT_DYLIBS_BUNDLED = $agent_dylibs_bundled
EOF
  # Keep extension/manifest.json#version in lockstep with package.json so the
  # extension reports the same version as the CLI / pkg / Sparkle artifacts.
  # Source manifest is restored after build. Without this, the manifest is
  # whatever someone hand-bumped last and silently drifts every release that
  # forgets to bump it.
  if [[ -f extension/manifest.json ]]; then
    if [[ -z "$ORIG_MANIFEST_VERSION" ]]; then
      ORIG_MANIFEST_VERSION=$(grep '"version"' extension/manifest.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
    fi
    sed -i.bak -E 's|("version":[[:space:]]*)"[^"]+"|\1"'"$pkg_version"'"|' extension/manifest.json
    rm -f extension/manifest.json.bak
  fi
}

restore_version() {
  git checkout cli/version.ts 2>/dev/null || true
  if [[ -n "$ORIG_NATIVE_BUILD_CONFIG" ]]; then
    printf '%s\n' "$ORIG_NATIVE_BUILD_CONFIG" > shared/native-build-config.ts
  else
    git checkout shared/native-build-config.ts 2>/dev/null || true
  fi
  # Restore only the version field (not the whole file) so other local changes
  # to the manifest (e.g. new keys) are preserved across builds.
  if [[ -f extension/manifest.json ]]; then
    local orig_version="$ORIG_MANIFEST_VERSION"
    if [[ -z "$orig_version" ]]; then
      orig_version=$(git show HEAD:extension/manifest.json 2>/dev/null | grep '"version"' | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
    fi
    if [[ -n "$orig_version" ]]; then
      sed -i.bak -E 's|("version":[[:space:]]*)"[^"]+"|\1"'"$orig_version"'"|' extension/manifest.json
      rm -f extension/manifest.json.bak
    fi
  fi
}

trap restore_version EXIT
stamp_version

build_extension() {
  echo "Building extension..."
  rm -rf extension/dist
  mkdir -p extension/dist
  bun build extension/src/background.ts --outdir=extension/dist --target=browser
  bun build extension/src/net-buffer-content.ts --outdir=extension/dist --target=browser
  bun build extension/src/content.ts --outdir=extension/dist --target=browser
  bun build extension/src/inject-net.ts --outdir=extension/dist --target=browser
  bun build extension/src/inject-canvas.ts --outdir=extension/dist --target=browser
  bun build extension/src/screenshot-runner.ts --outdir=extension/dist --target=browser
  bun build extension/src/offscreen.ts --outfile=extension/dist/offscreen.js --target=browser
  bun build extension/src/popup.ts --outfile=extension/dist/popup.js --target=browser
  cp extension/manifest.json extension/dist/
  cp extension/offscreen.html extension/dist/
  cp extension/popup.html extension/dist/
  rm -rf extension/dist/icons
  cp -R extension/icons extension/dist/icons
  chmod 644 extension/dist/* 2>/dev/null || true
  chmod -R u+rwX,go+rX extension/dist/icons 2>/dev/null || true
}

build_extension_mv2() {
  echo "Building Electron app extension (MV2)..."
  rm -rf extension/dist-mv2
  mkdir -p extension/dist-mv2
  bun build extension/src/background-electron.ts --outfile=extension/dist-mv2/background-electron.js --target=browser
  cp extension/dist/content.js extension/dist-mv2/content.js
  cp extension/dist/net-buffer-content.js extension/dist-mv2/net-buffer-content.js
  cp extension/dist/inject-canvas.js extension/dist-mv2/inject-canvas.js
  cp extension/dist/screenshot-runner.js extension/dist-mv2/screenshot-runner.js
  cp extension/dist/offscreen.html extension/dist-mv2/offscreen.html
  cp extension/dist/popup.html extension/dist-mv2/popup.html
  printf '%s\n' 'globalThis.INTERCEPTOR_APP_CONTEXT_ID = "app:electron";' > extension/dist-mv2/electron-config.js
  rm -rf extension/dist-mv2/icons
  cp -R extension/icons extension/dist-mv2/icons
  bun -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
const manifest = {
  manifest_version: 2,
  name: "Interceptor Electron App Bridge",
  version: base.version,
  description: "Electron app bridge",
  key: base.key,
  icons: base.icons,
  permissions: ["tabs", "storage", "scripting", "webRequest", "webRequestBlocking", "<all_urls>"],
  background: { scripts: ["electron-config.js", "background-electron.js"], persistent: true },
  browser_action: {
    default_title: "Interceptor",
    default_popup: "popup.html",
    default_icon: base.action && base.action.default_icon ? base.action.default_icon : base.icons
  },
  content_scripts: [
    { matches: ["<all_urls>"], js: ["net-buffer-content.js"], run_at: "document_start", all_frames: true },
    { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_idle", all_frames: true }
  ]
};
fs.writeFileSync("extension/dist-mv2/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
'
  chmod 644 extension/dist-mv2/* 2>/dev/null || true
  chmod -R u+rwX,go+rX extension/dist-mv2/icons 2>/dev/null || true
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
  # Modern (default) target. We tried -baseline (which drops the AVX2
  # requirement so the .exe runs on older/virtualized CPUs), but bun's baseline
  # Windows runtime currently fails to extract ("Failed to extract executable
  # for 'bun-windows-x64-baseline-...'") on bun 1.3.x — so the modern target is
  # the only working build today. CAVEAT: the resulting .exe needs an
  # AVX2-capable CPU (≈ any machine from 2013+); on hardware without AVX2 it
  # crashes at launch with "Illegal instruction". Revisit -baseline once bun
  # ships a working baseline Windows artifact.
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
build_extension_mv2

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
echo "  Electron extension: extension/dist-mv2/"
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
