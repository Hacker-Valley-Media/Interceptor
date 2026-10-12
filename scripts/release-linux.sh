#!/bin/bash
# Build browser archives, optionally including experimental native payloads.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${INTERCEPTOR_VERSION:-$(grep -E '"version"' package.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')}"
RELEASE_DIR="$REPO_ROOT/dist/release/linux"
STAGE_ROOT="$RELEASE_DIR/staging"
ARCHES=(x64 arm64)
MODES=(Browser)
MODE_FLAG=''
NATIVE_ROOT="${INTERCEPTOR_DESKTOP_LINUX_PAYLOAD_ROOT:-$REPO_ROOT/interceptor-desktop/target/linux-packages}"
SIGN_IDENTITY=''
for arg in "$@"; do
  case "$arg" in
    --full) [[ "$MODE_FLAG" != browser-only ]] || { echo "Conflicting archive modes." >&2; exit 1; }; MODE_FLAG=full; MODES=(Browser Full) ;;
    --browser-only) [[ "$MODE_FLAG" != full ]] || { echo "Conflicting archive modes." >&2; exit 1; }; MODE_FLAG=browser-only; MODES=(Browser) ;;
    --arch=x64) ARCHES=(x64) ;;
    --arch=arm64) ARCHES=(arm64) ;;
    --sign-identity=*) [[ -z "$SIGN_IDENTITY" ]] || { echo 'Repeated signing identity.' >&2; exit 1; }; SIGN_IDENTITY="${arg#*=}"; [[ -n "$SIGN_IDENTITY" ]] || { echo 'Empty --sign-identity value.' >&2; exit 1; } ;;
    *) echo "Usage: release-linux.sh [--full|--browser-only] [--arch=x64|--arch=arm64] [--sign-identity=<keychain identity or certificate SHA-1>]" >&2; exit 1 ;;
  esac
done
# The signing identity comes from --sign-identity or INTERCEPTOR_LINUX_SIGN_IDENTITY. verify-release-manifest.sh
# still pins the public signer certificate, so a different identity fails verification below.
SIGN_IDENTITY="${SIGN_IDENTITY:-${INTERCEPTOR_LINUX_SIGN_IDENTITY:-}}"
if [[ -z "$SIGN_IDENTITY" && "${MODES[*]}" == *Full* ]]; then
  echo 'No signing identity (--sign-identity or INTERCEPTOR_LINUX_SIGN_IDENTITY): Full archives are unsigned validation builds.' >&2
fi
if [[ -n "$SIGN_IDENTITY" ]]; then
  [[ "$(uname -s)" == Darwin ]] || { echo 'Signed Linux releases are signed with a macOS keychain identity; run this on macOS.' >&2; exit 1; }
  SIGN_TASK="$(mktemp -d "${TMPDIR:-/tmp}/interceptor-linux-sign.XXXXXXXX")"
  trap 'rm -rf "$SIGN_TASK"' EXIT
  swiftc "$SCRIPT_DIR/sign-release-manifest.swift" -o "$SIGN_TASK/sign-release-manifest"
  "$SIGN_TASK/sign-release-manifest" "$RELEASE_DIR/SHA256SUMS" "$RELEASE_DIR/SHA256SUMS.cms" "$SIGN_IDENTITY" --inspect > "$SIGN_TASK/identity.json"
  codesign --force --sign "$SIGN_IDENTITY" --timestamp --options runtime "$SIGN_TASK/sign-release-manifest"
