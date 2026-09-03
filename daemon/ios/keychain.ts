/**
 * daemon/ios/keychain.ts — macOS Keychain store for the Apple-ID session token
 *
 * We NEVER persist the Apple-ID password and NEVER put the session/refresh token
 * in `state.json`. Interceptor authenticates directly to Apple (signer.ts) and
 * stashes only the resulting token here, in the login keychain.
 *
 * issue #244: the store moved from `/usr/bin/security add-generic-password -w`
 * (the value rode argv, visible to `ps`) to `Bun.secrets`, which talks to
 * Keychain Services in-process. Items written by the old path are read once
 * through `security` and migrated on first load.
 *
 * A generic-password item keyed by (service, account). One active account, so the
 * default account label is fine; callers may pass a specific account (e.g. the
 * Apple-ID email or team id) to keep multiple around.
 */

import { spawnSync } from "node:child_process"

const SECURITY = "/usr/bin/security"
const DEFAULT_SERVICE = "com.interceptor.ios.appleid"
const DEFAULT_ACCOUNT = "default"

export type KeychainRef = { service?: string; account?: string }

function svc(ref?: KeychainRef): string { return ref?.service ?? DEFAULT_SERVICE }
function acct(ref?: KeychainRef): string { return ref?.account ?? DEFAULT_ACCOUNT }

/** Store (or replace) a secret. Bun.secrets.set replaces an existing item in place. */
export async function storeToken(token: string, ref?: KeychainRef): Promise<{ ok: boolean; error?: string }> {
  try {
    await Bun.secrets.set({ service: svc(ref), name: acct(ref), value: token })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message || "keychain write failed" }
  }
}

/** Legacy item written by `security add-generic-password` before issue #244. */
function loadLegacyToken(ref?: KeychainRef): string | undefined {
  const r = spawnSync(SECURITY, ["find-generic-password", "-s", svc(ref), "-a", acct(ref), "-w"], { encoding: "utf-8" })
  if (r.status !== 0) return undefined
  const out = (r.stdout ?? "").replace(/\n$/, "")
  return out.length ? out : undefined
}

function deleteLegacyToken(ref?: KeychainRef): void {
  spawnSync(SECURITY, ["delete-generic-password", "-s", svc(ref), "-a", acct(ref)], { encoding: "utf-8" })
}

/** Load the secret, or undefined if there is none. Migrates a legacy item once. */
export async function loadToken(ref?: KeychainRef): Promise<string | undefined> {
  try {
    const v = await Bun.secrets.get({ service: svc(ref), name: acct(ref) })
    if (typeof v === "string" && v.length) return v
  } catch {}
  const legacy = loadLegacyToken(ref)
  if (legacy === undefined) return undefined
  const stored = await storeToken(legacy, ref)
  if (stored.ok) deleteLegacyToken(ref)
  return legacy
}

/** Remove the secret. Returns ok even if it was already absent. */
export async function deleteToken(ref?: KeychainRef): Promise<{ ok: boolean; error?: string }> {
  try { await Bun.secrets.delete({ service: svc(ref), name: acct(ref) }) } catch {}
  deleteLegacyToken(ref)
  return { ok: true }
}

export async function hasToken(ref?: KeychainRef): Promise<boolean> {
  return (await loadToken(ref)) !== undefined
}
