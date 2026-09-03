/**
 * test/secrets-gate.test.ts — issue #244 release gate with a fake vault + fake
 * auth transport. Order of checks: metadata → target → gate → keychain read.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lock, openUnlock, resolveSecret, storeSecret, type Vault } from "../daemon/secrets"

const dir = mkdtempSync(join(tmpdir(), "interceptor-gate-"))
const metaPath = join(dir, "secrets.json")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fakeVault(): Vault & { reads: number } {
  const store = new Map<string, string>()
  const v = {
    backend: "fake", reads: 0,
    set: async (n: string, val: string) => { store.set(n, val) },
    get: async (n: string) => { v.reads++; return store.get(n) ?? null },
    delete: async (n: string) => store.delete(n),
  }
  return v
}

describe("release gate", () => {
  test("gate: none releases without a prompt; the keychain is read once", async () => {
    const vault = fakeVault()
    await storeSecret(vault, "plain", "v1", { metaPath })
    let prompts = 0
    const res = await resolveSecret(vault, "plain", { kind: "ios" }, { gate: async () => { prompts++; return { ok: true } }, metaPath })
    expect(res.value).toBe("v1")
    expect(prompts).toBe(0)
    expect(vault.reads).toBe(1)
  })

  test("gate: touchid prompts with a reason naming secret, target, session; refusal reads nothing", async () => {
    const vault = fakeVault()
    await storeSecret(vault, "gated", "v2", { gate: "touchid", targets: "macos:com.apple.SecurityAgent", reuseSeconds: 30, metaPath })
    const seen: Array<{ reason: string; policy: string; reuseSeconds: number }> = []
    await expect(resolveSecret(vault, "gated", { kind: "macos", id: "com.apple.SecurityAgent" }, {
      gate: async (a) => { seen.push(a); return { ok: false, error: "user cancelled" } }, session: "ci-42", metaPath,
    })).rejects.toMatchObject({ code: "gate_denied", message: "user cancelled" })
    expect(vault.reads).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].reason).toContain('"gated"')
    expect(seen[0].reason).toContain("com.apple.SecurityAgent")
    expect(seen[0].reason).toContain("ci-42")
    expect(seen[0].policy).toBe("any")
    expect(seen[0].reuseSeconds).toBe(30)

    const ok = await resolveSecret(vault, "gated", { kind: "macos", id: "com.apple.SecurityAgent" }, { gate: async () => ({ ok: true }), metaPath })
    expect(ok.value).toBe("v2")
    expect(ok.gated).toBe(true)
  })

  test("target check runs before the gate", async () => {
    const vault = fakeVault()
    await storeSecret(vault, "scoped", "v3", { gate: "touchid", targets: "sudo", metaPath })
    let prompts = 0
    await expect(resolveSecret(vault, "scoped", { kind: "browser", id: "example.com" }, { gate: async () => { prompts++; return { ok: true } }, metaPath }))
      .rejects.toMatchObject({ code: "target_denied" })
    expect(prompts).toBe(0)
  })

  test("an open unlock window skips the prompt; lock closes it", async () => {
    const vault = fakeVault()
    await storeSecret(vault, "win", "v4", { gate: "touchid", metaPath })
    let prompts = 0
    const gate = async () => { prompts++; return { ok: true } }
    openUnlock("win", 60)
    const a = await resolveSecret(vault, "win", { kind: "sudo" }, { gate, metaPath })
    expect(a.value).toBe("v4"); expect(a.gated).toBe(false); expect(prompts).toBe(0)
    lock("win")
    const b = await resolveSecret(vault, "win", { kind: "sudo" }, { gate, metaPath })
    expect(b.gated).toBe(true); expect(prompts).toBe(1)
  })

  test("biometry gate asks for the biometry-only policy", async () => {
    const vault = fakeVault()
    await storeSecret(vault, "bio", "v5", { gate: "biometry", metaPath })
    let policy = ""
    await resolveSecret(vault, "bio", { kind: "sudo" }, { gate: async (a) => { policy = a.policy; return { ok: true } }, metaPath })
    expect(policy).toBe("biometry")
  })

  test("reveal is always gated, even for gate: none, and ignores targets", async () => {
    const vault = fakeVault()
    await storeSecret(vault, "rv", "v6", { targets: "sudo", metaPath })
    let prompts = 0
    const res = await resolveSecret(vault, "rv", { kind: "reveal" }, { gate: async () => { prompts++; return { ok: true } }, metaPath })
    expect(res.value).toBe("v6")
    expect(prompts).toBe(1)
  })

  test("metadata without a keychain item is reported, not crashed", async () => {
    const vault = fakeVault()
    await storeSecret(vault, "ghost", "v7", { metaPath })
    await vault.delete("ghost")
    await expect(resolveSecret(vault, "ghost", { kind: "any" }, { gate: async () => ({ ok: true }), metaPath })).rejects.toMatchObject({ code: "not_found" })
  })
})
