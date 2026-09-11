#!/bin/bash
# scripts/publish-sparkle.sh
#
# Publish already-signed-and-notarized Interceptor .pkgs to the Sparkle update
# feed. Decoupled from scripts/release.sh on purpose — release.sh produces the
# .pkgs, you TEST them locally, and only when you're happy do you run this to
# push the appcast (which auto-updates users with auto-update enabled).
#
# Reads the pkgs from dist/release/Interceptor-{Browser,Full}-<version>.pkg
# (where <version> comes from package.json, or --version=X.Y.Z).
#
# Pipeline:
#   1. validate docs/release-notes.html against the target and retained feed
#   2. copy it to release-notes-<version>.html and sign that snapshot once
#   3. per mode, copy and sign the pkg, then replace its matching appcast item
#   4. put the same signed sparkle:releaseNotesLink on both mode items
#   5. optionally deploy the host and tag the release
#
# Env overrides (same defaults as release.sh):
#   INTERCEPTOR_SPARKLE_VERSION       Sparkle tool version (default 2.9.1)
#   INTERCEPTOR_SPARKLE_TOOLS_DIR     cached sign_update install
#   INTERCEPTOR_SPARKLE_HOST_DIR      checkout of Interceptor-Updates-Sparkle
#   INTERCEPTOR_DOWNLOAD_URL_PREFIX   base URL the appcast embeds (default
#                                     https://updates.hackervalley.media/)
#
# Why this is a separate script:
# Auto-pushing the appcast inside release.sh meant a freshly-notarized .pkg
# went straight into the auto-update pipeline, with no human-in-the-loop test
# gate between "the build worked" and "every user with auto-update on gets
# the new version". This split forces the test-before-publish gate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ── Defaults ──────────────────────────────────────────────────────────────────
SPARKLE_VERSION="${INTERCEPTOR_SPARKLE_VERSION:-2.9.1}"
SPARKLE_TOOLS_DIR="${INTERCEPTOR_SPARKLE_TOOLS_DIR:-$HOME/.cache/interceptor-sparkle/$SPARKLE_VERSION}"
SPARKLE_HOST_DIR="${INTERCEPTOR_SPARKLE_HOST_DIR:-$REPO_ROOT/../Interceptor-Updates-Sparkle}"
DOWNLOAD_URL_PREFIX="${INTERCEPTOR_DOWNLOAD_URL_PREFIX:-https://updates.hackervalley.media/}"
RELEASE_DIR="$REPO_ROOT/dist/release"
RELEASE_NOTES_SOURCE="$REPO_ROOT/docs/release-notes.html"

# ── Parse flags ───────────────────────────────────────────────────────────────
VERSION=""
MODE_FLAG=""   # "" | "browser-only" | "full"
DRY_RUN=0
DEPLOY=1       # default: try rwh deploy. --no-deploy to stop after appcast.xml write.
TAG=1          # default: tag vVERSION + push, so the Windows tag-gated lane fires. --no-tag to skip.

i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  case "$arg" in
    --browser-only)
      [[ "$MODE_FLAG" == "full" ]] && { echo "ERROR: --browser-only and --full are mutually exclusive." >&2; exit 1; }
      MODE_FLAG="browser-only" ;;
    --full)
      [[ "$MODE_FLAG" == "browser-only" ]] && { echo "ERROR: --browser-only and --full are mutually exclusive." >&2; exit 1; }
      MODE_FLAG="full" ;;
    --version=*) VERSION="${arg#--version=}" ;;
    --version)
      i=$((i + 1)); VERSION="${!i:-}" ;;
    --no-deploy) DEPLOY=0 ;;
    --no-tag) TAG=0 ;;
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo ""
      echo "Usage: bash scripts/publish-sparkle.sh [MODE] [--version=X.Y.Z] [--no-deploy] [--dry-run]"
      echo ""
      echo "Publishes signed+notarized .pkgs from dist/release/ to the Sparkle"
      echo "update feed. Requires the .pkgs and a matching section in"
      echo "docs/release-notes.html — run release.sh first."
      echo ""
      echo "Modes (mutually exclusive; default publishes both if both pkgs exist):"
      echo "  --browser-only   Publish only Interceptor-Browser-<v>.pkg"
      echo "  --full           Publish only Interceptor-Full-<v>.pkg"
      echo "  (no mode flag)   Publish whichever pkg(s) exist for the version"
      echo ""
      echo "Options:"
      echo "  --version=X.Y.Z  Override version (else read from package.json)"
      echo "  --no-deploy      Update appcast.xml locally; skip the rwh deploy step"
      echo "  --no-tag         Skip creating/pushing the vX.Y.Z release tag"
      echo "  --dry-run        Validate notes and print steps without copying / signing / mutating"
      exit 1 ;;
  esac
  i=$((i + 1))
