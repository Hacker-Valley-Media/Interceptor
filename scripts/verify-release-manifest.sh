#!/bin/bash
set -euo pipefail
# Portable CMS verification for Linux archives. The pinned existing HVM leaf
# binds the signer. Apple roots validate expiry and the issuer chain. OpenSSL
# does not understand Apple's critical Developer ID marker, so its generic
# critical-extension check is disabled only alongside this exact leaf pin.
[[ $# == 1 || $# == 2 ]] || { echo 'Usage: verify-release-manifest.sh release-directory [expected-certificate-SHA256]' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")" && pwd)"
RELEASE="$(cd "$1" && pwd)"
EXPECTED="${2:-660fb2654b040d9f57f209a59c2717bf60ec0f7428c4ae1d5a7df40695ed6860}"
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid trusted signer fingerprint.' >&2; exit 1; }
for file in SHA256SUMS SHA256SUMS.cms; do
 [[ -f "$RELEASE/$file" && ! -L "$RELEASE/$file" && "$(wc -c < "$RELEASE/$file")" -le 1048576 ]] || { echo 'Missing, linked or oversized release manifest/signature.' >&2; exit 1; }
done
TASK_VERIFY="$(mktemp -d "${TMPDIR:-/tmp}/interceptor-release-verify.XXXXXXXX")"
trap 'rm -rf "$TASK_VERIFY"' EXIT
if ! openssl cms -verify -binary -inform DER -in "$RELEASE/SHA256SUMS.cms" -content "$RELEASE/SHA256SUMS" -purpose any -ignore_critical -CAfile "$ROOT/linux-release-apple-root.pem" -signer "$TASK_VERIFY/signer.pem" -out "$TASK_VERIFY/manifest"; then
 echo 'Release signature or certificate chain verification failed.' >&2
 exit 1
fi
[[ "$(awk '/BEGIN CERTIFICATE/{count++}END{print count+0}' "$TASK_VERIFY/signer.pem")" == 1 ]] || { echo 'Release must have exactly one signer.' >&2; exit 1; }
ACTUAL="$(openssl x509 -in "$TASK_VERIFY/signer.pem" -noout -fingerprint -sha256 | sed 's/.*=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
[[ "$ACTUAL" == "$EXPECTED" ]] || { echo 'Release signer fingerprint does not match the trusted identity.' >&2; exit 1; }
cmp -s "$RELEASE/SHA256SUMS" "$TASK_VERIFY/manifest" || { echo 'Verified manifest bytes changed.' >&2; exit 1; }
ARCHIVES=0
SEEN='|'
while read -r digest name; do
 [[ "$digest" =~ ^[0-9a-f]{64}$ && "$name" =~ ^Interceptor-(Browser|Full)-[A-Za-z0-9.+-]+-linux-(arm64|x64)(-unsigned-validation)?[.]tar[.]gz$ ]] || { echo 'Invalid archive record in signed manifest.' >&2; exit 1; }
 [[ -f "$RELEASE/$name" && ! -L "$RELEASE/$name" ]] || { echo 'Missing or linked release archive.' >&2; exit 1; }
 case "$SEEN" in *"|$name|"*) echo 'Duplicate archive record.' >&2; exit 1;; esac
 SEEN="$SEEN$name|"
 ARCHIVES=$((ARCHIVES+1))
 [[ "$ARCHIVES" -le 8 ]] || { echo 'Too many archive records.' >&2; exit 1; }
done < "$TASK_VERIFY/manifest"
[[ "$ARCHIVES" -gt 0 ]] || { echo 'Signed manifest contains no archives.' >&2; exit 1; }
if command -v sha256sum >/dev/null; then
 (cd "$RELEASE" && sha256sum -c SHA256SUMS)
else
 (cd "$RELEASE" && shasum -a 256 -c SHA256SUMS)
fi
echo "Verified $ARCHIVES archives from pinned HVM signing identity $EXPECTED."
