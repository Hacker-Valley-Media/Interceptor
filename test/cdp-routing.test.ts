import { describe, expect, test } from "bun:test"
import { validateContextRouting } from "../daemon/outbound-routing"

describe("validateContextRouting with CDP-app contexts", () => {
  test("explicit cdp context id is accepted", () => {
    expect(validateContextRouting({
      contextId: "cdp:slack", connectedContexts: [], nativeRelayAvailable: false, cdpContexts: ["cdp:slack"],
    }).ok).toBe(true)
  })

  test("no --context, zero extensions, one cdp context → guides to --context", () => {
    const r = validateContextRouting({ connectedContexts: [], nativeRelayAvailable: false, cdpContexts: ["cdp:slack"] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("cdp:slack")
  })

  test("single extension context still routes without --context", () => {
    expect(validateContextRouting({ connectedContexts: ["abc"], nativeRelayAvailable: false }).ok).toBe(true)
  })

  test("multiple extension contexts require --context", () => {
    const r = validateContextRouting({ connectedContexts: ["a", "b"], nativeRelayAvailable: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("--context")
  })

  test("unknown context id is rejected and the hint lists known contexts", () => {
    const r = validateContextRouting({
      contextId: "cdp:nope", connectedContexts: ["a"], nativeRelayAvailable: false, cdpContexts: ["cdp:slack"],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("cdp:slack")
  })

  test("zero extensions but native relay present is still OK (existing behavior preserved)", () => {
    expect(validateContextRouting({ connectedContexts: [], nativeRelayAvailable: true }).ok).toBe(true)
  })
})