done

# ── Resolve version ───────────────────────────────────────────────────────────
if [[ -z "$VERSION" ]]; then
  VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])' 2>/dev/null || true)"
fi
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not determine version (try --version=X.Y.Z)" >&2
  exit 1
fi

# ── Resolve modes ─────────────────────────────────────────────────────────────
SIGNED_BROWSER_PKG="$RELEASE_DIR/Interceptor-Browser-${VERSION}.pkg"
SIGNED_FULL_PKG="$RELEASE_DIR/Interceptor-Full-${VERSION}.pkg"

PUBLISH_BROWSER=0
PUBLISH_FULL=0
case "$MODE_FLAG" in
  browser-only) PUBLISH_BROWSER=1 ;;
  full)         PUBLISH_FULL=1 ;;
  "")
    # Auto-detect from disk. Publish whichever pkg(s) exist for this version.
    [[ -f "$SIGNED_BROWSER_PKG" ]] && PUBLISH_BROWSER=1
    [[ -f "$SIGNED_FULL_PKG"    ]] && PUBLISH_FULL=1
    if (( PUBLISH_BROWSER + PUBLISH_FULL == 0 )); then
      echo "ERROR: no .pkg found for version $VERSION in $RELEASE_DIR" >&2
      echo "       Expected one or both of:" >&2
      echo "         $SIGNED_BROWSER_PKG" >&2
      echo "         $SIGNED_FULL_PKG" >&2
      echo "       Run scripts/release.sh first." >&2
      exit 1
    fi
    ;;
esac

if (( PUBLISH_BROWSER )) && [[ ! -f "$SIGNED_BROWSER_PKG" ]]; then
  echo "ERROR: $SIGNED_BROWSER_PKG not found." >&2
  echo "       Run: bash scripts/release.sh --browser-only" >&2
  exit 1
fi
if (( PUBLISH_FULL )) && [[ ! -f "$SIGNED_FULL_PKG" ]]; then
  echo "ERROR: $SIGNED_FULL_PKG not found." >&2
  echo "       Run: bash scripts/release.sh --full" >&2
  exit 1
fi

# Modes summary
MODES_SUMMARY=()
(( PUBLISH_BROWSER )) && MODES_SUMMARY+=("browser-only")
(( PUBLISH_FULL    )) && MODES_SUMMARY+=("full")

echo "==> Publishing v$VERSION to Sparkle (${MODES_SUMMARY[*]})"
if (( DRY_RUN )); then
  echo "==> DRY RUN — appcast.xml not mutated; no files copied."
fi

# ── Step 1: Verify notarization on the .pkg(s) before publishing ──────────────
# Cheap sanity check: a notarization-stripped or bit-rotted pkg shouldn't reach
# the appcast. spctl confirms the stapled notarization is still valid.
echo "==> Step 1: Verifying notarization"
if (( DRY_RUN )); then
  (( PUBLISH_BROWSER )) && echo "    DRY: spctl --assess --type install $SIGNED_BROWSER_PKG"
  (( PUBLISH_FULL    )) && echo "    DRY: spctl --assess --type install $SIGNED_FULL_PKG"
else
  for pkg in $( (( PUBLISH_BROWSER )) && echo "$SIGNED_BROWSER_PKG"; (( PUBLISH_FULL )) && echo "$SIGNED_FULL_PKG"); do
    if ! spctl --assess --type install "$pkg" 2>/dev/null; then
      echo "ERROR: $pkg failed spctl assessment. Re-notarize or re-staple before publishing." >&2
      exit 1
    fi
    if ! xcrun stapler validate "$pkg" >/dev/null 2>&1; then
      echo "ERROR: $pkg failed stapler validate. Re-staple before publishing." >&2
      exit 1
    fi
  done
fi

