#!/usr/bin/env bash
# Build the InterceptorAgent dylib for the arm64 and arm64e slices.
# The SymbolLinkageMarkers flag (for the __mod_init_func entry) comes from
# Package.swift swiftSettings, so a plain `swift build --triple <t>` is enough.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
OUT="${1:-$HERE/dist}"
mkdir -p "$OUT"

build_slice() {
  local triple="$1"; local name="$2"
  local arch="${triple%%-*}"   # arm64 | arm64e | x86_64
  echo "==> building agent ($name / $triple)"
  if ! swift build -c release --triple "$triple" 2>"$OUT/build-$name.log"; then
    echo "    !! $name slice failed (see $OUT/build-$name.log)"
    return 1
  fi
  # Pick the REAL product dylib — anchored on .../release/libInterceptorAgent.dylib,
  # excluding the dSYM's inner DWARF file (also named libInterceptorAgent.dylib,
  # but Mach-O type MH_DSYM, which dyld refuses to load). Disambiguate by arch
  # dir ("/arm64-" never matches "/arm64e-").
  local lib
  lib="$(find .build -path '*release/libInterceptorAgent.dylib' ! -path '*.dSYM*' 2>/dev/null | grep "/${arch}-apple" | head -1)"
  [ -z "$lib" ] && lib="$(find .build -path '*release/libInterceptorAgent.dylib' ! -path '*.dSYM*' 2>/dev/null | head -1)"
  if [ -z "$lib" ]; then
    echo "    !! built but product dylib not found (see $OUT/build-$name.log)"
    return 1
  fi
  cp "$lib" "$OUT/InterceptorAgent-$name.dylib"
  # Guard: must be a real DYLIB, never a dSYM.
  if ! otool -hv "$OUT/InterceptorAgent-$name.dylib" 2>/dev/null | awk 'NR>=2 && /DYLIB/{found=1} END{exit found?0:1}'; then
    local ft
    ft="$(otool -hv "$OUT/InterceptorAgent-$name.dylib" 2>/dev/null | awk 'NR==4{print $5}')"
    echo "    !! copied file is not a DYLIB (filetype=$ft) — aborting"
    rm -f "$OUT/InterceptorAgent-$name.dylib"
    return 1
  fi
  echo "    -> $OUT/InterceptorAgent-$name.dylib  ($(cd "$(dirname "$lib")" && pwd)/$(basename "$lib"))"
}

build_slice "arm64-apple-macosx12.0" "arm64" || true
build_slice "arm64e-apple-macosx12.0" "arm64e" || echo "    (arm64e optional — needs a toolchain that targets arm64e)"

echo "==> agent dylibs:"
for d in "$OUT"/InterceptorAgent-*.dylib; do
  [ -f "$d" ] || continue
  printf "    %s  [%s]\n" "$d" "$(otool -hv "$d" 2>/dev/null | awk 'NR==4{print $5}')"
done
