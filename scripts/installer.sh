#!/bin/bash
set -euo pipefail

# ── Interceptor Installer ──────────────────────────────────────────────────────
# Native macOS dialogs via osascript. Two questions, then magic.
# Packaged inside the DMG alongside the Interceptor binary.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INJECT="$ROOT/scripts/inject.py"
EXT_SRC="$ROOT/extension/dist"
DAEMON_SRC="$ROOT/daemon/interceptor-daemon"
CLI_SRC="$ROOT/dist/interceptor"
BRIDGE_SRC="$ROOT/dist/interceptor-bridge"
PLIST_SRC="$ROOT/launch/com.interceptor.bridge.plist"

# ── Copy binaries to persistent location ──────────────────────────────────────
INSTALL_DIR="$HOME/.interceptor"
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/launch"
cp -f "$DAEMON_SRC" "$INSTALL_DIR/bin/interceptor-daemon"
chmod +x "$INSTALL_DIR/bin/interceptor-daemon"
if [[ -f "$CLI_SRC" ]]; then
  cp -f "$CLI_SRC" "$INSTALL_DIR/bin/interceptor"
  chmod +x "$INSTALL_DIR/bin/interceptor"
fi
DAEMON="$INSTALL_DIR/bin/interceptor-daemon"

# ── PRD-35: install the macOS bridge + LaunchAgent ───────────────────────────
# The bridge powers all 'interceptor macos *' commands (AX tree, CGEvent input,
# screenshots, vision/NLP). Without it, half the product is silently inert.
BRIDGE_INSTALLED=0
if [[ -f "$BRIDGE_SRC" ]]; then
  cp -f "$BRIDGE_SRC" "$INSTALL_DIR/bin/interceptor-bridge"
  chmod +x "$INSTALL_DIR/bin/interceptor-bridge"
  BRIDGE_INSTALLED=1
fi

# LaunchAgent makes the bridge auto-start at login and respawn on crash.
# The plist in-tree points at /usr/local/bin/interceptor-bridge — rewrite it
# to point at the user's install path.
PLIST_DST="$HOME/Library/LaunchAgents/com.interceptor.bridge.plist"
if [[ "$BRIDGE_INSTALLED" == "1" && -f "$PLIST_SRC" ]]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  sed "s|/usr/local/bin/interceptor-bridge|$INSTALL_DIR/bin/interceptor-bridge|g" \
    "$PLIST_SRC" > "$INSTALL_DIR/launch/com.interceptor.bridge.plist"
  cp -f "$INSTALL_DIR/launch/com.interceptor.bridge.plist" "$PLIST_DST"

  # Unload any previous instance (idempotent on re-install), then load.
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl load "$PLIST_DST" 2>/dev/null || true
fi

# ── Sanity checks ─────────────────────────────────────────────────────────────
if [[ ! -f "$INJECT" ]]; then
  osascript -e 'display alert "Interceptor" message "inject.py not found. Broken package." as critical'
  exit 1
fi
if [[ ! -d "$EXT_SRC" ]]; then
  osascript -e 'display alert "Interceptor" message "Extension files not found. Broken package." as critical'
  exit 1
fi

# ── Question 1: Which browser? ────────────────────────────────────────────────
BROWSERS=()
BROWSER_LABELS=()
if [[ -d "/Applications/Brave Browser.app" ]]; then
  BROWSERS+=("brave")
  BROWSER_LABELS+=("Brave Browser")
fi
if [[ -d "/Applications/Google Chrome.app" ]]; then
  BROWSERS+=("chrome")
  BROWSER_LABELS+=("Google Chrome")
fi

