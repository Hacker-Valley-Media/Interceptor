#!/bin/bash
# Release pipeline — build, sign, notarize, staple, and produce signed
# installer pkgs suitable for direct public distribution.
#
# This script builds two distinct pkgs by default:
#   dist/release/Interceptor-Browser-<version>.pkg  (CLI + daemon + extension)
#   dist/release/Interceptor-Full-<version>.pkg     (+ bridge .app + LaunchAgent)
#
# Pass --browser-only or --full to build just one. Default is both.
# Pass --dry-run to print steps without invoking Apple-side commands; useful
# for the bun-test release-modes harness that asserts payload contents per
# mode without requiring keychain credentials or notarization.
#
# What this does, in order:
#   1.  Verify signing identities, notary profile, entitlements, host arch.
#   2.  bash scripts/build.sh — extension, CLI, daemon, bridge .app (full only).
#   3.  Codesign CLI + daemon with hardened runtime, timestamp, entitlements.
#       (Bridge .app is signed by build-bridge.sh.)
#   4.  Stage payload + extension + manifest template under dist/release/staging/.
#       Bridge artifacts stage only when building Full.
#   5.  Round 1 notarize a zip of the binary payload (shared across modes).
#   6.  Staple the bridge .app (full mode only).
#   7.  pkgbuild component pkgs from the staged tree. Bridge component skipped
#       in browser-only mode. Daemon component differs per mode (LaunchAgent
#       payload + which postinstall is attached).
#   8.  productbuild combines components per mode (Browser uses
#       distribution-browser.xml, Full uses distribution.xml).
#   9.  productsign signs the combined pkg(s) with the Installer cert.
#   10. Round 2 notarize each signed pkg.
#   11. Staple each pkg.
#   12. Verify with stapler validate, pkgutil --check-signature, spctl --assess.
#   13. Sparkle appcast publish: copy + sign each pkg, emit per-pkg appcast item
#       (with sparkle:channel set to "browser-only" or "full" so client-side
#       updaters can filter by the mode the install reported via interceptor
#       status).
#
# Env overrides (sensible defaults assume Hacker Valley Media's HVM team):
#   INTERCEPTOR_SIGNING_IDENTITY    Developer ID Application name
#   INTERCEPTOR_INSTALLER_IDENTITY  Developer ID Installer name
#   INTERCEPTOR_NOTARY_PROFILE      keychain profile name for notarytool
#   INTERCEPTOR_VERSION             version string (else read from package.json)
#   INTERCEPTOR_ENABLE_PLATFORM_TARGETS=1
#                                  compile in research-only native platform targets
#   INTERCEPTOR_INCLUDE_AGENT_DYLIBS=1
#                                  bundle/sign native agent dylibs (research only;
#                                  public Full packages require BYO dylib)

set -euo pipefail

# ── Resolve repo root from script location ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ── Defaults (overridable via env) ────────────────────────────────────────────
SIGNING_IDENTITY="${INTERCEPTOR_SIGNING_IDENTITY:-Developer ID Application: HACKER VALLEY MEDIA, LLC (TPWBZD35WW)}"
INSTALLER_IDENTITY="${INTERCEPTOR_INSTALLER_IDENTITY:-Developer ID Installer: HACKER VALLEY MEDIA, LLC (TPWBZD35WW)}"
NOTARY_PROFILE="${INTERCEPTOR_NOTARY_PROFILE:-interceptor-notary}"
SPARKLE_VERSION="${INTERCEPTOR_SPARKLE_VERSION:-2.9.1}"
SPARKLE_TOOLS_DIR="${INTERCEPTOR_SPARKLE_TOOLS_DIR:-$HOME/.cache/interceptor-sparkle/$SPARKLE_VERSION}"
SPARKLE_HOST_DIR="${INTERCEPTOR_SPARKLE_HOST_DIR:-$REPO_ROOT/../Interceptor-Updates-Sparkle}"
DOWNLOAD_URL_PREFIX="${INTERCEPTOR_DOWNLOAD_URL_PREFIX:-https://updates.hackervalley.media/}"
ENT="$REPO_ROOT/scripts/entitlements.plist"
DIST_XML_FULL="$REPO_ROOT/scripts/release/distribution.xml"
DIST_XML_BROWSER="$REPO_ROOT/scripts/release/distribution-browser.xml"
POSTINSTALL_FULL="$REPO_ROOT/scripts/release/postinstall-full"
POSTINSTALL_BROWSER="$REPO_ROOT/scripts/release/postinstall-browser"
ENABLE_PLATFORM_TARGETS="${INTERCEPTOR_ENABLE_PLATFORM_TARGETS:-0}"
INCLUDE_AGENT_DYLIBS="${INTERCEPTOR_INCLUDE_AGENT_DYLIBS:-0}"
# When 1, a stapler failure is non-fatal: the artifact is still signed +
# notarized (Gatekeeper verifies online at first launch), just not stapled for
# offline use. Intended for network environments that can reach Apple's notary
# service but not its CloudKit ticket-delivery host (e.g. TLS-inspecting proxies).
# Default 0 — stapling stays mandatory for real public distribution.
ALLOW_UNSTAPLED="${INTERCEPTOR_ALLOW_UNSTAPLED:-0}"

# ── Parse flags ───────────────────────────────────────────────────────────────
VERSION=""
MODE_FLAG=""   # "" | "browser-only" | "full"
DRY_RUN="${INTERCEPTOR_DRY_RUN:-0}"