# ── Step 2: Ensure Sparkle tools are cached ───────────────────────────────────
echo "==> Step 2: Verifying Sparkle $SPARKLE_VERSION tools"
if (( DRY_RUN )); then
  echo "    DRY: ensure $SPARKLE_TOOLS_DIR/bin/sign_update exists"
else
  if [ ! -x "$SPARKLE_TOOLS_DIR/bin/sign_update" ]; then
    echo "    Caching Sparkle $SPARKLE_VERSION tools in $SPARKLE_TOOLS_DIR"
    mkdir -p "$SPARKLE_TOOLS_DIR"
    curl -sSL "https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz" \
      -o "$SPARKLE_TOOLS_DIR/sparkle.tar.xz"
    tar xf "$SPARKLE_TOOLS_DIR/sparkle.tar.xz" -C "$SPARKLE_TOOLS_DIR"
    rm -f "$SPARKLE_TOOLS_DIR/sparkle.tar.xz"
  fi
fi

# ── Step 3: Validate host dir ─────────────────────────────────────────────────
echo "==> Step 3: Validating Sparkle host dir"
if [ ! -d "$SPARKLE_HOST_DIR" ]; then
  echo "ERROR: Sparkle host dir missing at $SPARKLE_HOST_DIR" >&2
  echo "       Set INTERCEPTOR_SPARKLE_HOST_DIR or check out the" >&2
  echo "       Interceptor-Updates-Sparkle project there." >&2
  exit 1
fi
HOST_PUBLIC="$SPARKLE_HOST_DIR/public"
if (( ! DRY_RUN )); then
  mkdir -p "$HOST_PUBLIC"
fi

# ── Step 4: Validate and sign immutable release notes ─────────────────────────
echo "==> Step 4: Validating cumulative release notes"
HOST_APPCAST="$HOST_PUBLIC/appcast.xml" \
RELEASE_NOTES_SOURCE="$RELEASE_NOTES_SOURCE" \
RELEASE_NOTES_TARGET="$VERSION" \
python3 - <<'PY'
import os, re, sys
from collections import Counter
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