if [[ ${#BROWSERS[@]} -eq 0 ]]; then
  osascript -e 'display alert "Interceptor" message "No supported browser found. Install Brave or Chrome first." as critical'
  exit 1
fi

if [[ ${#BROWSERS[@]} -eq 1 ]]; then
  BROWSER="${BROWSERS[0]}"
  BROWSER_LABEL="${BROWSER_LABELS[0]}"
else
  # Build the list string for osascript
  LIST_STR=$(printf '"%s", ' "${BROWSER_LABELS[@]}")
  LIST_STR="{${LIST_STR%, }}"
  CHOSEN=$(osascript -e "choose from list ${LIST_STR} with title \"Interceptor\" with prompt \"Select your browser:\" default items {\"${BROWSER_LABELS[0]}\"}" 2>/dev/null)
  if [[ "$CHOSEN" == "false" || -z "$CHOSEN" ]]; then
    exit 0
  fi
  if [[ "$CHOSEN" == "Brave Browser" ]]; then
    BROWSER="brave"
    BROWSER_LABEL="Brave Browser"
  else
    BROWSER="chrome"
    BROWSER_LABEL="Google Chrome"
  fi
fi

# ── Question 2: Which profile? ────────────────────────────────────────────────
# Get profiles from inject.py
PROFILE_DATA=$(python3 "$INJECT" --browser "$BROWSER" --profile dummy --extension-src "$EXT_SRC" --daemon-path "$DAEMON" --list-profiles 2>/dev/null || true)

if [[ -z "$PROFILE_DATA" ]]; then
  osascript -e "display alert \"Interceptor\" message \"No profiles found for $BROWSER_LABEL.\" as critical"
  exit 1
fi

# Parse profiles into arrays
PROFILE_DIRS=()
PROFILE_NAMES=()
while IFS=$'\t' read -r dir name; do
  PROFILE_DIRS+=("$dir")
  PROFILE_NAMES+=("$name")
done <<< "$PROFILE_DATA"

if [[ ${#PROFILE_DIRS[@]} -eq 0 ]]; then
  osascript -e "display alert \"Interceptor\" message \"No profiles found for $BROWSER_LABEL.\" as critical"
  exit 1
fi

if [[ ${#PROFILE_DIRS[@]} -eq 1 ]]; then
  PROFILE_DIR="${PROFILE_DIRS[0]}"
  PROFILE_NAME="${PROFILE_NAMES[0]}"
else
  # Show profile picker with display names
  DISPLAY_LIST=$(printf '"%s", ' "${PROFILE_NAMES[@]}")
  DISPLAY_LIST="{${DISPLAY_LIST%, }}"
  CHOSEN_PROFILE=$(osascript -e "choose from list ${DISPLAY_LIST} with title \"Interceptor\" with prompt \"Select profile for $BROWSER_LABEL:\" default items {\"${PROFILE_NAMES[0]}\"}" 2>/dev/null)
  if [[ "$CHOSEN_PROFILE" == "false" || -z "$CHOSEN_PROFILE" ]]; then
    exit 0
  fi
  # Map display name back to directory
  PROFILE_DIR=""
  PROFILE_NAME="$CHOSEN_PROFILE"
  for i in "${!PROFILE_NAMES[@]}"; do
    if [[ "${PROFILE_NAMES[$i]}" == "$CHOSEN_PROFILE" ]]; then
      PROFILE_DIR="${PROFILE_DIRS[$i]}"
      break
    fi
  done
  if [[ -z "$PROFILE_DIR" ]]; then
    osascript -e 'display alert "Interceptor" message "Profile not found." as critical'
    exit 1
  fi
fi

# ── Confirm and close browser ─────────────────────────────────────────────────
case "$BROWSER" in
  brave)  BROWSER_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" ;;
  chrome) BROWSER_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
esac

# Always show confirmation before proceeding
if pgrep -f "$BROWSER_BIN" >/dev/null 2>&1; then
  CONFIRM_MSG="$BROWSER_LABEL is currently open and needs to close for installation. Save any work, then click Install to continue."
else
  CONFIRM_MSG="Ready to install Interceptor into $BROWSER_LABEL ($PROFILE_NAME profile). $BROWSER_LABEL will open automatically when done."
fi

ANSWER=$(osascript -e "display dialog \"$CONFIRM_MSG\" buttons {\"Cancel\", \"Install\"} default button \"Install\" with title \"Interceptor\" with icon caution" 2>/dev/null | sed 's/button returned://')
if [[ "$ANSWER" != "Install" ]]; then
  exit 0
fi

# Quit browser if running
if pgrep -f "$BROWSER_BIN" >/dev/null 2>&1; then
  osascript -e "tell application \"$BROWSER_LABEL\" to quit" 2>/dev/null || true
  for i in {1..15}; do
    if ! pgrep -f "$BROWSER_BIN" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if pgrep -f "$BROWSER_BIN" >/dev/null 2>&1; then
    osascript -e "display alert \"Interceptor\" message \"Could not quit $BROWSER_LABEL. Please close it manually and try again.\" as critical"
    exit 1
  fi
fi

# ── Install with progress ─────────────────────────────────────────────────────
# Show a notification that install is in progress
osascript -e 'display notification "Installing Interceptor extension..." with title "Interceptor"' 2>/dev/null || true

# Run injection
RESULT=$(python3 "$INJECT" \
  --browser "$BROWSER" \
  --profile "$PROFILE_DIR" \
  --extension-src "$EXT_SRC" \
  --daemon-path "$DAEMON" 2>&1)

if [[ "$RESULT" != "ok" ]]; then
  osascript -e "display alert \"Interceptor\" message \"Installation failed: $RESULT\" as critical"
  exit 1
fi

# ── Launch browser ────────────────────────────────────────────────────────────
case "$BROWSER" in
  brave)  open -a "Brave Browser" ;;
  chrome) open -a "Google Chrome" ;;
esac

osascript -e 'display notification "Interceptor installed successfully! Your browser is starting." with title "Interceptor" sound name "Glass"' 2>/dev/null || true

# ── PRD-35: first-run macOS permission walkthrough ────────────────────────────
# The bridge needs three Privacy toggles to do its job. Point the user there
# explicitly — otherwise they see "error: interceptor-bridge not running" the
# first time they run an `interceptor macos *` command.
if [[ "$BRIDGE_INSTALLED" == "1" ]]; then
  WALK_MSG="Interceptor can now control your Mac, not just the browser.

To enable that, grant these three permissions to interceptor-bridge in System Settings → Privacy & Security:

• Accessibility — AX tree + OS-level clicks & keys
• Input Monitoring — trusted keyboard/mouse input
• Screen Recording — screenshots, OCR, Vision APIs

Click Open to jump to Privacy & Security now."

  CHOICE=$(osascript -e "display dialog \"$WALK_MSG\" buttons {\"Later\", \"Open\"} default button \"Open\" with title \"Interceptor — macOS Permissions\"" 2>/dev/null | sed 's/button returned://')
  if [[ "$CHOICE" == "Open" ]]; then
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
  fi
fi

exit 0