i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  case "$arg" in
    --browser-only)
      if [[ "$MODE_FLAG" == "full" ]]; then
        echo "ERROR: --browser-only and --full are mutually exclusive." >&2
        exit 1
      fi
      MODE_FLAG="browser-only" ;;
    --full)
      if [[ "$MODE_FLAG" == "browser-only" ]]; then
        echo "ERROR: --browser-only and --full are mutually exclusive." >&2
        exit 1
      fi
      MODE_FLAG="full" ;;
    --dry-run) DRY_RUN=1 ;;
    --version=*) VERSION="${arg#--version=}" ;;
    --version)
      i=$((i + 1))
      VERSION="${!i:-}" ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo ""
      echo "Usage: bash scripts/release.sh [MODE] [--version=X.Y.Z] [--dry-run]"
      echo ""
      echo "Modes (mutually exclusive; default builds both):"
      echo "  --browser-only   Build only Interceptor-Browser-<v>.pkg"
      echo "  --full           Build only Interceptor-Full-<v>.pkg"
      echo "  (no mode flag)   Build both pkgs"
      echo ""
      echo "Options:"
      echo "  --version=X.Y.Z  Override version (else read from package.json)"
      echo "  --dry-run        Print steps without executing them. Skips"
      echo "                   Apple-keychain prerequisite checks."
      exit 1 ;;
  esac
  i=$((i + 1))
done

# ── Resolve MODES array ───────────────────────────────────────────────────────
if [[ -z "$MODE_FLAG" ]]; then
  MODES=("browser-only" "full")
elif [[ "$MODE_FLAG" == "browser-only" ]]; then
  MODES=("browser-only")
else
  MODES=("full")
fi

# Convenience flags derived from MODES
BUILD_BROWSER=0; BUILD_FULL=0
for m in "${MODES[@]}"; do
  case "$m" in
    browser-only) BUILD_BROWSER=1 ;;
    full)         BUILD_FULL=1 ;;
  esac
done

# ── Resolve version ───────────────────────────────────────────────────────────
if [[ -z "$VERSION" ]]; then
  if [[ -n "${INTERCEPTOR_VERSION:-}" ]]; then
    VERSION="$INTERCEPTOR_VERSION"
  else
    VERSION="$(grep -E '"version"' "$REPO_ROOT/package.json" | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
  fi
fi

if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not determine version (try --version=X.Y.Z)" >&2
  exit 1
fi

# ── Output paths ──────────────────────────────────────────────────────────────
RELEASE_DIR="$REPO_ROOT/dist/release"
STAGING_DIR="$RELEASE_DIR/staging"
COMPONENTS_DIR="$RELEASE_DIR/components"
SCRIPTS_BROWSER_DIR="$RELEASE_DIR/_scripts-browser"
SCRIPTS_FULL_DIR="$RELEASE_DIR/_scripts-full"
PAYLOAD_ZIP="$RELEASE_DIR/payload.zip"

UNSIGNED_BROWSER_PKG="$RELEASE_DIR/Interceptor-Browser-${VERSION}-unsigned.pkg"
UNSIGNED_FULL_PKG="$RELEASE_DIR/Interceptor-Full-${VERSION}-unsigned.pkg"
SIGNED_BROWSER_PKG="$RELEASE_DIR/Interceptor-Browser-${VERSION}.pkg"
SIGNED_FULL_PKG="$RELEASE_DIR/Interceptor-Full-${VERSION}.pkg"

# Final install destinations the pkg payload mimics
DEST_CLI_DIR="usr/local/bin"
DEST_BRIDGE_DIR="Applications"
DEST_SUPPORT_DIR="Library/Application Support/Interceptor"
DEST_EXTENSION_DIR="${DEST_SUPPORT_DIR}/extension"
DEST_EXTENSION_MV2_DIR="${DEST_SUPPORT_DIR}/extension-mv2"

# ── Helpers ───────────────────────────────────────────────────────────────────
# `run`: in dry-run, print and skip; otherwise execute. Use for any external
# command with side effects (codesign, pkgbuild, productbuild, notarytool,
# stapler, productsign, ditto, mkdir of build outputs, etc).
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: $*"
  else
    "$@"
  fi
}

# `staple_or_fail`: staple + validate a target. A failure aborts the release
# UNLESS INTERCEPTOR_ALLOW_UNSTAPLED=1, in which case it warns and continues
# (the artifact is still signed + notarized; Gatekeeper verifies online).
staple_or_fail() {
  local target="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: xcrun stapler staple $target"
    echo "    DRY: xcrun stapler validate $target"
    return 0
  fi
  if xcrun stapler staple "$target" && xcrun stapler validate "$target"; then
    return 0
  fi
  if [[ "$ALLOW_UNSTAPLED" == "1" ]]; then
    echo "    WARNING: stapling failed for $target — continuing UNSTAPLED (INTERCEPTOR_ALLOW_UNSTAPLED=1)." >&2
    echo "             The artifact is notarized; Gatekeeper verifies it online at first launch." >&2
    return 0
  fi
  echo "ERROR: stapling failed for $target." >&2
  echo "       Set INTERCEPTOR_ALLOW_UNSTAPLED=1 to ship an unstapled (still-notarized) artifact." >&2
  return 1
}

