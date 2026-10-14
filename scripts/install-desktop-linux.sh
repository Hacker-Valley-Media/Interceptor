#!/bin/bash
set -euo pipefail

# Linux uses the existing shell installer and authenticated GUI identity.
# Reuse an owned generated autostart service when the desktop provides it.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-install}"
REMOVE_ALL=0
if [[ "$MODE" == --uninstall-all ]]; then MODE=--uninstall; REMOVE_ALL=1; fi
case "$MODE" in install|--check|--refresh-browser|--dry-run|--uninstall) ;; *) echo "Unknown desktop installer option: $MODE" >&2; exit 1 ;; esac
[[ "$(uname -s)" == Linux ]] || { echo "Linux desktop installer requires Linux." >&2; exit 1; }
DEST="$HOME/.local/share/interceptor"
BINARY="$DEST/interceptor-desktop"
STATE="$DEST/desktop-install.sha256"
# Overlays run in a sibling helper that links WebKitGTK and gtk-layer-shell; the provider does not.
OVERLAY="$DEST/interceptor-overlay"
OVERLAY_STATE="$DEST/overlay-install.sha256"
OVERLAY_SOURCE=''
CLI="$DEST/interceptor"
DAEMON="$DEST/interceptor-daemon"
BROWSER_STATE="$DEST/browser-install.sha256"
# Agent skills sit beside the CLI, where `interceptor skills` looks for its pack.
SKILLS="$DEST/skills"
POINTER="$DEST/hyprland"
POINTER_STATE="$DEST/pointer-install.sha256"
ENGINES="$DEST/engines"
ENGINES_STATE="$DEST/engine-install.sha256"
ENGINES_SOURCE=''
POINTER_PAYLOAD=''
POINTER_SOURCE_PAYLOAD=''
CLI_LINK="$HOME/.local/bin/interceptor"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/com.interceptor.desktop.desktop"
LOCATION_IDENTITY="${XDG_DATA_HOME:-$HOME/.local/share}/applications/com.interceptor.desktop.desktop"
LOCATION_STATE="$DEST/location-identity.sha256"
# Each library the payload cannot load, with the package that provides it (Arch, then Debian/Ubuntu).
missing_libraries() {
  local lib package
  ldd "$1" 2>/dev/null | awk '/not found/{print $1}' | sort -u | while read -r lib; do
    case "$lib" in
      libatspi*) package='at-spi2-core (Debian: libatspi2.0-0)' ;;
      libasound*) package='alsa-lib (Debian: libasound2)' ;;
      libsystemd*) package='systemd-libs (Debian: libsystemd0)' ;;
      libgio*|libglib*|libgobject*) package='glib2 (Debian: libglib2.0-0)' ;;
      libwebkit2gtk-4.1*|libjavascriptcoregtk-4.1*) package='webkit2gtk-4.1 (Debian: libwebkit2gtk-4.1-0)' ;;
      libgtk-layer-shell*) package='gtk-layer-shell (Debian: libgtk-layer-shell0)' ;;
      libsoup-3*) package='libsoup3 (Debian: libsoup-3.0-0)' ;;
      libgtk-3*|libgdk-3*) package='gtk3 (Debian: libgtk-3-0)' ;;
      *) package='package unknown; search your distribution for this file' ;;
    esac
    printf '  %s  (%s)\n' "$lib" "$package"
  done
}
if [[ "$MODE" == --dry-run ]]; then
  echo "    DRY: install owned native provider at $BINARY"
  echo "    DRY: install owned overlay helper at $OVERLAY when WebKitGTK and gtk-layer-shell are present"
  echo "    DRY: install agent skills at $SKILLS"
  echo "    DRY: write owned login-session startup entry at $AUTOSTART"
  echo "    DRY: install owned GeoClue desktop identity at $LOCATION_IDENTITY; native permission remains user-controlled"
  echo "    DRY: verify libatspi, libsystemd, libasound, libgio, native version and rollback ownership"
  exit 0
fi
if [[ "$MODE" == --uninstall && ! -e "$STATE" && ! -L "$STATE" && ! -e "$BINARY" && ! -L "$BINARY" && ! -e "$OVERLAY" && ! -L "$OVERLAY" && ! -e "$OVERLAY_STATE" && ! -L "$OVERLAY_STATE" && ! -e "$AUTOSTART" && ! -L "$AUTOSTART" && ! -e "$LOCATION_IDENTITY" && ! -L "$LOCATION_IDENTITY" && ! -e "$LOCATION_STATE" && ! -L "$LOCATION_STATE" && ! -e "$POINTER" && ! -L "$POINTER" && ! -e "$POINTER_STATE" && ! -L "$POINTER_STATE" && ! -e "$ENGINES" && ! -L "$ENGINES" && ! -e "$ENGINES_STATE" && ! -L "$ENGINES_STATE" && ( "$REMOVE_ALL" == 0 || ( ! -e "$BROWSER_STATE" && ! -L "$BROWSER_STATE" ) ) ]]; then
  echo "No Linux native desktop installation to remove."
  exit 0
