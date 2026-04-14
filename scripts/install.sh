#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_PATH="$ROOT/daemon/interceptor-daemon"
TEMPLATE_PATH="$ROOT/daemon/com.interceptor.host.json"
GENERATED_DIR="$ROOT/daemon/.generated"
GENERATED_MANIFEST="$GENERATED_DIR/com.interceptor.host.json"
EXTENSION_DIR="$ROOT/extension/dist"

# ── Parse flags ────────────────────────────────────────────────────────────────
SKIP_EXTENSION=0
BROWSER=""
PROFILE=""
LIST_PROFILES=0
i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  case "$arg" in
    --skip-extension) SKIP_EXTENSION=1 ;;
    --brave)  BROWSER="brave" ;;
    --chrome) BROWSER="chrome" ;;
    --profile)
      i=$((i + 1))
      PROFILE="${!i}"
      ;;
    --profile=*) PROFILE="${arg#--profile=}" ;;
    --profiles) LIST_PROFILES=1 ;;
    *) echo "Unknown flag: $arg" >&2
       echo ""
       echo "Usage: bash scripts/install.sh [--brave|--chrome] [--profile <name>] [--profiles] [--skip-extension]"
       echo ""
       echo "  --brave          Target Brave Browser"
       echo "  --chrome         Target Google Chrome"
       echo "  --profile <name> Profile directory name (e.g. \"Default\", \"Profile 2\")"
       echo "  --profiles       List available profiles and exit"
       echo "  --skip-extension Only install native messaging (skip extension loading)"
       exit 1 ;;
  esac
  i=$((i + 1))
done

