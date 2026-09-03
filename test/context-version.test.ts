import { describe, expect, test } from "bun:test"
import { claimContextId, describeContexts, type ContextSocket } from "../daemon/context-registration"
import { extensionVersionMismatchLine } from "../cli/commands/diagnose"

// Issue #241: the daemon records the manifest version each extension registers
// with; `contexts` (verbose) exposes it; `diagnose` flags a stale snapshot.
const PREFIXES = { runtime: "runtime:", cdp: "cdp:", ios: "ios:" }

describe("context descriptions carry the registered extension version (issue #241)", () => {
  test("describeContexts keeps ids, classifies kinds, and adds version only when known", () => {
    const map = new Map<string, ContextSocket>()
    const ext: ContextSocket = { send: () => {}, __version: "0.23.38" }
    const old: ContextSocket = { send: () => {} }
    claimContextId(map, ext, "main")
    claimContextId(map, old, "legacy")
    claimContextId(map, { send: () => {} }, "runtime:Finder")
    const out = describeContexts(["main", "legacy", "runtime:Finder", "cdp:slack", "ios:0000"], (c) => map.get(c), PREFIXES)
    expect(out).toEqual([
      { contextId: "main", kind: "extension", version: "0.23.38" },
      { contextId: "legacy", kind: "extension" },
      { contextId: "runtime:Finder", kind: "runtime" },
      { contextId: "cdp:slack", kind: "cdp" },
      { contextId: "ios:0000", kind: "ios" },
    ])
  })

  test("mismatch line only when the extension reported a version that differs from the CLI", () => {
    expect(extensionVersionMismatchLine("main", undefined, "0.23.38")).toBeNull()
    expect(extensionVersionMismatchLine("main", "0.23.38", "0.23.38")).toBeNull()
    const line = extensionVersionMismatchLine("main", "0.23.33", "0.23.38")
    expect(line).toContain("extension snapshot 0.23.33 ≠ CLI 0.23.38")
    expect(line).toContain("interceptor reload --context main")
  })
})
