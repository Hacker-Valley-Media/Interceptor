#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BRIDGE_DIR="$PROJECT_DIR/interceptor-bridge"
DIST_DIR="$PROJECT_DIR/dist"
SIGNING_ENV="$PROJECT_DIR/signing.env"

echo "==> Building interceptor-bridge (release)..."
cd "$BRIDGE_DIR"
swift build -c release 2>&1

BINARY="$BRIDGE_DIR/.build/release/interceptor-bridge"
if [ ! -f "$BINARY" ]; then
  echo "ERROR: Build failed — binary not found at $BINARY"
  exit 1
fi

if [ -f "$SIGNING_ENV" ]; then
  source "$SIGNING_ENV"
  if [ -n "${SIGN_IDENTITY:-}" ]; then
    echo "==> Signing with: $SIGN_IDENTITY"
    codesign --force --sign "$SIGN_IDENTITY" --timestamp --options runtime -i "com.hackervalley.interceptor-bridge" "$BINARY"
    echo "==> Verifying signature..."
    codesign --verify --verbose=2 "$BINARY"
  fi
else
  echo "==> No signing.env found — skipping code signing (ad-hoc is fine for local use)"
fi

# Copy to dist
mkdir -p "$DIST_DIR"
cp "$BINARY" "$DIST_DIR/interceptor-bridge"
echo "==> Copied to $DIST_DIR/interceptor-bridge"

ls -la "$DIST_DIR/interceptor-bridge"
echo "==> Build complete."
