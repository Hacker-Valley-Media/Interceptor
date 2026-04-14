#!/bin/bash
set -euo pipefail

# install-bridge.sh — Download or locate interceptor-bridge, then install it
#
# Usage:
#   bash scripts/install-bridge.sh            # Download pre-built binary from GitHub Releases
#   bash scripts/install-bridge.sh --local    # Use locally built binary from dist/
#
# The script:
#   1. Downloads (or locates) the interceptor-bridge binary
#   2. Verifies the code signature and team ID
#   3. Installs to /usr/local/bin/interceptor-bridge
#   4. Sets up the LaunchAgent for auto-start
#   5. Prints next steps (permissions)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BRIDGE_DIR="$PROJECT_DIR/interceptor-bridge"
DIST_DIR="$PROJECT_DIR/dist"
REPO="Hacker-Valley-Media/Interceptor"
ASSET_NAME="interceptor-bridge-macos"
EXPECTED_TEAM="TPWBZD35WW"
EXPECTED_AUTHORITY="Developer ID Application: HACKER VALLEY MEDIA"

PLIST_NAME="com.interceptor.bridge"
PLIST_SRC="$BRIDGE_DIR/$PLIST_NAME.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
BINARY_DST="/usr/local/bin/interceptor-bridge"

MODE="download"
if [ "${1:-}" = "--local" ]; then
  MODE="local"
fi

# ── Platform check ───────────────────────────────────────────────────────────

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  echo "ERROR: interceptor-bridge is macOS only."
  echo "  Detected platform: $OS"
  echo "  The native bridge requires macOS frameworks (Accessibility, ScreenCaptureKit, etc.)"
  exit 1
fi

# ── Acquire binary ───────────────────────────────────────────────────────────

mkdir -p "$DIST_DIR"
BINARY_SRC="$DIST_DIR/interceptor-bridge"