fi
if [[ "${MODES[*]}" == *Full* ]]; then
  PACKAGE_VERSION="$(grep -E '"version"' package.json | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
  [[ "$VERSION" == "$PACKAGE_VERSION" ]] || { echo "Full archive version must match package.json." >&2; exit 1; }
  for arch in "${ARCHES[@]}"; do
    provider="$NATIVE_ROOT/$arch/interceptor-desktop"
    [[ -f "$provider" ]] || { echo "Native Linux $arch provider missing: $provider" >&2; exit 1; }
    # The overlay helper (WebKitGTK, gtk-layer-shell) is optional; the provider never links them.
    for payload in "$provider" "$NATIVE_ROOT/$arch/interceptor-overlay"; do
      [[ "$payload" == "$provider" || -f "$payload" ]] || continue
      header="$(od -An -v -tx1 -N6 "$payload" | tr -d ' \n')"
      machine="$(od -An -v -tx1 -j18 -N2 "$payload" | tr -d ' \n')"
      expected=3e00; [[ "$arch" == arm64 ]] && expected=b700
      [[ "$header" == 7f454c460201 && "$machine" == "$expected" ]] || { echo "Native payload ${payload##*/} is not a little-endian 64-bit Linux ELF for $arch." >&2; exit 1; }
      # Both binaries report the version they were built as (CARGO_PKG_VERSION); it must be this release.
      bun "$SCRIPT_DIR/provider-version.ts" "$payload" "$VERSION"
    done
    if [[ -e "$NATIVE_ROOT/$arch/engines" || -L "$NATIVE_ROOT/$arch/engines" ]]; then
      bun "$SCRIPT_DIR/stage-desktop-engines.ts" --check "$NATIVE_ROOT/$arch/engines" linux "$arch"
    fi
    pointer="$NATIVE_ROOT/$arch/hyprland"
    if [[ -e "$pointer" || -L "$pointer" ]]; then
      [[ -d "$pointer" && ! -L "$pointer" && -f "$pointer/manifest.json" && ! -L "$pointer/manifest.json" ]] || { echo "Incomplete or linked compositor payload." >&2; exit 1; }
      bun -e '
        import {readFileSync, readdirSync, lstatSync} from "node:fs";
        import {createHash} from "node:crypto";
        const [directory, architecture] = process.argv.slice(1);
        const manifestBytes=readFileSync(directory+"/manifest.json");
        if(manifestBytes.length>1024*1024) throw Error("Compositor manifest exceeds 1 MB");
        const m=JSON.parse(manifestBytes.toString());
        if(/"\/(home|Users|root)\//.test(manifestBytes.toString())) throw Error("Compositor manifest names a build-host home folder; rebuild it with scripts/build-hyprland-pointer.ts");
        if(!/^[0-9a-f]{64}$/.test(m.payloadSHA256) || m.payload!==`interceptor-pointer-${m.payloadSHA256}.so` || !lstatSync(directory+"/"+m.payload).isFile()) throw Error("Unbound compositor payload path");
        const b=readFileSync(directory+"/"+m.payload);
        if(readdirSync(directory).sort().join(",")!==m.payload+",manifest.json" ||
          m.schemaVersion!==1 || m.protocolVersion!==4 || m.platform!=="linux" || m.architecture!==architecture ||
          m.hyprlandVersion!=="0.56.1" || m.hyprlandCommit!=="5c9377c15f85c50648f35ca5a213754f95b93ca0" ||
          m.compiler!=="16.1.1" || m.waylandVersion!=="1.26.0" || typeof m.hyprlandABIHash!=="string" || !m.hyprlandABIHash ||
          b.length>16*1024*1024 || m.payloadBytes!==b.length ||
          b.length<20 || b.subarray(0,6).toString("hex")!=="7f454c460201" || b.readUInt16LE(18)!==(architecture==="arm64"?183:62) ||
          createHash("sha256").update(b).digest("hex")!==m.payloadSHA256) throw Error("Compositor payload qualification or digest mismatch");
      ' "$pointer" "$arch"
    fi
  done
fi

BUILD_TARGET=linux
[[ "${#ARCHES[@]}" != 1 ]] || BUILD_TARGET="linux-${ARCHES[0]}"
bash "$REPO_ROOT/scripts/build.sh" --target="$BUILD_TARGET"
rm -rf "$RELEASE_DIR"
mkdir -p "$STAGE_ROOT"

for arch in "${ARCHES[@]}"; do
 for mode in "${MODES[@]}"; do
  suffix=''; [[ "$mode" != Full || -n "$SIGN_IDENTITY" ]] || suffix=-unsigned-validation
  name="Interceptor-$mode-$VERSION-linux-$arch$suffix"
  stage="$STAGE_ROOT/$name"
  mkdir -p "$stage/dist" "$stage/daemon" "$stage/extension" "$stage/scripts"
  cp "$REPO_ROOT/dist/linux/$arch/interceptor" "$stage/dist/interceptor"
  cp "$REPO_ROOT/dist/linux/$arch/daemon/interceptor-daemon" "$stage/daemon/interceptor-daemon"
  cp "$REPO_ROOT/daemon/com.interceptor.host.json" "$stage/daemon/com.interceptor.host.json"
  cp -R "$REPO_ROOT/extension/dist/." "$stage/extension/dist"
  cp "$REPO_ROOT/scripts/install.sh" "$stage/scripts/install.sh"
  cp "$REPO_ROOT/scripts/uninstall.sh" "$stage/scripts/uninstall.sh"
  cp "$REPO_ROOT/scripts/install-desktop-linux.sh" "$stage/scripts/install-desktop-linux.sh"
  # Agent skills sit beside the CLI, where `interceptor skills` looks for its pack. build.sh wrote
  # the Linux copies (scripts/gen-skills.ts).
  mkdir "$stage/dist/skills"
  for skill in interceptor interceptor-browser interceptor-research; do cp -R "$REPO_ROOT/dist/linux/$arch/skills/$skill" "$stage/dist/skills/$skill"; done
  if [[ "$mode" == Full ]]; then
    # The native-app skill ships only with the provider it describes.
    cp -R "$REPO_ROOT/dist/linux/$arch/skills/interceptor-desktop" "$stage/dist/skills/interceptor-desktop"
    cp "$REPO_ROOT/interceptor-desktop/THIRD-PARTY-NOTICES.txt" "$stage/THIRD-PARTY-NOTICES.txt"
    cp "$NATIVE_ROOT/$arch/interceptor-desktop" "$stage/dist/interceptor-desktop"
    chmod 755 "$stage/dist/interceptor-desktop"
    if [[ -f "$NATIVE_ROOT/$arch/interceptor-overlay" ]]; then
      cp "$NATIVE_ROOT/$arch/interceptor-overlay" "$stage/dist/interceptor-overlay"
      chmod 755 "$stage/dist/interceptor-overlay"
    fi
    if [[ -d "$NATIVE_ROOT/$arch/engines" ]]; then
      bun "$SCRIPT_DIR/stage-desktop-engines.ts" "$NATIVE_ROOT/$arch/engines" linux "$arch" "$stage/dist/engines"
    fi
    if [[ -d "$NATIVE_ROOT/$arch/hyprland" ]]; then
      mkdir -m 700 "$stage/dist/hyprland"
      payload_name="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).payload)' "$NATIVE_ROOT/$arch/hyprland/manifest.json")"
      cp "$NATIVE_ROOT/$arch/hyprland/manifest.json" "$NATIVE_ROOT/$arch/hyprland/$payload_name" "$stage/dist/hyprland/"
      chmod 600 "$stage/dist/hyprland/manifest.json" "$stage/dist/hyprland/$payload_name"
    fi
    mkdir -p "$stage/docs"
    cp "$REPO_ROOT/docs/desktop-bridge.md" "$stage/docs/desktop-bridge.md"
    signature=unsigned; [[ -z "$SIGN_IDENTITY" ]] || signature=cms-sha256-detached
    printf '{"mode":"full","status":"experimental","completeParity":false,"signature":"%s","providerVersionCheck":"required-at-install"}\n' "$signature" > "$stage/DESKTOP-INSTALL.json"
  fi
  cp "$REPO_ROOT/README.md" "$REPO_ROOT/LICENSE" "$REPO_ROOT/package.json" "$stage/"
  printf '%s\n' "$VERSION" > "$stage/VERSION"
  chmod 755 "$stage/dist/interceptor" "$stage/daemon/interceptor-daemon" "$stage/scripts/install.sh" "$stage/scripts/uninstall.sh" "$stage/scripts/install-desktop-linux.sh"
  # Neutral ownership: the archive does not carry the build account's name or ids.
  COPYFILE_DISABLE=1 tar --no-xattrs --owner=root:0 --group=root:0 -czf "$RELEASE_DIR/$name.tar.gz" -C "$STAGE_ROOT" "$name"
 done
done

(cd "$RELEASE_DIR" && shasum -a 256 Interceptor-*.tar.gz > SHA256SUMS)
rm -rf "$STAGE_ROOT"
if [[ -n "$SIGN_IDENTITY" ]]; then
  "$SIGN_TASK/sign-release-manifest" "$RELEASE_DIR/SHA256SUMS" "$RELEASE_DIR/SHA256SUMS.cms" "$SIGN_IDENTITY" > "$RELEASE_DIR/SIGNATURE.json"
  cp "$SCRIPT_DIR/verify-release-manifest.sh" "$SCRIPT_DIR/linux-release-apple-root.pem" "$RELEASE_DIR/"
  cp "$SIGN_TASK/identity.json" "$RELEASE_DIR/SIGNER-IDENTITY.json"
  bash "$SCRIPT_DIR/verify-release-manifest.sh" "$RELEASE_DIR"
fi

echo "Linux archives (Full parity remains operation-specific):"
ls -lh "$RELEASE_DIR"/Interceptor-*.tar.gz "$RELEASE_DIR/SHA256SUMS"