echo "==> Mode(s): ${MODES[*]}"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "==> DRY RUN — Apple-keychain prereqs skipped; external commands not invoked."
fi

# ── Step 1: Prerequisite checks ───────────────────────────────────────────────
echo "==> Step 1: Verifying prerequisites"

if [[ "$DRY_RUN" != "1" ]]; then
  if ! security find-identity -v 2>/dev/null | grep -q "$SIGNING_IDENTITY"; then
    echo "ERROR: signing identity not found in keychain: $SIGNING_IDENTITY" >&2
    echo "       (override via INTERCEPTOR_SIGNING_IDENTITY)" >&2
    exit 1
  fi
  if ! security find-identity -v 2>/dev/null | grep -q "$INSTALLER_IDENTITY"; then
    echo "ERROR: installer identity not found in keychain: $INSTALLER_IDENTITY" >&2
    echo "       (override via INTERCEPTOR_INSTALLER_IDENTITY)" >&2
    exit 1
  fi
  if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "ERROR: notarytool keychain profile '$NOTARY_PROFILE' is not configured." >&2
    echo "       Create it with:" >&2
    echo "         xcrun notarytool store-credentials $NOTARY_PROFILE \\" >&2
    echo "           --apple-id <your-apple-id> --team-id <your-team-id> --password <app-specific-password>" >&2
    exit 1
  fi
fi

if [[ ! -f "$ENT" ]]; then
  echo "ERROR: entitlements file missing at $ENT" >&2
  exit 1
fi
if [[ "$DRY_RUN" != "1" ]] && ! plutil -lint "$ENT" >/dev/null; then
  echo "ERROR: entitlements file is not a valid plist: $ENT" >&2
  exit 1
fi

if [[ "$BUILD_FULL" == "1" && ! -f "$DIST_XML_FULL" ]]; then
  echo "ERROR: distribution.xml (full) missing at $DIST_XML_FULL" >&2
  exit 1
fi
if [[ "$BUILD_BROWSER" == "1" && ! -f "$DIST_XML_BROWSER" ]]; then
  echo "ERROR: distribution-browser.xml missing at $DIST_XML_BROWSER" >&2
  exit 1
fi
if [[ "$BUILD_FULL" == "1" && ! -x "$POSTINSTALL_FULL" ]]; then
  echo "ERROR: postinstall-full script missing or not executable: $POSTINSTALL_FULL" >&2
  exit 1
fi
if [[ "$BUILD_BROWSER" == "1" && ! -x "$POSTINSTALL_BROWSER" ]]; then
  echo "ERROR: postinstall-browser script missing or not executable: $POSTINSTALL_BROWSER" >&2
  exit 1
fi

echo "    Version:           $VERSION"
echo "    Modes:             ${MODES[*]}"
echo "    Signing identity:  $SIGNING_IDENTITY"
echo "    Installer cert:    $INSTALLER_IDENTITY"
echo "    Notary profile:    $NOTARY_PROFILE"
echo "    Platform targets:  $([[ "$ENABLE_PLATFORM_TARGETS" == "1" ]] && echo "research enabled" || echo "public disabled")"
echo "    Runtime agent dylibs: $([[ "$INCLUDE_AGENT_DYLIBS" == "1" ]] && echo "bundled research payload" || echo "BYO (not bundled)")"
echo ""

# ── Step 2: Build ─────────────────────────────────────────────────────────────
# Pass the release version through to build-bridge.sh so the .app's
# CFBundleShortVersionString / CFBundleVersion match. Sparkle compares those
# against the appcast's sparkle:version — if they don't agree, the updater
# silently decides nothing's available.
echo "==> Step 2: bash scripts/build.sh"
run env \
  INTERCEPTOR_BRIDGE_VERSION="$VERSION" \
  INTERCEPTOR_ENABLE_PLATFORM_TARGETS="$ENABLE_PLATFORM_TARGETS" \
  INTERCEPTOR_INCLUDE_AGENT_DYLIBS="$INCLUDE_AGENT_DYLIBS" \
  bash "$REPO_ROOT/scripts/build.sh"
echo ""

# Runtime Agent surface: build the in-process agent dylib(s) shipped in
# Full mode (browser-only never injects native apps).
if [[ "$BUILD_FULL" == "1" && "$INCLUDE_AGENT_DYLIBS" == "1" ]]; then
  echo "==> Step 2b: build InterceptorAgent dylib (Runtime Agent surface)"
  run bash "$REPO_ROOT/interceptor-agent/build-agent.sh"
  echo ""
elif [[ "$BUILD_FULL" == "1" ]]; then
  echo "==> Step 2b: Skipped InterceptorAgent dylib build (public Full package requires BYO dylib)"
  echo ""
fi

# ── Step 3: Codesign CLI + daemon ─────────────────────────────────────────────
echo "==> Step 3: Codesigning CLI and daemon (hardened runtime + timestamp)"

run codesign --force --options runtime --timestamp \
  --sign "$SIGNING_IDENTITY" \
  --identifier "com.interceptor.cli" \
  --entitlements "$ENT" \
  "$REPO_ROOT/dist/interceptor"

run codesign --force --options runtime --timestamp \
  --sign "$SIGNING_IDENTITY" \
  --identifier "com.interceptor.daemon" \
  --entitlements "$ENT" \
  "$REPO_ROOT/daemon/interceptor-daemon"