if [ "$MODE" = "download" ]; then
  echo "==> Fetching latest release from GitHub..."

  # Try gh CLI first, fall back to curl
  if command -v gh &>/dev/null; then
    TAG=$(gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>/dev/null || true)
    if [ -z "$TAG" ]; then
      echo "    No releases found. Falling back to build-from-source."
      echo ""
      echo "    To build from source (requires Xcode):"
      echo "      bash scripts/build-bridge.sh"
      echo "      bash scripts/install-bridge.sh --local"
      exit 1
    fi

    echo "    Latest release: $TAG"

    DOWNLOAD_URL=$(gh api "repos/$REPO/releases/latest" \
      --jq ".assets[] | select(.name == \"$ASSET_NAME\") | .url" 2>/dev/null || true)

    if [ -z "$DOWNLOAD_URL" ]; then
      echo "    ERROR: Asset '$ASSET_NAME' not found in release $TAG"
      echo "    Available assets:"
      gh api "repos/$REPO/releases/latest" --jq '.assets[].name' 2>/dev/null || true
      echo ""
      echo "    To build from source: bash scripts/build-bridge.sh"
      exit 1
    fi

    echo "    Downloading $ASSET_NAME..."
    gh api "$DOWNLOAD_URL" > "$BINARY_SRC" 2>/dev/null
  else
    # Fallback: use curl with GitHub API
    TAG=$(curl -sf "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*: "//;s/".*//' || true)
    if [ -z "$TAG" ]; then
      echo "    No releases found or no network. Falling back to build-from-source."
      echo ""
      echo "    To build from source (requires Xcode):"
      echo "      bash scripts/build-bridge.sh"
      echo "      bash scripts/install-bridge.sh --local"
      exit 1
    fi

    echo "    Latest release: $TAG"

    DOWNLOAD_URL=$(curl -sf "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -A 4 "\"name\": \"$ASSET_NAME\"" \
      | grep "browser_download_url" \
      | head -1 \
      | sed 's/.*: "//;s/".*//' || true)

    if [ -z "$DOWNLOAD_URL" ]; then
      echo "    ERROR: Asset '$ASSET_NAME' not found in release $TAG"
      echo "    To build from source: bash scripts/build-bridge.sh"
      exit 1
    fi

    echo "    Downloading $ASSET_NAME..."
    curl -fSL "$DOWNLOAD_URL" -o "$BINARY_SRC"
  fi

  chmod +x "$BINARY_SRC"
  echo "    Downloaded to $BINARY_SRC ($(ls -lh "$BINARY_SRC" | awk '{print $5}'))"

elif [ "$MODE" = "local" ]; then
  if [ ! -f "$BINARY_SRC" ]; then
    echo "ERROR: Binary not found at $BINARY_SRC"
    echo "Run scripts/build-bridge.sh first."
    exit 1
  fi
  echo "==> Using local binary: $BINARY_SRC"
fi

# ── Verify code signature ───────────────────────────────────────────────────

echo "==> Verifying code signature..."

if ! codesign --verify --verbose=2 "$BINARY_SRC" 2>/dev/null; then
  echo "    WARNING: Binary is not signed or signature is invalid."
  echo "    This is expected for local debug builds."
  echo "    For production use, download the signed binary or run scripts/build-bridge.sh with signing.env."
  echo ""
  read -p "    Continue with unsigned binary? [y/N] " CONFIRM
  if [ "${CONFIRM:-n}" != "y" ] && [ "${CONFIRM:-n}" != "Y" ]; then
    echo "    Aborted."
    exit 1
  fi
else
  # Check team identity
  AUTHORITY=$(codesign -d --verbose=2 "$BINARY_SRC" 2>&1 | grep "Authority=Developer ID Application" || true)
  if [ -n "$AUTHORITY" ]; then
    if echo "$AUTHORITY" | grep -q "$EXPECTED_TEAM"; then
      echo "    Signature valid: $AUTHORITY"
    else
      echo "    WARNING: Binary is signed but NOT by Hacker Valley Media (team $EXPECTED_TEAM)"
      echo "    Authority: $AUTHORITY"
      echo "    This binary may have been tampered with."
      exit 1
    fi
  else
    echo "    Signature valid (ad-hoc or local signing)"
  fi
fi

# ── Install binary ──────────────────────────────────────────────────────────

# Unload existing agent if present
if launchctl list | grep -q "$PLIST_NAME" 2>/dev/null; then
  echo "==> Unloading existing LaunchAgent..."
  launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
fi

# Kill any running bridge
if [ -f /tmp/interceptor-bridge.pid ]; then
  PID=$(head -1 /tmp/interceptor-bridge.pid)
  kill "$PID" 2>/dev/null || true
  sleep 1
fi

# Copy binary
echo "==> Installing binary to $BINARY_DST..."
cp "$BINARY_SRC" "$BINARY_DST"
chmod +x "$BINARY_DST"

# Copy plist (if available)
if [ -f "$PLIST_SRC" ]; then
  echo "==> Installing LaunchAgent plist..."
  mkdir -p "$HOME/Library/LaunchAgents"
  cp "$PLIST_SRC" "$PLIST_DST"

  echo "==> Loading LaunchAgent..."
  launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
else
  echo "==> No LaunchAgent plist found at $PLIST_SRC — skipping auto-start setup."
  echo "    The daemon will auto-spawn the bridge on first interceptor macos command."
fi

# ── Success ─────────────────────────────────────────────────────────────────

echo ""
echo "==> interceptor-bridge installed successfully!"
echo ""
echo "    Binary:  $BINARY_DST"
echo "    Version: $TAG" 2>/dev/null || true
echo ""
echo "    Next steps:"
echo "    1. Grant permissions:  interceptor macos trust"
echo "    2. Required:           System Settings → Privacy & Security → Accessibility → interceptor-bridge"
echo "    3. Optional:           Screen Recording, Microphone (for capture/speech features)"
echo ""
echo "    Test it:  interceptor macos tree"
