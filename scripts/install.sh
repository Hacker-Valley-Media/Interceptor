#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_PATH="$ROOT/daemon/slop-daemon"
TEMPLATE_PATH="$ROOT/daemon/com.slopbrowser.host.json"
GENERATED_DIR="$ROOT/daemon/.generated"
GENERATED_MANIFEST="$GENERATED_DIR/com.slopbrowser.host.json"

mkdir -p "$GENERATED_DIR"
python3 - <<'PY' "$TEMPLATE_PATH" "$GENERATED_MANIFEST" "$DAEMON_PATH"
from pathlib import Path
import sys
src = Path(sys.argv[1]).read_text()
out = src.replace('__DAEMON_PATH__', sys.argv[3])
Path(sys.argv[2]).write_text(out)
PY

for dir in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
do
  mkdir -p "$dir"
  ln -sfn "$GENERATED_MANIFEST" "$dir/com.slopbrowser.host.json"
done

echo "Installed manifest symlinks:"
echo "  Chrome: $HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.slopbrowser.host.json"
echo "  Brave:  $HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.slopbrowser.host.json"