# ── List profiles ──────────────────────────────────────────────────────────────
if [[ "$LIST_PROFILES" == "1" ]]; then
  if [[ -z "$BROWSER" ]]; then
    if [[ -d "/Applications/Brave Browser.app" ]]; then BROWSER="brave"
    elif [[ -d "/Applications/Google Chrome.app" ]]; then BROWSER="chrome"
    fi
  fi
  case "$BROWSER" in
    brave)  PROFILE_ROOT="$HOME/Library/Application Support/BraveSoftware/Brave-Browser" ;;
    chrome) PROFILE_ROOT="$HOME/Library/Application Support/Google/Chrome" ;;
    *) echo "No supported browser found."; exit 1 ;;
  esac

  echo "Available profiles:"
  echo ""
  printf "  %-20s %s\n" "DIRECTORY" "DISPLAY NAME"
  printf "  %-20s %s\n" "---------" "------------"
  for dir in "$PROFILE_ROOT"/*/; do
    name=$(basename "$dir")
    if [[ -f "$dir/Preferences" ]]; then
      display=$(python3 -c "import json; p=json.load(open('$dir/Preferences')); print(p.get('profile',{}).get('name','(unnamed)'))" 2>/dev/null || echo "(unknown)")
      printf "  %-20s %s\n" "$name" "$display"
    fi
  done
  echo ""
  echo "Usage: bash scripts/install.sh --brave --profile \"Profile 2\""
  exit 0
fi

# ── Step 1: Generate native messaging manifest ────────────────────────────────
mkdir -p "$GENERATED_DIR"
python3 - <<'PY' "$TEMPLATE_PATH" "$GENERATED_MANIFEST" "$DAEMON_PATH"
from pathlib import Path
import sys
src = Path(sys.argv[1]).read_text()
out = src.replace('__DAEMON_PATH__', sys.argv[3])
Path(sys.argv[2]).write_text(out)
PY

# ── Step 2: Install native messaging symlinks ─────────────────────────────────
for dir in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
do
  mkdir -p "$dir"
  ln -sfn "$GENERATED_MANIFEST" "$dir/com.interceptor.host.json"
done

echo "==> Native messaging manifests installed:"
echo "    Chrome: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.interceptor.host.json"
echo "    Brave:  ~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.interceptor.host.json"

# ── Step 3: Load extension into browser via --load-extension ──────────────────
if [[ "$SKIP_EXTENSION" == "1" ]]; then
  echo ""
  echo "==> Skipping extension loading (--skip-extension)"
  exit 0
fi

if [[ ! -d "$EXTENSION_DIR" ]]; then
  echo ""
  echo "==> Extension not built yet. Run: bash scripts/build.sh"
  echo "    Then re-run this script."
  exit 1
fi

# Auto-detect browser if not specified
if [[ -z "$BROWSER" ]]; then
  if [[ -d "/Applications/Brave Browser.app" ]]; then
    BROWSER="brave"
  elif [[ -d "/Applications/Google Chrome.app" ]]; then
    BROWSER="chrome"
  else
    echo ""
    echo "==> No supported browser found. Install Brave or Chrome first."
    exit 1
  fi
fi

case "$BROWSER" in
  brave)
    BROWSER_APP="/Applications/Brave Browser.app"
    BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Brave Browser"
    BROWSER_NAME="Brave"
    ;;
  chrome)
    BROWSER_APP="/Applications/Google Chrome.app"
    BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Google Chrome"
    BROWSER_NAME="Chrome"
    ;;
esac

# Check if browser is already running
BROWSER_RUNNING=0
if pgrep -f "$BROWSER_BIN" >/dev/null 2>&1; then
  BROWSER_RUNNING=1
fi

if [[ "$BROWSER_RUNNING" == "1" ]]; then
  echo ""
  echo "==> $BROWSER_NAME is already running."
  echo "    To load the extension without browser intervention, $BROWSER_NAME must be restarted."
  echo ""
  echo "    Option 1 — Restart $BROWSER_NAME now (tabs will be restored):"
  PROFILE_HINT=""
  if [[ -n "$PROFILE" ]]; then PROFILE_HINT=" --profile \"$PROFILE\""; fi
  echo "      bash scripts/install.sh --${BROWSER}${PROFILE_HINT} # after quitting $BROWSER_NAME"
  echo ""
  echo "    Option 2 — Load manually:"
  echo "      1. Open chrome://extensions"
  echo "      2. Enable Developer Mode"
  echo "      3. Load unpacked → $EXTENSION_DIR"
  echo ""
  echo "    Option 3 — Force restart (will restore tabs on relaunch):"
  read -p "      Quit $BROWSER_NAME and relaunch with extension? [y/N] " CONFIRM
  if [[ "${CONFIRM:-n}" == "y" || "${CONFIRM:-n}" == "Y" ]]; then
    echo "    Quitting $BROWSER_NAME..."
    osascript -e "tell application \"$BROWSER_NAME Browser\" to quit" 2>/dev/null || \
    osascript -e "tell application \"$BROWSER_NAME\" to quit" 2>/dev/null || true
    sleep 2
    for i in {1..10}; do
      if ! pgrep -f "$BROWSER_BIN" >/dev/null 2>&1; then break; fi
      sleep 1
    done
  else
    echo "    Skipping extension loading."
    exit 0
  fi
fi

echo ""
echo "==> Launching $BROWSER_NAME with --load-extension..."
echo "    Extension: $EXTENSION_DIR"

# Build launch args
LAUNCH_ARGS=(--load-extension="$EXTENSION_DIR")
if [[ -n "$PROFILE" ]]; then
  LAUNCH_ARGS+=(--profile-directory="$PROFILE")
  echo "    Profile:   $PROFILE"
fi

# Launch browser with --load-extension flag (and optional --profile-directory)
# This works on Brave/Chromium (NOT blocked like in Google Chrome branded builds)
# See: chromium/chrome/browser/extensions/extension_service.cc:416-436
open -a "$BROWSER_APP" --args "${LAUNCH_ARGS[@]}"

echo ""
echo "==> Done! Interceptor extension loaded into $BROWSER_NAME."
echo "    Extension ID: hkjbaciefhhgekldhncknbjkofbpenng"
if [[ -n "$PROFILE" ]]; then
  echo "    Profile: $PROFILE"
fi
echo ""
echo "    The extension connects to the daemon automatically."
echo "    Test it: interceptor status"