# Runtime Agent surface: research packages may sign and ship agent
# dylib(s). Public Full packages intentionally leave dylibs BYO so the operator
# supplies both the agent and the native re-sign identity.
if [[ "$BUILD_FULL" == "1" && "$INCLUDE_AGENT_DYLIBS" == "1" ]]; then
  for slice in arm64 arm64e; do
    AGENT_DY="$REPO_ROOT/interceptor-agent/dist/InterceptorAgent-$slice.dylib"
    if [[ -f "$AGENT_DY" || "$DRY_RUN" == "1" ]]; then
      run codesign --force --timestamp --options runtime \
        --sign "$SIGNING_IDENTITY" \
        --identifier "com.interceptor.agent.$slice" \
        "$AGENT_DY"
    fi
  done
elif [[ "$BUILD_FULL" == "1" ]]; then
  echo "==> Step 3b: Skipped agent dylib signing (BYO dylib; vendor cert not used for injected agent)"
fi

run codesign --verify --strict --verbose=2 "$REPO_ROOT/dist/interceptor"
run codesign --verify --strict --verbose=2 "$REPO_ROOT/daemon/interceptor-daemon"
if [[ "$BUILD_FULL" == "1" ]]; then
  run codesign --verify --strict --verbose=2 "$REPO_ROOT/dist/interceptor-bridge.app"
fi
echo ""

# ── Step 4: Stage payload tree ────────────────────────────────────────────────
echo "==> Step 4: Staging payload tree under dist/release/staging/"

run rm -rf "$RELEASE_DIR"
run mkdir -p "$STAGING_DIR/cli/$DEST_CLI_DIR"
run mkdir -p "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR"
run mkdir -p "$STAGING_DIR/extension/$DEST_EXTENSION_DIR"
run mkdir -p "$STAGING_DIR/extension/$DEST_EXTENSION_MV2_DIR"
run mkdir -p "$COMPONENTS_DIR"
run mkdir -p "$SCRIPTS_BROWSER_DIR"
run mkdir -p "$SCRIPTS_FULL_DIR"

# CLI: dist/interceptor → staging/cli/usr/local/bin/interceptor
run ditto "$REPO_ROOT/dist/interceptor" "$STAGING_DIR/cli/$DEST_CLI_DIR/interceptor"
run chmod 755 "$STAGING_DIR/cli/$DEST_CLI_DIR/interceptor"

# Daemon binary → staging/daemon/<support>/interceptor-daemon
run ditto "$REPO_ROOT/daemon/interceptor-daemon" "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/interceptor-daemon"
run chmod 755 "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/interceptor-daemon"

# Pre-render the native messaging host manifest with the now-stable absolute
# daemon path baked in. Pkg install paths are fixed, so there's no reason to
# ship a template + run sed at install time — just lay down the final file.
RENDERED_MANIFEST="$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/com.interceptor.host.json"
ABS_DAEMON_PATH="/$DEST_SUPPORT_DIR/interceptor-daemon"
ESCAPED_DAEMON_PATH="$(printf '%s' "$ABS_DAEMON_PATH" | sed 's/[&|\\]/\\&/g')"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "    DRY: render NMH manifest with __DAEMON_PATH__ = $ABS_DAEMON_PATH"
else
  sed "s|__DAEMON_PATH__|$ESCAPED_DAEMON_PATH|g" \
    "$REPO_ROOT/daemon/com.interceptor.host.json" > "$RENDERED_MANIFEST"
  chmod 644 "$RENDERED_MANIFEST"
fi

# Stage uninstall script for the user
run ditto "$REPO_ROOT/scripts/uninstall.sh" "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/uninstall.sh"
run chmod 755 "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/uninstall.sh"

# Stage the project README so users have local docs at the install location
run ditto "$REPO_ROOT/README.md" "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/README.md"
run chmod 644 "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/README.md"

# Browser extension: extension/dist → staging/extension/<support>/extension
run ditto "$REPO_ROOT/extension/dist" "$STAGING_DIR/extension/$DEST_EXTENSION_DIR"

# Electron app extension: extension/dist-mv2 → staging/extension/<support>/extension-mv2
run ditto "$REPO_ROOT/extension/dist-mv2" "$STAGING_DIR/extension/$DEST_EXTENSION_MV2_DIR"

# Skill packs — shipped inside the daemon component payload at
# /Library/Application Support/Interceptor/skills/<name>/. The conclusion
# screen tells users to symlink these into the runtime skill dirs they use
# (~/.claude/skills, ~/.agents/skills, etc.). Every pkg gets the top-level
# router skill, the browser-surface skill, and the deep-research methodology
# skill; Full pkg also includes the macOS-surface skill.
run mkdir -p "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/skills"
run ditto "$REPO_ROOT/.agents/skills/interceptor" "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/skills/interceptor"
run ditto "$REPO_ROOT/.agents/skills/interceptor-browser" "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/skills/interceptor-browser"
run ditto "$REPO_ROOT/.agents/skills/interceptor-research" "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/skills/interceptor-research"

