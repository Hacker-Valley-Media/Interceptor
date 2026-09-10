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

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R extension/dist/. "$STAGE/"
bun -e '
const fs = require("fs"); const p = process.argv[1]
const m = JSON.parse(fs.readFileSync(p, "utf8")); delete m.key
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n")
' "$STAGE/manifest.json"

mkdir -p dist
OUT="$PWD/dist/Interceptor-Extension-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qr -X "$OUT" . -x '.DS_Store' '*/.DS_Store')

# Self-check: the uploaded manifest must not carry the development key.
if unzip -p "$OUT" manifest.json | grep -q '"key"'; then
  echo "store zip still contains manifest#key" >&2; exit 1
fi
echo "$OUT ($(du -h "$OUT" | cut -f1), $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files)"
