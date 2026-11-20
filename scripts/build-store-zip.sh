#!/usr/bin/env bash
# Build the Chrome Web Store upload zip from extension/dist.
#
# The store signs the package with its own key (the same key pinned in
# extension/manifest.json since 0.25.0, so the ID stays
# gomcpnagjjlhehnkoobkjgnkbleiooed) and rejects uploads that carry `key`, so it
# is stripped here. Run by scripts/release.sh after the pkgs; upload steps are
# in docs/chrome-web-store.md §7.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f extension/dist/manifest.json ]] || { echo "extension/dist missing; run scripts/build.sh first" >&2; exit 1; }
VERSION=$(sed -nE 's/.*"version": *"([^"]+)".*/\1/p' extension/dist/manifest.json | head -1)

mkdir -p dist
STAGE=$(mktemp -d "$PWD/dist/.store-zip.XXXXXXXX")
trap 'rm -rf "$STAGE"' EXIT
cp -R extension/dist "$STAGE/extension"
bun -e '
const fs = require("fs"); const p = process.argv[1]
const m = JSON.parse(fs.readFileSync(p, "utf8")); delete m.key
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n")
' "$STAGE/extension/manifest.json"

OUT="$PWD/dist/Interceptor-Extension-$VERSION.zip"
(cd "$STAGE/extension" && zip -qr -X "$STAGE/store.zip" . -x '.DS_Store' '*/.DS_Store')

# Verify the actual archive before replacing the last good zip.
unzip -q "$STAGE/store.zip" -d "$STAGE/check"
if grep -q '"key"' "$STAGE/check/manifest.json"; then
  echo "store zip still contains manifest#key" >&2; exit 1
fi
bun scripts/check-extension-code.ts "$STAGE/check"
mv -f "$STAGE/store.zip" "$OUT"
echo "$OUT ($(du -h "$OUT" | cut -f1), $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files)"