# Bridge components only when building full mode. The Full daemon component
# additionally carries the LaunchAgent plist + the interceptor-macos skill
# pack; the Browser daemon component does NOT. We materialize that by ditto-
# copying staging/daemon → daemon-full and laying down the extra payload on
# top of the copy.
if [[ "$BUILD_FULL" == "1" ]]; then
  run mkdir -p "$STAGING_DIR/bridge/$DEST_BRIDGE_DIR"

  # Bridge: dist/interceptor-bridge.app → staging/bridge/Applications/interceptor-bridge.app
  run ditto "$REPO_ROOT/dist/interceptor-bridge.app" "$STAGING_DIR/bridge/$DEST_BRIDGE_DIR/interceptor-bridge.app"

  # Full daemon staging tree = browser daemon + LaunchAgent plist + macOS skill pack
  run ditto "$STAGING_DIR/daemon" "$STAGING_DIR/daemon-full"
  run mkdir -p "$STAGING_DIR/daemon-full/Library/LaunchAgents"
  run ditto "$REPO_ROOT/scripts/release/com.interceptor.bridge.plist" \
    "$STAGING_DIR/daemon-full/Library/LaunchAgents/com.interceptor.bridge.plist"
  run chmod 644 "$STAGING_DIR/daemon-full/Library/LaunchAgents/com.interceptor.bridge.plist"
  run ditto "$REPO_ROOT/.agents/skills/interceptor-macos" \
    "$STAGING_DIR/daemon-full/$DEST_SUPPORT_DIR/skills/interceptor-macos"

  if [[ "$INCLUDE_AGENT_DYLIBS" == "1" ]]; then
    # Runtime Agent surface (research profile): ship the agent dylib(s) at
    # /Library/Application Support/Interceptor/agent/ — where NativeDomain's
    # resolveAgentDylib() looks for them post-install.
    run mkdir -p "$STAGING_DIR/daemon-full/$DEST_SUPPORT_DIR/agent"
    for slice in arm64 arm64e; do
      AGENT_DY="$REPO_ROOT/interceptor-agent/dist/InterceptorAgent-$slice.dylib"
      if [[ -f "$AGENT_DY" || "$DRY_RUN" == "1" ]]; then
        run ditto "$AGENT_DY" \
          "$STAGING_DIR/daemon-full/$DEST_SUPPORT_DIR/agent/InterceptorAgent-$slice.dylib"
      fi
    done
  else
    echo "    Runtime Agent dylibs: BYO — not staged into public Full package"
  fi
fi

# Per-mode --scripts dirs: exactly one postinstall per mode.
if [[ "$BUILD_BROWSER" == "1" ]]; then
  run cp "$POSTINSTALL_BROWSER" "$SCRIPTS_BROWSER_DIR/postinstall"
  run chmod 755 "$SCRIPTS_BROWSER_DIR/postinstall"
fi
if [[ "$BUILD_FULL" == "1" ]]; then
  run cp "$POSTINSTALL_FULL" "$SCRIPTS_FULL_DIR/postinstall"
  run chmod 755 "$SCRIPTS_FULL_DIR/postinstall"
fi

if [[ "$DRY_RUN" != "1" ]]; then
  echo "    Staged tree:"
  find "$STAGING_DIR" -maxdepth 4 -type d | sed 's|^|    |'
fi
echo ""

# ── Step 5: Round 1 notarization (binary payload) ─────────────────────────────
# Round 1 is the binary payload submission — shared across both modes since
# the CLI and daemon binaries are identical. Bridge .app is included in the
# zip only when building Full.
echo "==> Step 5: Round 1 notarization — submitting binary payload"

run mkdir -p "$RELEASE_DIR/_payload"
run ditto "$STAGING_DIR/cli/$DEST_CLI_DIR/interceptor" "$RELEASE_DIR/_payload/interceptor"
run ditto "$STAGING_DIR/daemon/$DEST_SUPPORT_DIR/interceptor-daemon" "$RELEASE_DIR/_payload/interceptor-daemon"
if [[ "$BUILD_FULL" == "1" ]]; then
  run ditto "$STAGING_DIR/bridge/$DEST_BRIDGE_DIR/interceptor-bridge.app" "$RELEASE_DIR/_payload/interceptor-bridge.app"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "    DRY: ditto -c -k --keepParent --sequesterRsrc _payload payload.zip"
  echo "    DRY: xcrun notarytool submit $PAYLOAD_ZIP --keychain-profile $NOTARY_PROFILE --wait"
else
  (cd "$RELEASE_DIR" && rm -f payload.zip && \
    ditto -c -k --keepParent --sequesterRsrc _payload payload.zip)

  echo "    Submitting $PAYLOAD_ZIP to Apple notary (this can take 1-15 min)..."
  NOTARY_OUTPUT_1="$(xcrun notarytool submit "$PAYLOAD_ZIP" \
    --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)"
  echo "$NOTARY_OUTPUT_1"

  if ! echo "$NOTARY_OUTPUT_1" | grep -q "status: Accepted"; then
    echo "ERROR: round 1 notarization did not return Accepted" >&2
    exit 1
  fi
fi
echo ""

# ── Step 6: Staple the bridge .app (Mach-O can't be stapled) ──────────────────
if [[ "$BUILD_FULL" == "1" ]]; then
  echo "==> Step 6: Stapling bridge .app (in staging tree)"
  staple_or_fail "$STAGING_DIR/bridge/$DEST_BRIDGE_DIR/interceptor-bridge.app"
  echo ""
else
  echo "==> Step 6: Skipped (browser-only mode — no bridge .app to staple)"
  echo ""
fi

