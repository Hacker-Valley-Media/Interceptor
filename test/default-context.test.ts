// A default context the person names, used only when a
// call names no context and several extension contexts are connected.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyDefaultContext, validateContextRouting } from "../daemon/outbound-routing"
import { readDefaultContext, setDefaultContext, userConfigPath } from "../shared/user-config"

describe("default context routing", () => {
  test("applies only with no context and several connected", () => {
    expect(applyDefaultContext(undefined, "work", ["work", "home"])).toEqual({ contextId: "work", fromDefault: true })
    expect(applyDefaultContext("home", "work", ["work", "home"])).toEqual({ contextId: "home", fromDefault: false })
    expect(applyDefaultContext(undefined, "work", ["home"])).toEqual({ contextId: undefined, fromDefault: false })
    expect(applyDefaultContext(undefined, undefined, ["work", "home"])).toEqual({ contextId: undefined, fromDefault: false })
  })

  test("a connected default routes; a disconnected one is named", () => {
    expect(validateContextRouting({ contextId: "work", fromDefault: true, connectedContexts: ["work", "home"], nativeRelayAvailable: false })).toEqual({ ok: true })
    const gone = validateContextRouting({ contextId: "gone", fromDefault: true, connectedContexts: ["work", "home"], nativeRelayAvailable: false })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.error).toContain("your saved default context 'gone' is not connected")
  })

  test("the ambiguity error names the default command", () => {
    const r = validateContextRouting({ connectedContexts: ["a", "b"], nativeRelayAvailable: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("interceptor contexts default <name>")
  })
})

describe("config file", () => {
  test("INTERCEPTOR_CONFIG moves the file; other keys survive; clear removes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ic-config-"))
    const path = join(dir, "nested", "config.json")
    expect(userConfigPath({ INTERCEPTOR_CONFIG: path })).toBe(path)
    expect(readDefaultContext(path)).toBeUndefined()
    setDefaultContext("work", path)
    expect(readDefaultContext(path)).toBe("work")
    writeFileSync(path, JSON.stringify({ defaultContext: "work", other: 1 }))
    setDefaultContext(undefined, path)
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ other: 1 })
  })

  test("a broken file reads as no default", () => {
    const dir = mkdtempSync(join(tmpdir(), "ic-config-"))
    const path = join(dir, "config.json")
    writeFileSync(path, "{not json")
    expect(readDefaultContext(path)).toBeUndefined()
  })
})