class ReleaseSections(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.versions = []

    def handle_starttag(self, tag, attrs):
        if tag == "section" and self.stack and self.stack[-1] == "main":
            version = dict(attrs).get("data-sparkle-version")
            if version is not None:
                self.versions.append(version)
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in self.stack:
            index = len(self.stack) - 1 - self.stack[::-1].index(tag)
            del self.stack[index:]

source = os.environ["RELEASE_NOTES_SOURCE"]
target = os.environ["RELEASE_NOTES_TARGET"]
appcast = os.environ["HOST_APPCAST"]

if not os.path.isfile(source):
    sys.exit(f"ERROR: cumulative release notes missing at {source}")

parser = ReleaseSections()
parser.feed(open(source, encoding="utf-8").read())
versions = parser.versions
invalid = [v for v in versions if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)+", v)]
if invalid:
    sys.exit(f"ERROR: invalid data-sparkle-version value(s): {', '.join(invalid)}")

duplicates = sorted(v for v, count in Counter(versions).items() if count > 1)
if duplicates:
    sys.exit(f"ERROR: duplicate release-note version section(s): {', '.join(duplicates)}")
if target not in versions:
    sys.exit(f"ERROR: release notes have no section for target version {target}")

version_key = lambda v: tuple(int(part) for part in v.split("."))
if versions != sorted(versions, key=version_key, reverse=True):
    sys.exit("ERROR: release-note sections must be ordered newest first")

retained = set()
if os.path.isfile(appcast):
    SP = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
    for item in ET.parse(appcast).getroot().findall("./channel/item"):
        node = item.find(f"{SP}shortVersionString")
        if node is not None and node.text:
            retained.add(node.text.strip())
missing = sorted(retained - set(versions), key=version_key, reverse=True)
if missing:
    sys.exit(f"ERROR: release notes omit retained appcast version(s): {', '.join(missing)}")

print(f"    release notes valid: {len(versions)} unique versions; target {target}; {len(retained)} retained")
PY

RELEASE_NOTES_BASENAME="release-notes-${VERSION}.html"
RELEASE_NOTES_SNAPSHOT="$HOST_PUBLIC/$RELEASE_NOTES_BASENAME"
RELEASE_NOTES_SIG_LINE=""
if (( DRY_RUN )); then
  echo "    DRY: verify or create immutable $RELEASE_NOTES_SNAPSHOT"
  echo "    DRY: sign_update $RELEASE_NOTES_BASENAME once for all mode items"
else
  if [[ -e "$RELEASE_NOTES_SNAPSHOT" ]]; then
    if ! cmp -s "$RELEASE_NOTES_SOURCE" "$RELEASE_NOTES_SNAPSHOT"; then
      echo "ERROR: immutable release-note snapshot differs for version $VERSION" >&2
      exit 1
    fi
  else
    cp "$RELEASE_NOTES_SOURCE" "$RELEASE_NOTES_SNAPSHOT"
  fi
  RELEASE_NOTES_SIG_LINE="$("$SPARKLE_TOOLS_DIR/bin/sign_update" "$RELEASE_NOTES_SNAPSHOT" 2>&1 | tail -1)"
  echo "    $RELEASE_NOTES_SIG_LINE"
fi

# ── Step 5: Per-mode publish ──────────────────────────────────────────────────
# For each pkg: copy, sign_update, mutate appcast.xml. Uses inline Python to
# rewrite appcast.xml so the operation is idempotent — re-publishing the same
# (version, title) replaces the prior <item> instead of duplicating it.
resolve_min_sys_ver() {
  local mode="$1" signed_pkg="$2"
  case "$mode" in
    browser-only)
      echo "11.0"
      ;;
    full)
      local tmpdir expand_dir plist min_ver
      tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/interceptor-sparkle-pkg.XXXXXX")"
      expand_dir="$tmpdir/pkg"
      if ! pkgutil --expand-full "$signed_pkg" "$expand_dir" >/dev/null; then
        rm -rf "$tmpdir"
        return 1
      fi
      plist="$expand_dir/Interceptor-Bridge.pkg/Payload/Applications/interceptor-bridge.app/Contents/Info.plist"
      if [[ ! -f "$plist" ]]; then
        echo "ERROR: Full pkg is missing bridge Info.plist at $plist" >&2
        rm -rf "$tmpdir"
        return 1
      fi
      min_ver="$(plutil -extract LSMinimumSystemVersion raw -o - "$plist" 2>/dev/null || true)"
      rm -rf "$tmpdir"
      if [[ -z "$min_ver" ]]; then
        echo "ERROR: Full pkg bridge Info.plist is missing LSMinimumSystemVersion" >&2
        return 1
      fi
      echo "$min_ver"
      ;;
    *)
      echo "ERROR: unknown mode '$mode'" >&2
      return 1
      ;;
  esac
}

publish_to_sparkle() {
  local mode="$1" signed_pkg="$2" pkg_basename min_sys_ver title sig_line
  pkg_basename="$(basename "$signed_pkg")"
  case "$mode" in
    browser-only) title="Interceptor (Browser-Only) ${VERSION}" ;;
    full)         title="Interceptor (Full) ${VERSION}" ;;
  esac
  min_sys_ver="$(resolve_min_sys_ver "$mode" "$signed_pkg")"

  if (( DRY_RUN )); then
    echo "    DRY: cp $signed_pkg → $HOST_PUBLIC/$pkg_basename"
    echo "    DRY: sign_update + append appcast item ($mode, minSysVer $min_sys_ver, title \"$title\")"
    return 0
  fi

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
  RELEASE_NOTES_URL="${DOWNLOAD_URL_PREFIX}${RELEASE_NOTES_BASENAME}" \
  RELEASE_NOTES_SIG_LINE="$RELEASE_NOTES_SIG_LINE" \
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
release_notes_url = os.environ["RELEASE_NOTES_URL"]
release_notes_sig_line = os.environ["RELEASE_NOTES_SIG_LINE"].strip()

# sign_update output line looks like:
#   sparkle:edSignature="..." length="..."
m = re.search(r'sparkle:edSignature="([^"]+)"\s+length="([0-9]+)"', sig_line)
if not m:
    print(f"ERROR: could not parse sign_update output: {sig_line}", file=sys.stderr)
    sys.exit(1)
ed_sig, length = m.group(1), m.group(2)
notes_match = re.search(r'sparkle:edSignature="([^"]+)"\s+length="([0-9]+)"', release_notes_sig_line)
if not notes_match:
    print(f"ERROR: could not parse release-note sign_update output: {release_notes_sig_line}", file=sys.stderr)
    sys.exit(1)