# ── Step 6.5: capability-blind packaging assertion ───────────────
# The shipped .pkg must carry NO extension bundle and NO relocated hardened-target
# managed-copy capability. Extensions are operator-placed at install time, never
# staged by the release.
echo "==> Step 6.5: Capability-blind packaging assertion"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "    (dry-run: would assert no extensions/ dir and no relocated capability in $STAGING_DIR)"
else
  if find "$STAGING_DIR" -type d -name extensions -print -quit | grep -q .; then
    echo "ERROR: staging tree contains an extensions/ directory — extensions must not be packaged" >&2
    exit 1
  fi
  # Staged skills must carry only a neutral extension pointer, no relocated specifics.
  SKILL_DIRS=$(find "$STAGING_DIR" -type d -name skills 2>/dev/null)
  if [[ -n "$SKILL_DIRS" ]] && rg -n "re-sign|entitlement continuity|capability continuity|managed copy|managed-copy" $SKILL_DIRS -S >&2 2>/dev/null; then
    echo "ERROR: staged skills carry relocated capability specifics (capability-blind violation)" >&2
    exit 1
  fi
  echo "    ok: no extension bundle and no relocated capability in the staged payload"
fi
echo ""

# ── Step 7: pkgbuild component pkgs ───────────────────────────────────────────
echo "==> Step 7: Building component pkgs"

# CLI component (shared across modes — identical binary)
run pkgbuild \
  --root "$STAGING_DIR/cli" \
  --identifier "com.interceptor.cli.pkg" \
  --version "$VERSION" \
  --install-location "/" \
  "$COMPONENTS_DIR/Interceptor-CLI.pkg"

# Extension component (shared across modes — identical extension files)
run pkgbuild \
  --root "$STAGING_DIR/extension" \
  --identifier "com.interceptor.extension.pkg" \
  --version "$VERSION" \
  --install-location "/" \
  "$COMPONENTS_DIR/Interceptor-Extension.pkg"

# Daemon component — per-mode. Browser daemon = browser postinstall, no
# LaunchAgent plist. Full daemon = full postinstall, includes LaunchAgent.
if [[ "$BUILD_BROWSER" == "1" ]]; then
  run pkgbuild \
    --root "$STAGING_DIR/daemon" \
    --identifier "com.interceptor.daemon.pkg" \
    --version "$VERSION" \
    --install-location "/" \
    --scripts "$SCRIPTS_BROWSER_DIR" \
    "$COMPONENTS_DIR/Interceptor-Daemon-Browser.pkg"
fi
if [[ "$BUILD_FULL" == "1" ]]; then
  run pkgbuild \
    --root "$STAGING_DIR/daemon-full" \
    --identifier "com.interceptor.daemon.pkg" \
    --version "$VERSION" \
    --install-location "/" \
    --scripts "$SCRIPTS_FULL_DIR" \
    "$COMPONENTS_DIR/Interceptor-Daemon-Full.pkg"
fi

# Bridge component (full mode only) — uses bridge-component.plist to lock
# BundleIsRelocatable=false so the user can't drag the .app to a different
# location and break the postinstall-rendered NMH manifest paths.
if [[ "$BUILD_FULL" == "1" ]]; then
  run pkgbuild \
    --root "$STAGING_DIR/bridge" \
    --identifier "com.interceptor.bridge.pkg" \
    --version "$VERSION" \
    --install-location "/" \
    --component-plist "$REPO_ROOT/scripts/release/bridge-component.plist" \
    "$COMPONENTS_DIR/Interceptor-Bridge.pkg"
fi

if [[ "$DRY_RUN" != "1" ]]; then
  echo "    Built component pkgs:"
  ls -la "$COMPONENTS_DIR"
fi
echo ""

