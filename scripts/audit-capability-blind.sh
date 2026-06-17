#!/usr/bin/env bash
# Capability-blind audit gate.
#
# Fails (exit 1) if the tracked tree carries any relocated hardened-target
# managed-copy specifics, if the shipped skills describe a relocated capability,
# or if the core network-fetches an extension. Run by CI and locally:
#
#   bash scripts/audit-capability-blind.sh
#
# Covers the full rung-4 token set across the bridge + agent + cli/ surface.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { printf 'audit: %s\n' "$*"; }

# 1) Relocated rung-4 (hardened-target managed-copy) specifics must be absent
#    from the tracked core (bridge + agent + cli + shared).
PATTERN='resignAndLaunch|--catch-launch|--capability-continuity|REPLAYED|capabilityContinuity|catchLaunch|preservePlugins|dumpEntitlements|restorePlugins|stripContainerQuarantine|nativeSigningIdentity|INTERCEPTOR_ENTITLEMENT_CONTINUITY|INTERCEPTOR_CATCH_LAUNCH_EXC|INTERCEPTOR_ENTITLEMENTS_PLIST|managed copy re-sign'
if rg -n "$PATTERN" interceptor-bridge/Sources interceptor-agent/Sources cli shared -S 2>/dev/null; then
  note "FAIL: relocated hardened-target managed-copy specifics found in the tracked core (see above)"
  fail=1
else
  note "ok: tracked core carries no relocated managed-copy specifics"
fi

# 2) Shipped skills carry only a neutral extension pointer — no capability
#    specifics.
if rg -n "re-sign|entitlement continuity|capability continuity|managed copy|managed-copy" .agents/skills -S 2>/dev/null; then
  note "FAIL: shipped skills describe relocated capability specifics (see above)"
  fail=1
else
  note "ok: shipped skills carry only a neutral extension pointer"
fi

# 3) The core never network-fetches an extension — discovery is filesystem-only.
if rg -n 'fetch\(|https?://|curl|download' cli daemon shared --glob '!**/*.test.ts' -S 2>/dev/null | rg -i 'extension' 2>/dev/null; then
  note "FAIL: extension-related network fetch found in the core (see above)"
  fail=1
else
  note "ok: no network fetch of extensions in the core"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "CAPABILITY-BLIND AUDIT FAILED"
  exit 1
fi
echo "CAPABILITY-BLIND AUDIT PASSED"
