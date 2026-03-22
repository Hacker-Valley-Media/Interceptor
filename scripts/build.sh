#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Building extension..."
bun build extension/src/background.ts --outdir=extension/dist --target=browser
bun build extension/src/content.ts --outdir=extension/dist --target=browser
cp extension/manifest.json extension/dist/
cp extension/offscreen.html extension/dist/
cp extension/offscreen.js extension/dist/

echo "Building CLI..."
bun build cli/index.ts --compile --outfile=dist/slop

echo "Build complete."
echo "  Extension: extension/dist/"
echo "  CLI:       dist/slop"