fi
[[ "$(id -u)" != 0 ]] || { echo "Install the native provider as the interactive user, not root." >&2; exit 1; }
[[ "$HOME" == /* && "$AUTOSTART" == /* && "$LOCATION_IDENTITY" == /* && "$BINARY" != *$'\n'* && "$BINARY" != *'='* ]] || { echo "Invalid desktop installation path." >&2; exit 1; }
for directory in "$DEST" "$SKILLS" "$(dirname "$AUTOSTART")" "$(dirname "$LOCATION_IDENTITY")"; do
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" && "$(stat -c %u "$directory")" == "$(id -u)" ]] || { echo "Refusing foreign or linked desktop installation directory: $directory" >&2; exit 1; }
  fi
done
if [[ -e "$LOCATION_STATE" || -L "$LOCATION_STATE" || -e "$LOCATION_IDENTITY" || -L "$LOCATION_IDENTITY" ]]; then
  [[ -f "$LOCATION_STATE" && ! -L "$LOCATION_STATE" && "$(stat -c %u "$LOCATION_STATE")" == "$(id -u)" && -f "$LOCATION_IDENTITY" && ! -L "$LOCATION_IDENTITY" && "$(stat -c %u "$LOCATION_IDENTITY")" == "$(id -u)" && -f "$STATE" ]] || { echo "Refusing foreign GeoClue desktop identity or receipt." >&2; exit 1; }
  mapfile -t LOCATION_HASHES < "$LOCATION_STATE"
  [[ "${LOCATION_HASHES[0]:-}" == interceptor-location-identity-v1 && "${#LOCATION_HASHES[@]}" == 2 && "$(sha256sum "$LOCATION_IDENTITY" | cut -d ' ' -f 1)" == "${LOCATION_HASHES[1]}" ]] || { echo "Refusing modified GeoClue desktop identity." >&2; exit 1; }
fi
for artifact in "$STATE" "$BINARY" "$AUTOSTART"; do
  if [[ -e "$artifact" || -L "$artifact" ]]; then
    [[ -f "$artifact" && ! -L "$artifact" && "$(stat -c %u "$artifact")" == "$(id -u)" && -f "$STATE" ]] || { echo "Refusing an unowned desktop installation artifact: $artifact" >&2; exit 1; }
  fi
done
if [[ -e "$OVERLAY" || -L "$OVERLAY" || -e "$OVERLAY_STATE" || -L "$OVERLAY_STATE" ]]; then
  [[ -f "$OVERLAY" && ! -L "$OVERLAY" && "$(stat -c %u "$OVERLAY")" == "$(id -u)" && -f "$OVERLAY_STATE" && ! -L "$OVERLAY_STATE" && "$(stat -c %u "$OVERLAY_STATE")" == "$(id -u)" && -f "$STATE" ]] || { echo "Refusing a foreign overlay helper or receipt." >&2; exit 1; }
  mapfile -t OVERLAY_HASHES < "$OVERLAY_STATE"
  [[ "${OVERLAY_HASHES[0]:-}" == interceptor-overlay-install-v1 && "${#OVERLAY_HASHES[@]}" == 2 && "$(sha256sum "$OVERLAY" | cut -d ' ' -f 1)" == "${OVERLAY_HASHES[1]}" ]] || { echo "Refusing a modified overlay helper: $OVERLAY" >&2; exit 1; }
fi
if [[ -f "$STATE" ]]; then
  mapfile -t HASHES < "$STATE"
  [[ "${HASHES[0]:-}" == interceptor-desktop-install-v1 && "${#HASHES[@]}" == 3 ]] || { echo "Invalid desktop installation ownership record." >&2; exit 1; }
  for index in 1 2; do
    artifact="$BINARY"; [[ "$index" == 2 ]] && artifact="$AUTOSTART"
    if [[ -e "$artifact" ]]; then
      [[ "$(sha256sum "$artifact" | cut -d ' ' -f 1)" == "${HASHES[$index]}" ]] || { echo "Refusing modified desktop installation artifact: $artifact" >&2; exit 1; }
    fi
  done
fi
if [[ "$MODE" != --uninstall || "$REMOVE_ALL" == 1 ]]; then
  for artifact in "$CLI" "$DAEMON" "$BROWSER_STATE"; do
    if [[ -e "$artifact" || -L "$artifact" ]]; then
      [[ -f "$artifact" && ! -L "$artifact" && "$(stat -c %u "$artifact")" == "$(id -u)" && -f "$BROWSER_STATE" ]] || { echo "Refusing an unowned Linux browser payload: $artifact" >&2; exit 1; }
    fi
  done
  if [[ -f "$BROWSER_STATE" ]]; then
    mapfile -t BROWSER_HASHES < "$BROWSER_STATE"
    [[ "${BROWSER_HASHES[0]:-}" == interceptor-browser-install-v1 && "${#BROWSER_HASHES[@]}" == 3 ]] || { echo "Invalid Linux browser ownership record." >&2; exit 1; }
    for index in 1 2; do
      artifact="$CLI"; [[ "$index" == 2 ]] && artifact="$DAEMON"
      [[ ! -e "$artifact" || "$(sha256sum "$artifact" | cut -d ' ' -f 1)" == "${BROWSER_HASHES[$index]}" ]] || { echo "Refusing modified Linux browser payload: $artifact" >&2; exit 1; }
    done
  fi
  if [[ -e "$CLI_LINK" || -L "$CLI_LINK" ]]; then
    [[ -L "$CLI_LINK" && "$(stat -c %u "$CLI_LINK")" == "$(id -u)" && "$(readlink "$CLI_LINK")" == "$CLI" && -f "$BROWSER_STATE" ]] || { echo "Refusing foreign CLI link: $CLI_LINK" >&2; exit 1; }
  fi
  [[ ! -L "$(dirname "$CLI_LINK")" ]] || { echo "Refusing linked CLI installation directory." >&2; exit 1; }
fi
# An upgrade can leave the previous daemon running from its deleted binary, and it rejects a newer
# provider. Stop the owned daemon; the next CLI call starts the installed one.
stop_owned_daemon() {
  local pid exe
  for pid in $(pgrep -u "$(id -u)" -f "$DAEMON" 2>/dev/null || true); do
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    if [[ "$exe" == "$DAEMON" || "$exe" == "$DAEMON (deleted)" ]]; then "$CLI" daemon stop --reason installer >/dev/null 2>&1 || kill -TERM "$pid" 2>/dev/null || true; fi
  done
}
if [[ "$MODE" == --refresh-browser ]]; then
  # A browser-only install over the CLI and daemon that a Full install left behind (uninstall.sh
  # --bridge-only) replaces them with this archive's copies, so the native host runs this version.
  [[ -f "$BROWSER_STATE" ]] || { echo "Linux browser payload ownership preflight passed."; exit 0; }
  [[ -x "$ROOT/dist/interceptor" && -x "$ROOT/daemon/interceptor-daemon" ]] || { echo "Linux browser CLI or daemon payload missing in $ROOT." >&2; exit 1; }
  command -v flock >/dev/null && command -v sha256sum >/dev/null || { echo "Linux installation requires util-linux and coreutils." >&2; exit 1; }
  LOCK="$DEST/desktop-install.lock"
  if [[ -e "$LOCK" || -L "$LOCK" ]]; then
    [[ -f "$LOCK" && ! -L "$LOCK" && "$(stat -c %u "$LOCK")" == "$(id -u)" ]] || { echo "Refusing foreign desktop installer lock." >&2; exit 1; }
  fi
  umask 077
  exec 9>"$LOCK"
  flock -n 9 || { echo "Another desktop installation is running." >&2; exit 1; }
  STAGE="$(mktemp -d "$DEST/.browser-refresh.XXXXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  cp "$ROOT/dist/interceptor" "$STAGE/interceptor"
  cp "$ROOT/daemon/interceptor-daemon" "$STAGE/interceptor-daemon"
  chmod 755 "$STAGE/interceptor" "$STAGE/interceptor-daemon"
  mv "$STAGE/interceptor" "$CLI"
  mv "$STAGE/interceptor-daemon" "$DAEMON"
  stop_owned_daemon
  printf 'interceptor-browser-install-v1\n%s\n%s\n' "$(sha256sum "$CLI" | cut -d ' ' -f 1)" "$(sha256sum "$DAEMON" | cut -d ' ' -f 1)" > "$STAGE/browser-state"
  mv "$STAGE/browser-state" "$BROWSER_STATE"
  # The shared skills sit beside the CLI; the folder keeps its path, so adopted links stay valid.
  for skill in interceptor interceptor-browser interceptor-research; do
    [[ -f "$ROOT/dist/skills/$skill/SKILL.md" && -d "$SKILLS" ]] || continue
    cp -R "$ROOT/dist/skills/$skill" "$STAGE/$skill"; rm -rf "${SKILLS:?}/$skill"; mv "$STAGE/$skill" "$SKILLS/$skill"
  done
  echo "Owned Linux CLI and daemon refreshed from $ROOT."
  exit 0
fi
if [[ -e "$POINTER" || -L "$POINTER" || -e "$POINTER_STATE" || -L "$POINTER_STATE" ]]; then
  [[ -d "$POINTER" && ! -L "$POINTER" && "$(stat -c %u "$POINTER")" == "$(id -u)" && "$(stat -c %a "$POINTER")" == 700 && -f "$POINTER_STATE" && ! -L "$POINTER_STATE" && "$(stat -c %u "$POINTER_STATE")" == "$(id -u)" && -f "$STATE" && -x "$BINARY" ]] || { echo "Refusing foreign pointer payload ownership." >&2; exit 1; }
  mapfile -t POINTER_HASHES < "$POINTER_STATE"
  [[ "${POINTER_HASHES[0]:-}" == interceptor-pointer-install-v2 && "${#POINTER_HASHES[@]}" == 4 && "${POINTER_HASHES[3]}" =~ ^interceptor-pointer-[0-9a-f]{64}(-[0-9a-f]{16})?\.so$ ]] || { echo "Invalid pointer payload ownership record." >&2; exit 1; }
  POINTER_PAYLOAD="$POINTER/${POINTER_HASHES[3]}"
  for index in 1 2; do
    artifact="$POINTER/manifest.json"; [[ "$index" == 2 ]] && artifact="$POINTER_PAYLOAD"
    [[ -f "$artifact" && ! -L "$artifact" && "$(stat -c %u "$artifact")" == "$(id -u)" && "$(sha256sum "$artifact" | cut -d ' ' -f 1)" == "${POINTER_HASHES[$index]}" ]] || { echo "Refusing modified or linked pointer payload: $artifact" >&2; exit 1; }
  done
  shopt -s nullglob dotglob
  for artifact in "$POINTER"/*; do
    [[ "$artifact" == "$POINTER/manifest.json" || "$artifact" == "$POINTER_PAYLOAD" ]] || { echo "Refusing unknown pointer payload artifact: $artifact" >&2; exit 1; }
  done
  shopt -u nullglob dotglob
  POINTER_CHECK="$("$BINARY" --pointer-check)"
  [[ "$POINTER_CHECK" == *"\"path\":\"$POINTER_PAYLOAD\""* ]] || { echo "Pointer payload ownership path mismatch." >&2; exit 1; }
fi
if [[ -e "$ENGINES" || -L "$ENGINES" || -e "$ENGINES_STATE" || -L "$ENGINES_STATE" ]]; then
  [[ -d "$ENGINES" && ! -L "$ENGINES" && "$(stat -c %u "$ENGINES")" == "$(id -u)" && "$(stat -c %a "$ENGINES")" == 700 && -f "$ENGINES_STATE" && ! -L "$ENGINES_STATE" && "$(stat -c %u "$ENGINES_STATE")" == "$(id -u)" && -f "$STATE" && -x "$BINARY" && -f "$ENGINES/manifest.json" && ! -L "$ENGINES/manifest.json" ]] || { echo 'Refusing foreign, linked or missing engine bundle ownership.' >&2; exit 1; }
  mapfile -t ENGINE_HASHES < "$ENGINES_STATE"
  [[ "${ENGINE_HASHES[0]:-}" == interceptor-engine-install-v1 && "${#ENGINE_HASHES[@]}" == 3 && "$(sha256sum "$ENGINES/manifest.json" | cut -d ' ' -f 1)" == "${ENGINE_HASHES[1]}" && "$(sha256sum "$BINARY" | cut -d ' ' -f 1)" == "${ENGINE_HASHES[2]}" ]] || { echo 'Refusing modified engine manifest or provider ownership.' >&2; exit 1; }
  timeout 60s "$BINARY" --engines-check "$ENGINES" >/dev/null || { echo 'Installed engine bundle is incomplete, modified or stalled; no payload was replaced.' >&2; exit 1; }
fi
if [[ "$MODE" != --uninstall ]]; then
  ARCH="$(uname -m)"; [[ "$ARCH" == aarch64 ]] && ARCH=arm64; [[ "$ARCH" == x86_64 ]] && ARCH=x64
  SOURCE="${INTERCEPTOR_DESKTOP_INSTALL_SOURCE:-$ROOT/dist/interceptor-desktop}"
  if [[ -z "${INTERCEPTOR_DESKTOP_INSTALL_SOURCE:-}" && ! -f "$SOURCE" ]]; then SOURCE="$ROOT/dist/linux/$ARCH/desktop/interceptor-desktop"; fi
  [[ -f "$SOURCE" && -x "$SOURCE" ]] || { echo "Native Linux provider payload missing. Build the matching host provider before --full installation." >&2; exit 1; }
  command -v flock >/dev/null && command -v sha256sum >/dev/null || { echo "Linux full installation requires util-linux and coreutils." >&2; exit 1; }
  MISSING="$(missing_libraries "$SOURCE")"
  [[ -z "$MISSING" ]] || { printf 'Native Linux libraries missing; install these packages, then run the installer again:\n%s\n' "$MISSING" >&2; exit 1; }
  if [[ -f "$(dirname "$SOURCE")/interceptor-overlay" ]]; then
    OVERLAY_SOURCE="$(dirname "$SOURCE")/interceptor-overlay"
    OVERLAY_MISSING="$(missing_libraries "$OVERLAY_SOURCE")"
    if [[ -n "$OVERLAY_MISSING" ]]; then
      printf 'Overlays stay unavailable until these packages are installed (everything else installs):\n%s\n' "$OVERLAY_MISSING" >&2
      OVERLAY_SOURCE=''
    fi
  fi
  VERSION="$("$SOURCE" --version)"
  read -r CLI_NAME CLI_VERSION CLI_METADATA <<< "$("$ROOT/dist/interceptor" --version)"
  [[ "$CLI_NAME" == interceptor && "$VERSION" == "$CLI_VERSION" ]] || { echo "CLI and desktop provider versions do not match." >&2; exit 1; }
  [[ -x "$ROOT/daemon/interceptor-daemon" ]] || { echo "Linux browser daemon payload missing." >&2; exit 1; }
  # A release archive carries its skills in dist/skills; in a source checkout build.sh writes them
  # to dist/linux/<arch>/skills. Never copy .agents/skills: it holds every OS's lines.
  SKILLS_SOURCE="$ROOT/dist/skills"; [[ -d "$SKILLS_SOURCE" ]] || SKILLS_SOURCE="$ROOT/dist/linux/$ARCH/skills"
  [[ -f "$SKILLS_SOURCE/interceptor-desktop/SKILL.md" ]] || { echo "Linux agent skills missing at $SKILLS_SOURCE; run bash scripts/build.sh --target=linux-$ARCH first." >&2; exit 1; }
  POINTER_SOURCE="$(dirname "$SOURCE")/hyprland"
  if [[ -e "$POINTER_SOURCE" || -L "$POINTER_SOURCE" ]]; then
    POINTER_CHECK="$("$SOURCE" --pointer-check)"
    if [[ "$POINTER_CHECK" =~ \"path\":\"([^\"]+)\" ]]; then POINTER_SOURCE_PAYLOAD="${BASH_REMATCH[1]}"; fi
    [[ "$POINTER_SOURCE_PAYLOAD" == "$POINTER_SOURCE"/interceptor-pointer-*.so && "${POINTER_SOURCE_PAYLOAD##*/}" =~ ^interceptor-pointer-[0-9a-f]{64}\.so$ ]] || { echo "Invalid qualified pointer source path." >&2; exit 1; }
  fi
  ENGINES_SOURCE="$(dirname "$SOURCE")/engines"
  if [[ -e "$ENGINES_SOURCE" || -L "$ENGINES_SOURCE" ]]; then
    timeout 60s "$SOURCE" --engines-check "$ENGINES_SOURCE" >/dev/null || { echo 'Source engine payload is incomplete, modified, linked or stalled.' >&2; exit 1; }
  elif [[ -d "$ENGINES" ]]; then
    echo 'An owned engine bundle is installed; the full upgrade must carry its replacement bundle.' >&2; exit 1
  fi
fi
[[ "$MODE" != --check ]] || { echo "Linux desktop payload and ownership preflight passed."; exit 0; }
mkdir -p "$DEST" "$(dirname "$AUTOSTART")" "$(dirname "$LOCATION_IDENTITY")"
chmod 700 "$DEST"
LOCK="$DEST/desktop-install.lock"
if [[ -e "$LOCK" || -L "$LOCK" ]]; then
  [[ -f "$LOCK" && ! -L "$LOCK" && "$(stat -c %u "$LOCK")" == "$(id -u)" ]] || { echo "Refusing foreign desktop installer lock." >&2; exit 1; }
fi
umask 077
exec 9>"$LOCK"
flock -n 9 || { echo "Another desktop installation is running." >&2; exit 1; }
# Only the authenticated native client can stop a provider. A foreign process
# or another login's endpoint makes maintenance fail before replacing files.
WAS_RUNNING=0
POINTER_WAS_LOADED=0
POINTER_MAINTENANCE_READY=0
STARTUP_UNIT='app-com.interceptor.desktop@autostart.service'
MANAGED_STARTUP=0
STARTUP_MANAGER=0
STARTUP_AUTHORIZED=0
startup_service_owned() {
  local load source command
  load="$(systemctl --user show "$STARTUP_UNIT" -p LoadState --value 2>/dev/null)" || return 1
  [[ "$load" == loaded ]] || return 1
  source="$(systemctl --user show "$STARTUP_UNIT" -p SourcePath --value)" || return 2
  command="$(systemctl --user show "$STARTUP_UNIT" -p ExecStart --value)" || return 2
  [[ "$source" == "$AUTOSTART" && "$command" == "{ path=$BINARY ; argv[]=$BINARY ; ignore_errors=no ;"* ]] || {
    echo "Refusing a foreign or overridden desktop startup service." >&2
    return 2
  }
}
start_provider() {
  if [[ "$STARTUP_MANAGER" == 1 ]]; then
    if ! systemctl --user daemon-reload; then
      [[ "$MANAGED_STARTUP" == 0 ]] || return 1
    elif startup_service_owned; then MANAGED_STARTUP=1; else
      local status=$?
      [[ "$status" != 2 && "$MANAGED_STARTUP" == 0 ]] || return 1
    fi
  fi
  if [[ "$MANAGED_STARTUP" == 1 ]]; then
    systemctl --user start "$STARTUP_UNIT" || return
    PROVIDER_PID="$(systemctl --user show "$STARTUP_UNIT" -p MainPID --value)" || return
    [[ "$PROVIDER_PID" =~ ^[1-9][0-9]*$ ]] || return 1
  else
    nohup "$BINARY" > "$DEST/desktop-provider.log" 2>&1 < /dev/null 9>&- &
    PROVIDER_PID=$!
  fi
}
if [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" && ( -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ) ]] && command -v systemctl >/dev/null; then
  STARTUP_MANAGER=1
  if startup_service_owned; then MANAGED_STARTUP=1; else
    startup_status=$?
    [[ "$startup_status" != 2 ]] || exit 1
  fi
fi
if [[ -f "$BINARY" ]]; then
  if printf '\062\000\000\000{"id":"install","action":{"type":"desktop_hello"}}' | "$BINARY" --client 2>/dev/null | grep -aF '"success":true' >/dev/null; then WAS_RUNNING=1; fi
fi
if [[ -d "$POINTER" ]]; then
  if [[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" && -n "${WAYLAND_DISPLAY:-}" ]]; then
    "$BINARY" --identity >/dev/null
    POINTER_MAINTENANCE_READY=1
  elif [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    for endpoint in "$XDG_RUNTIME_DIR"/hypr/*/.socket.sock; do
      [[ ! -S "$endpoint" ]] || { echo "Pointer maintenance requires the owning Hyprland login; no files were replaced." >&2; exit 1; }
    done
  else
    echo "Pointer maintenance requires an identified runtime directory; no files were replaced." >&2; exit 1
  fi
fi
# Snapshot and register rollback before unloading or stopping live providers.
if [[ "$MODE" != --uninstall ]]; then
STAGE="$(mktemp -d "$DEST/.desktop-install.XXXXXXXX")"
for artifact in "$BINARY" "$AUTOSTART" "$STATE" "$OVERLAY" "$OVERLAY_STATE" "$CLI" "$DAEMON" "$BROWSER_STATE" "$POINTER_STATE" "$LOCATION_STATE" "$ENGINES_STATE"; do [[ ! -e "$artifact" ]] || cp -p "$artifact" "$STAGE/$(basename "$artifact").previous"; done
[[ ! -e "$LOCATION_IDENTITY" ]] || cp -p "$LOCATION_IDENTITY" "$STAGE/location-identity.previous"
[[ ! -d "$POINTER" ]] || cp -p "$POINTER/manifest.json" "$STAGE/pointer-manifest.previous"
PREVIOUS_LINK=''; [[ ! -L "$CLI_LINK" ]] || PREVIOUS_LINK="$(readlink "$CLI_LINK")"
COMMITTED=0
POINTER_PUBLISHED=0
OLD_POINTER_MOVED=0
NEW_POINTER_PAYLOAD=''
ENGINE_OLD_MOVED=0
ENGINE_NEW_PUBLISHED=0
rollback() {
  if [[ "$COMMITTED" == 0 ]]; then
    [[ "$MANAGED_STARTUP" != 1 || "$STARTUP_AUTHORIZED" != 1 ]] || systemctl --user stop "$STARTUP_UNIT" >/dev/null 2>&1 || true
    [[ ! -x "$BINARY" ]] || "$BINARY" --stop >/dev/null 2>&1 || true
    if [[ "$ENGINE_NEW_PUBLISHED" == 1 ]]; then
      if timeout 60s "$STAGE/interceptor-desktop.engine-validator" --engines-check "$ENGINES" >/dev/null; then
        mv "$ENGINES" "$STAGE/engines.failed"
      else
        echo 'New engine bundle changed during rollback; preserving both generations for repair.' >&2
        return 1
      fi
    fi
    if [[ "$ENGINE_OLD_MOVED" == 1 ]]; then mv "$STAGE/engines.previous" "$ENGINES"; fi
    if [[ "$POINTER_PUBLISHED" == 1 ]]; then
      [[ ! -d "$POINTER" || ! -x "$BINARY" ]] || "$BINARY" --pointer-unload >/dev/null 2>&1 || true
      if [[ -n "$NEW_POINTER_PAYLOAD" && "$NEW_POINTER_PAYLOAD" != "$POINTER_PAYLOAD" ]]; then rm -f "$NEW_POINTER_PAYLOAD"; fi
      if [[ -f "$STAGE/pointer-manifest.previous" ]]; then mkdir -p "$POINTER"; chmod 700 "$POINTER"; fi
      if [[ "$OLD_POINTER_MOVED" == 1 ]]; then mv "$STAGE/pointer-payload.previous" "$POINTER_PAYLOAD"; fi
      if [[ -f "$STAGE/pointer-manifest.previous" ]]; then
        cp -p "$STAGE/pointer-manifest.previous" "$POINTER/manifest.json"
      elif [[ -d "$POINTER" ]]; then rm -f "$POINTER/manifest.json"; rmdir "$POINTER"; fi
    fi
    for artifact in "$BINARY" "$AUTOSTART" "$STATE" "$OVERLAY" "$OVERLAY_STATE" "$CLI" "$DAEMON" "$BROWSER_STATE" "$POINTER_STATE" "$LOCATION_STATE" "$ENGINES_STATE"; do
      previous="$STAGE/$(basename "$artifact").previous"
      if [[ -f "$previous" ]]; then
        # A refused maintenance request leaves the old executable running.
        # Do not rewrite it; restore changed payloads by replacing the inode.
        if ! cmp -s "$previous" "$artifact"; then
          cp -p "$previous" "$STAGE/rollback-artifact"
          mv -f "$STAGE/rollback-artifact" "$artifact"
        fi
      else rm -f "$artifact"; fi
    done
    if [[ -f "$STAGE/location-identity.previous" ]]; then
      if ! cmp -s "$STAGE/location-identity.previous" "$LOCATION_IDENTITY"; then
        cp -p "$STAGE/location-identity.previous" "$STAGE/rollback-location-identity"
        mv -f "$STAGE/rollback-location-identity" "$LOCATION_IDENTITY"
      fi
    else rm -f "$LOCATION_IDENTITY"; fi
    [[ "$STARTUP_MANAGER" != 1 || "$STARTUP_AUTHORIZED" != 1 ]] || systemctl --user daemon-reload >/dev/null 2>&1 || true
    if [[ -n "$PREVIOUS_LINK" ]]; then ln -sfn "$PREVIOUS_LINK" "$CLI_LINK"; else rm -f "$CLI_LINK"; fi
    if [[ "$POINTER_WAS_LOADED" == 1 ]]; then "$BINARY" --pointer-load >/dev/null; fi
    if [[ "$WAS_RUNNING" == 1 && "$STARTUP_AUTHORIZED" == 1 && -x "$BINARY" ]]; then
      start_provider || echo "Previous native provider startup failed during rollback." >&2
    fi
  fi
  rm -rf "$STAGE"
}
trap rollback EXIT
fi
if [[ "$POINTER_MAINTENANCE_READY" == 1 ]]; then
  POINTER_UNLOAD="$("$BINARY" --pointer-unload)"
  [[ "$POINTER_UNLOAD" == *'"alreadyApplied":true'* ]] || POINTER_WAS_LOADED=1
fi
if [[ -f "$BINARY" ]]; then
  "$BINARY" --stop >/dev/null
  STARTUP_AUTHORIZED=1
  if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    for endpoint in "$XDG_RUNTIME_DIR"/interceptor-desktop/session-*.sock; do
      [[ -S "$endpoint" ]] || continue
      "$BINARY" --stop "$endpoint" >/dev/null
    done
  fi
fi
# Authentication above must succeed before touching a GUI startup unit.
# Waiting for the old unit to stop also releases its remaining cgroup members.
if [[ "$MANAGED_STARTUP" == 1 && "$STARTUP_AUTHORIZED" != 1 ]]; then
  IDENTITY_BINARY="$BINARY"
  [[ "$MODE" == --uninstall ]] || IDENTITY_BINARY="$SOURCE"
  [[ -x "$IDENTITY_BINARY" ]] || { echo "Native provider missing; cannot authenticate startup maintenance." >&2; exit 1; }
  "$IDENTITY_BINARY" --identity >/dev/null
  STARTUP_AUTHORIZED=1
fi
[[ "$MANAGED_STARTUP" != 1 ]] || systemctl --user stop "$STARTUP_UNIT"
if [[ "$MODE" == --uninstall ]]; then
  # The native-app skill leaves with the provider. Links adopted from this install are removed first.
  if [[ -d "$SKILLS/interceptor-desktop" ]]; then
    [[ ! -x "$CLI" || ! -f "$SKILLS/interceptor-browser/SKILL.md" ]] || "$CLI" skills unadopt interceptor-desktop --owned-root "$SKILLS" >/dev/null
    rm -rf "$SKILLS/interceptor-desktop"
  fi
  if [[ -f "$ENGINES_STATE" ]]; then
    timeout 60s "$BINARY" --engines-check "$ENGINES" >/dev/null || { echo 'Engine bundle changed before uninstall; preserving it.' >&2; exit 1; }
    rm -rf "$ENGINES"; rm -f "$ENGINES_STATE"
  fi
  # The local AI model: 2.8 GB the provider downloaded on first use, kept outside the
  # install folder so upgrades keep it. Only the files the provider wrote are removed.
  MODELS="${XDG_DATA_HOME:-$HOME/.local/share}/interceptor-models"
  if [[ -d "$MODELS" && ! -L "$MODELS" ]]; then rm -f "$MODELS"/gemma-4-E2B-it-Q4_0.gguf "$MODELS"/gemma-4-E2B-it-Q4_0.gguf.sha256 "$MODELS"/gemma-4-E2B-it-Q4_0.part; rmdir "$MODELS" 2>/dev/null || true; fi
  # The provider's update folder: downloaded archives, the update watcher copy, logs and state (update.rs).
  UPDATES="${XDG_CACHE_HOME:-$HOME/.cache}/interceptor/updates"
  if [[ -d "$UPDATES" && ! -L "$UPDATES" ]]; then rm -rf "$UPDATES"; rmdir "$(dirname "$UPDATES")" 2>/dev/null || true; fi
  if [[ -f "$POINTER_STATE" ]]; then rm -f "$POINTER/manifest.json" "$POINTER_PAYLOAD" "$POINTER_STATE"; rmdir "$POINTER"; fi
  [[ ! -f "$OVERLAY_STATE" ]] || rm -f "$OVERLAY" "$OVERLAY_STATE"
  [[ ! -f "$STATE" ]] || rm -f "$BINARY" "$AUTOSTART" "$STATE"
  [[ ! -f "$LOCATION_STATE" ]] || rm -f "$LOCATION_IDENTITY" "$LOCATION_STATE"
  [[ "$STARTUP_MANAGER" != 1 ]] || systemctl --user daemon-reload
  if [[ "$REMOVE_ALL" == 1 && -f "$BROWSER_STATE" ]]; then
    if [[ -x "$CLI" ]]; then
      SNAPSHOT="$("$CLI" --json status)"
      if [[ "$SNAPSHOT" =~ \"pid\":[[:space:]]*([0-9]+) ]]; then
        DAEMON_EXE="$(readlink "/proc/${BASH_REMATCH[1]}/exe" 2>/dev/null || true)"
        if [[ "$DAEMON_EXE" == "$DAEMON" || "$DAEMON_EXE" == "$DAEMON (deleted)" ]]; then "$CLI" daemon stop; fi
      fi
    fi
    if [[ -d "$SKILLS" ]]; then
      [[ ! -x "$CLI" || ! -f "$SKILLS/interceptor-browser/SKILL.md" ]] || "$CLI" skills unadopt --all --owned-root "$SKILLS" >/dev/null
      rm -rf "$SKILLS"
    fi
    rm -f "$CLI_LINK" "$CLI" "$DAEMON" "$BROWSER_STATE"
    echo "Owned Linux CLI, daemon and native installation removed."
  else
    echo "Owned Linux desktop installation removed. Browser installation remains."
  fi
  exit 0
fi
cp "$SOURCE" "$STAGE/interceptor-desktop"
chmod 755 "$STAGE/interceptor-desktop"
if [[ -d "$ENGINES_SOURCE" ]]; then
  cp -R "$ENGINES_SOURCE" "$STAGE/engines"
  chmod 700 "$STAGE/engines"
  timeout 60s "$STAGE/interceptor-desktop" --engines-check "$STAGE/engines" >/dev/null
  cp -p "$STAGE/interceptor-desktop" "$STAGE/interceptor-desktop.engine-validator"
fi
if [[ -d "$POINTER_SOURCE" ]]; then
  REUSE_POINTER=()
  if [[ -n "$POINTER_PAYLOAD" && "$(sha256sum "$POINTER_SOURCE_PAYLOAD" | cut -d ' ' -f 1)" == "${POINTER_HASHES[2]}" ]]; then REUSE_POINTER=("${POINTER_PAYLOAD##*/}"); fi
  POINTER_STAGED="$("$SOURCE" --pointer-stage "$POINTER_SOURCE" "$STAGE/hyprland" "${REUSE_POINTER[@]}")"
  if [[ "$POINTER_STAGED" =~ \"path\":\"([^\"]+)\" ]]; then POINTER_STAGED_PAYLOAD="${BASH_REMATCH[1]}"; else echo "Native pointer staging returned no image path." >&2; exit 1; fi
  "$STAGE/interceptor-desktop" --pointer-check >/dev/null
fi
EXEC_PATH="${BINARY//\\/\\\\\\\\}"; EXEC_PATH="${EXEC_PATH//\"/\\\\\"}"; EXEC_PATH="${EXEC_PATH//\$/\\\\\$}"; EXEC_PATH="${EXEC_PATH//\`/\\\\\`}"; EXEC_PATH="${EXEC_PATH//%/%%}"
printf '[Desktop Entry]\nType=Application\nName=Interceptor Desktop\nExec="%s"\nTerminal=false\nNoDisplay=true\nX-Interceptor-Owner=desktop-install-v1\n' "$EXEC_PATH" > "$STAGE/autostart.desktop"
printf '[Desktop Entry]\nType=Application\nName=Interceptor Desktop\nExec="%s"\nTerminal=false\nNoDisplay=true\nX-Geoclue-Reason=Read device location when explicitly requested by the operator\nX-Interceptor-Owner=location-identity-v1\n' "$EXEC_PATH" > "$STAGE/location-identity.desktop"
cp "$ROOT/dist/interceptor" "$STAGE/interceptor"
cp "$ROOT/daemon/interceptor-daemon" "$STAGE/interceptor-daemon"
chmod 755 "$STAGE/interceptor" "$STAGE/interceptor-daemon"
# interceptor-desktop is the native-app skill; the Mac and iPhone skills are not for this host.
mkdir "$STAGE/skills"
for skill in interceptor interceptor-browser interceptor-research interceptor-desktop; do
  [[ ! -f "$SKILLS_SOURCE/$skill/SKILL.md" ]] || cp -R "$SKILLS_SOURCE/$skill" "$STAGE/skills/$skill"
done
mv "$STAGE/interceptor" "$CLI"
mv "$STAGE/interceptor-daemon" "$DAEMON"
stop_owned_daemon
printf 'interceptor-browser-install-v1\n%s\n%s\n' "$(sha256sum "$CLI" | cut -d ' ' -f 1)" "$(sha256sum "$DAEMON" | cut -d ' ' -f 1)" > "$STAGE/browser-state"
mv "$STAGE/browser-state" "$BROWSER_STATE"
mkdir -p "$(dirname "$CLI_LINK")"
ln -sfn "$CLI" "$CLI_LINK"
mv "$STAGE/interceptor-desktop" "$BINARY"
if [[ -n "$OVERLAY_SOURCE" ]]; then
  cp "$OVERLAY_SOURCE" "$STAGE/interceptor-overlay"
  chmod 755 "$STAGE/interceptor-overlay"
  mv "$STAGE/interceptor-overlay" "$OVERLAY"
  printf 'interceptor-overlay-install-v1\n%s\n' "$(sha256sum "$OVERLAY" | cut -d ' ' -f 1)" > "$STAGE/overlay-state"
  mv "$STAGE/overlay-state" "$OVERLAY_STATE"
else
  # No usable helper in this payload: an older owned one must not outlive its provider.
  rm -f "$OVERLAY" "$OVERLAY_STATE"
fi
if [[ -d "$STAGE/engines" ]]; then
  if [[ -d "$ENGINES" ]]; then mv "$ENGINES" "$STAGE/engines.previous"; ENGINE_OLD_MOVED=1; fi
  mv "$STAGE/engines" "$ENGINES"; ENGINE_NEW_PUBLISHED=1
  printf 'interceptor-engine-install-v1\n%s\n%s\n' "$(sha256sum "$ENGINES/manifest.json" | cut -d ' ' -f 1)" "$(sha256sum "$BINARY" | cut -d ' ' -f 1)" > "$STAGE/engine-state"
  mv "$STAGE/engine-state" "$ENGINES_STATE"
fi
POINTER_PUBLISHED=1
if [[ -n "$POINTER_SOURCE_PAYLOAD" ]]; then NEW_POINTER_PAYLOAD="$POINTER/${POINTER_STAGED_PAYLOAD##*/}"; fi
if [[ -n "$POINTER_PAYLOAD" && "$POINTER_PAYLOAD" != "$NEW_POINTER_PAYLOAD" ]]; then
  mv "$POINTER_PAYLOAD" "$STAGE/pointer-payload.previous"
  OLD_POINTER_MOVED=1
fi
rm -f "$POINTER_STATE"
if [[ -d "$STAGE/hyprland" ]]; then
  mkdir -p "$POINTER"; chmod 700 "$POINTER"
  # Retain the original inode for an unchanged digest. A loader may keep the
  # library mapped even after its plugin registration has been removed.
  [[ -f "$NEW_POINTER_PAYLOAD" ]] || mv "$POINTER_STAGED_PAYLOAD" "$NEW_POINTER_PAYLOAD"
  mv "$STAGE/hyprland/manifest.json" "$POINTER/manifest.json"
  printf 'interceptor-pointer-install-v2\n%s\n%s\n%s\n' "$(sha256sum "$POINTER/manifest.json" | cut -d ' ' -f 1)" "$(sha256sum "$NEW_POINTER_PAYLOAD" | cut -d ' ' -f 1)" "${NEW_POINTER_PAYLOAD##*/}" > "$POINTER_STATE"
elif [[ -d "$POINTER" ]]; then
  rm -f "$POINTER/manifest.json"; rmdir "$POINTER"
fi
mv "$STAGE/autostart.desktop" "$AUTOSTART"
mv "$STAGE/location-identity.desktop" "$LOCATION_IDENTITY"
printf 'interceptor-location-identity-v1\n%s\n' "$(sha256sum "$LOCATION_IDENTITY" | cut -d ' ' -f 1)" > "$STAGE/location-state"
mv "$STAGE/location-state" "$LOCATION_STATE"
printf 'interceptor-desktop-install-v1\n%s\n%s\n' "$(sha256sum "$BINARY" | cut -d ' ' -f 1)" "$(sha256sum "$AUTOSTART" | cut -d ' ' -f 1)" > "$STAGE/state"
mv "$STAGE/state" "$STATE"
if [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" && ( -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ) ]]; then
  "$BINARY" --identity >/dev/null
  STARTUP_AUTHORIZED=1
  if [[ -d "$POINTER" && -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]]; then "$BINARY" --pointer-load >/dev/null; fi
  start_provider || { echo "Native provider startup failed; rolling back." >&2; exit 1; }
  HEALTHY=0
  for attempt in {1..50}; do
    kill -0 "$PROVIDER_PID" 2>/dev/null || break
    # The fixed ASCII JSON payload is exactly 50 bytes (octal 062).
    if printf '\062\000\000\000{"id":"install","action":{"type":"desktop_hello"}}' | "$BINARY" --client 2>/dev/null | grep -aF '"success":true' | grep -aE '"pid":'"$PROVIDER_PID"'[,}]' >/dev/null; then HEALTHY=1; break; fi
    sleep 0.1
  done
  [[ "$HEALTHY" == 1 ]] || { echo "Native provider failed its authenticated startup check; rolling back." >&2; exit 1; }
else
  echo "Native provider installed. Startup is deferred until an identified GUI login session."
fi
# Published last: the folder keeps its path, so skill links adopted from it stay valid across an upgrade.
rm -rf "$SKILLS"; mv "$STAGE/skills" "$SKILLS"
COMMITTED=1
echo "Linux native provider $VERSION installed; full parity qualification remains operation-specific."