# ── Steps 8-11: per-mode productbuild → productsign → notarize → staple ──────
build_pkg_for_mode() {
  local mode="$1"
  local dist_xml unsigned_pkg signed_pkg components_subdir

  case "$mode" in
    browser-only)
      dist_xml="$DIST_XML_BROWSER"
      unsigned_pkg="$UNSIGNED_BROWSER_PKG"
      signed_pkg="$SIGNED_BROWSER_PKG"
      components_subdir="$COMPONENTS_DIR/_browser"
      ;;
    full)
      dist_xml="$DIST_XML_FULL"
      unsigned_pkg="$UNSIGNED_FULL_PKG"
      signed_pkg="$SIGNED_FULL_PKG"
      components_subdir="$COMPONENTS_DIR/_full"
      ;;
    *)
      echo "ERROR: unknown mode '$mode'" >&2
      return 1 ;;
  esac

  echo "==> [$mode] Step 8: productbuild combining components"
  run mkdir -p "$components_subdir"

  # productbuild --package-path expects a directory with a stable set of
  # filenames matching <pkg-ref> elements in distribution.xml. The Daemon
  # component differs per mode, so we copy the right one in under the
  # canonical Interceptor-Daemon.pkg name.
  run cp "$COMPONENTS_DIR/Interceptor-CLI.pkg" "$components_subdir/Interceptor-CLI.pkg"
  run cp "$COMPONENTS_DIR/Interceptor-Extension.pkg" "$components_subdir/Interceptor-Extension.pkg"
  if [[ "$mode" == "browser-only" ]]; then
    run cp "$COMPONENTS_DIR/Interceptor-Daemon-Browser.pkg" "$components_subdir/Interceptor-Daemon.pkg"
  else
    run cp "$COMPONENTS_DIR/Interceptor-Daemon-Full.pkg" "$components_subdir/Interceptor-Daemon.pkg"
    run cp "$COMPONENTS_DIR/Interceptor-Bridge.pkg" "$components_subdir/Interceptor-Bridge.pkg"
  fi

  run productbuild \
    --distribution "$dist_xml" \
    --package-path "$components_subdir" \
    --resources "$REPO_ROOT/scripts/release/Resources" \
    --version "$VERSION" \
    "$unsigned_pkg"

  if [[ "$DRY_RUN" != "1" ]]; then
    echo "    Unsigned pkg: $unsigned_pkg"
    ls -lh "$unsigned_pkg"
  fi
  echo ""

  echo "==> [$mode] Step 9: Signing pkg with Developer ID Installer cert"
  run productsign \
    --sign "$INSTALLER_IDENTITY" \
    --timestamp \
    "$unsigned_pkg" \
    "$signed_pkg"
  run pkgutil --check-signature "$signed_pkg"
  echo ""

  echo "==> [$mode] Step 10: Round 2 notarization — submitting signed pkg"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: xcrun notarytool submit $signed_pkg --keychain-profile $NOTARY_PROFILE --wait"
  else
    NOTARY_OUTPUT_2="$(xcrun notarytool submit "$signed_pkg" \
      --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)"
    echo "$NOTARY_OUTPUT_2"
    if ! echo "$NOTARY_OUTPUT_2" | grep -q "status: Accepted"; then
      echo "ERROR: [$mode] round 2 notarization did not return Accepted" >&2
      exit 1
    fi
  fi
  echo ""

  echo "==> [$mode] Step 11: Stapling the pkg"
  staple_or_fail "$signed_pkg"
  echo ""
}

for mode in "${MODES[@]}"; do
  build_pkg_for_mode "$mode"
done

# ── Step 12: Final verification ───────────────────────────────────────────────
echo "==> Step 12: Final verification"

verify_pkg() {
  local pkg="$1" mode="$2"
  echo "--- [$mode] $pkg ---"
  echo "  pkgutil --check-signature:"
  run pkgutil --check-signature "$pkg"
  echo "  xcrun stapler validate:"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: xcrun stapler validate $pkg"
  else
    xcrun stapler validate "$pkg" 2>&1 || {
      if [[ "$ALLOW_UNSTAPLED" == "1" ]]; then echo "    (unstapled — notarized, verified online by Gatekeeper)"; else false; fi
    }
  fi
  echo "  spctl --assess --type install:"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: spctl --assess --type install --verbose=2 $pkg"
  else
    spctl --assess --type install --verbose=2 "$pkg" 2>&1 || true
  fi
  echo ""
}

if [[ "$BUILD_BROWSER" == "1" ]]; then verify_pkg "$SIGNED_BROWSER_PKG" "browser-only"; fi
if [[ "$BUILD_FULL"    == "1" ]]; then verify_pkg "$SIGNED_FULL_PKG"    "full";         fi

# Clean up scratch staging that round 1 needed
if [[ "$DRY_RUN" != "1" ]]; then
  rm -rf "$RELEASE_DIR/_payload"
  rm -f "$PAYLOAD_ZIP"
  rm -f "$UNSIGNED_BROWSER_PKG" "$UNSIGNED_FULL_PKG"
fi

# ── Step 13: Publish Sparkle appcast — REMOVED ────────────────────────────────
# Sparkle publish is intentionally NOT part of release.sh anymore. Auto-pushing
# the appcast inside the same script that produced the .pkg meant a fresh build
# went straight into the auto-update pipeline with no human-in-the-loop test
# gate. Run `bash scripts/publish-sparkle.sh` AFTER testing the .pkg locally,
# only when you're sure the build is good.
echo "==> Step 13: Sparkle publish — SKIPPED (run separately after testing)"
echo "    Test the .pkg locally, then publish with:"
echo "        bash scripts/publish-sparkle.sh"
echo "    See scripts/publish-sparkle.sh --help for flags."

# Below is the old Step 13 publish function, kept dormant so the script doesn't
# need to redefine SIGNED_*_PKG etc. The whole `if false` block is deliberately
# dead — Sparkle publish lives in scripts/publish-sparkle.sh now.
if false; then
  if [ ! -d "$SPARKLE_HOST_DIR" ]; then
    HOST_PUBLIC=""
  else
    HOST_PUBLIC="$SPARKLE_HOST_DIR/public"
    publish_to_sparkle() {
      local mode="$1" signed_pkg="$2" pkg_basename min_sys_ver title sig_line
      pkg_basename="$(basename "$signed_pkg")"
      case "$mode" in
        browser-only) min_sys_ver="11.0";  title="Interceptor (Browser-Only) ${VERSION}" ;;
        full)         min_sys_ver="15.0";  title="Interceptor (Full) ${VERSION}" ;;
      esac
      echo "    Copying $signed_pkg → $HOST_PUBLIC/$pkg_basename"
      cp "$signed_pkg" "$HOST_PUBLIC/$pkg_basename"

      echo "    Running sign_update on $pkg_basename"
      sig_line="$("$SPARKLE_TOOLS_DIR/bin/sign_update" "$HOST_PUBLIC/$pkg_basename" 2>&1 | tail -1)"
      echo "    $sig_line"

      echo "    Updating appcast.xml entry for $title"
      HOST_APPCAST="$HOST_PUBLIC/appcast.xml" \
      PKG_VERSION="$VERSION" \
      PKG_URL="${DOWNLOAD_URL_PREFIX}${pkg_basename}" \
      PKG_SIG_LINE="$sig_line" \
      PKG_TITLE="$title" \
      PKG_MIN_SYS_VER="$min_sys_ver" \
      PKG_MODE="$mode" \
      python3 - <<'PY'