notes_sig, notes_length = notes_match.group(1), notes_match.group(2)

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
ET.SubElement(item, f"{SP}channel").text = mode
ET.SubElement(item, f"{SP}releaseNotesLink", {
    f"{SP}edSignature": notes_sig,
    "length": notes_length,
}).text = release_notes_url
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

echo "==> Step 5: Per-mode publish"
(( PUBLISH_BROWSER )) && publish_to_sparkle "browser-only" "$SIGNED_BROWSER_PKG"
(( PUBLISH_FULL    )) && publish_to_sparkle "full"         "$SIGNED_FULL_PKG"

# ── Step 6: Deploy host (optional) ────────────────────────────────────────────
echo "==> Step 6: Deploying update host"
if (( ! DEPLOY )); then
  echo "    --no-deploy passed; appcast.xml updated locally, deploy skipped."
  echo "    To deploy manually, push $HOST_PUBLIC/ to your update host."
elif (( DRY_RUN )); then
  echo "    DRY: rwh up --service interceptor-updates --detach (if rwh on PATH)"
elif command -v rwh >/dev/null 2>&1; then
  echo "    Running: rwh up --service interceptor-updates --detach"
  (cd "$SPARKLE_HOST_DIR" && rwh up --service interceptor-updates --detach 2>&1 | tail -5) || \
    echo "    WARN: rwh up exited non-zero — appcast may not be live" >&2
else
  echo "    WARN: rwh CLI not on PATH — push $HOST_PUBLIC manually to deploy." >&2
fi

# ── Step 7: Tag the release ───────────────────────────────────────────────────
# The Windows installer lane (windows-installer.yml) builds ONLY on a pushed
# vX.Y.Z tag whose version equals package.json. Tagging here — at the moment a
# macOS version goes public — is what keeps macOS and Windows on the same
# version. 0.22.36/0.22.37 shipped untagged, so that lane never fired for them.
echo "==> Step 7: Tagging release v${VERSION}"
if (( ! TAG )); then
  echo "    --no-tag passed; skipping. The Windows release lane will NOT fire for ${VERSION}."
elif (( DRY_RUN )); then
  echo "    DRY: git tag -a v${VERSION} && git push origin v${VERSION}"
else
  HEAD_PKG_VERSION="$(git show HEAD:package.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || true)"
  if [[ "$HEAD_PKG_VERSION" != "$VERSION" ]]; then
    echo "ERROR: HEAD's package.json says '${HEAD_PKG_VERSION}' but you are publishing '${VERSION}'." >&2
    echo "       Check out the release commit (or pass --no-tag to skip tagging)." >&2
    exit 1
  fi
  if EXISTING="$(git rev-parse -q --verify "refs/tags/v${VERSION}^{commit}")"; then
    if [[ "$EXISTING" == "$(git rev-parse HEAD)" ]]; then
      echo "    Tag v${VERSION} already exists at HEAD; ensuring it is pushed."
      git push origin "v${VERSION}" || { echo "ERROR: tag push failed" >&2; exit 1; }
    else
      echo "ERROR: tag v${VERSION} exists at ${EXISTING}, which is not HEAD. Versions are immutable — bump instead." >&2
      exit 1
    fi
  else
    git tag -a "v${VERSION}" -m "Release ${VERSION}" || { echo "ERROR: tag creation failed" >&2; exit 1; }
    git push origin "v${VERSION}" || { echo "ERROR: tag push failed — Windows lane will not fire until it is pushed" >&2; exit 1; }
    echo "    Tagged and pushed v${VERSION} (Windows lane fires from this tag once its workflow is on main)."
  fi
fi

echo "================================================================"
echo "Sparkle publish complete:"
echo "  feed:   ${DOWNLOAD_URL_PREFIX}appcast.xml"
echo "  notes:  ${DOWNLOAD_URL_PREFIX}${RELEASE_NOTES_BASENAME}"
(( PUBLISH_BROWSER )) && echo "  browser: ${DOWNLOAD_URL_PREFIX}Interceptor-Browser-${VERSION}.pkg"
(( PUBLISH_FULL    )) && echo "  full:    ${DOWNLOAD_URL_PREFIX}Interceptor-Full-${VERSION}.pkg"
if (( DRY_RUN )); then
  echo ""
  echo "DRY-RUN complete — no changes made."
fi
echo "================================================================"