import os, re, sys
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

ET.register_namespace("sparkle", "http://www.andymatuschak.org/xml-namespaces/sparkle")
SP = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"

path = os.environ["HOST_APPCAST"]
version = os.environ["PKG_VERSION"]
url = os.environ["PKG_URL"]
sig_line = os.environ["PKG_SIG_LINE"].strip()
title = os.environ["PKG_TITLE"]
min_sys_ver = os.environ["PKG_MIN_SYS_VER"]
mode = os.environ["PKG_MODE"]

# sign_update output line looks like:
#   sparkle:edSignature="..." length="..."
m = re.search(r'sparkle:edSignature="([^"]+)"\s+length="([0-9]+)"', sig_line)
if not m:
    print(f"ERROR: could not parse sign_update output: {sig_line}", file=sys.stderr)
    sys.exit(1)
ed_sig, length = m.group(1), m.group(2)

if os.path.exists(path):
    tree = ET.parse(path)
    root = tree.getroot()
    channel = root.find("channel")
else:
    root = ET.Element("rss", {
        "version": "2.0",
        "xmlns:sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle",
    })
    channel = ET.SubElement(root, "channel")
    ET.SubElement(channel, "title").text = "Interceptor"
    ET.SubElement(channel, "link").text = "https://github.com/Hacker-Valley-Media/Interceptor"
    ET.SubElement(channel, "description").text = "Sparkle update feed for Interceptor (Browser + Full)."
    ET.SubElement(channel, "language").text = "en"
    tree = ET.ElementTree(root)

# Drop any prior <item> for this version+mode (idempotency). We tag mode in
# the title so collisions across modes are visible, and use sparkle:channel
# to make per-mode updaters filterable.
for item in list(channel.findall("item")):
    sv = item.find(f"{SP}shortVersionString")
    t = item.find("title")
    if sv is not None and sv.text == version and t is not None and t.text == title:
        channel.remove(item)

item = ET.Element("item")
ET.SubElement(item, "title").text = title
ET.SubElement(item, "pubDate").text = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
ET.SubElement(item, f"{SP}version").text = version
ET.SubElement(item, f"{SP}shortVersionString").text = version
ET.SubElement(item, f"{SP}minimumSystemVersion").text = min_sys_ver
ET.SubElement(item, f"{SP}installationType").text = "package"
# Custom mode tag so client-side update logic can filter feed items by
# install mode (matches the `mode:` line `interceptor status` reports).
ET.SubElement(item, f"{SP}channel").text = mode
ET.SubElement(item, "enclosure", {
    "url": url,
    f"{SP}edSignature": ed_sig,
    "length": length,
    "type": "application/octet-stream",
})

# Insert at top so newest is first.
insert_at = list(channel).index(channel.findall("language")[-1]) + 1 if channel.find("language") is not None else 0
channel.insert(insert_at, item)

ET.indent(tree, space="    ")
tree.write(path, encoding="utf-8", xml_declaration=True)
print(f"    appcast.xml updated for {title}")
PY
    }

    if [[ "$BUILD_BROWSER" == "1" ]]; then publish_to_sparkle "browser-only" "$SIGNED_BROWSER_PKG"; fi
    if [[ "$BUILD_FULL"    == "1" ]]; then publish_to_sparkle "full"         "$SIGNED_FULL_PKG";    fi

    echo "    Deploying update host to Railway via rwh"
    if command -v rwh >/dev/null 2>&1; then
      (cd "$SPARKLE_HOST_DIR" && rwh up --service interceptor-updates --detach 2>&1 | tail -5) || \
        echo "    WARN: rwh up exited non-zero — appcast may not be live" >&2
    else
      echo "    WARN: rwh CLI not on PATH — push $HOST_PUBLIC manually" >&2
    fi
  fi
fi

echo "================================================================"
echo "Release ready:"
if [[ "$BUILD_BROWSER" == "1" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  $SIGNED_BROWSER_PKG (DRY-RUN — not actually built)"
  else
    echo "  $SIGNED_BROWSER_PKG"
    echo "  $(du -h "$SIGNED_BROWSER_PKG" | cut -f1) — signed, notarized, stapled"
  fi
fi
if [[ "$BUILD_FULL" == "1" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  $SIGNED_FULL_PKG (DRY-RUN — not actually built)"
  else
    echo "  $SIGNED_FULL_PKG"
    echo "  $(du -h "$SIGNED_FULL_PKG" | cut -f1) — signed, notarized, stapled"
  fi
fi
echo ""
echo "Next steps:"
echo "  1. Test the .pkg(s) locally (open or installer)."
echo "  2. When verified, push to the Sparkle update feed:"
echo "       bash scripts/publish-sparkle.sh"
echo ""
echo "Once published, the appcast feed will be:"
echo "       ${DOWNLOAD_URL_PREFIX}appcast.xml"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY-RUN complete."
fi
echo "================================================================"
