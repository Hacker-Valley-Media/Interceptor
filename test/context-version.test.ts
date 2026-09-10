import { describe, expect, test } from "bun:test"
import { claimContextId, describeContexts, recordExtensionIdentity, type ContextSocket } from "../daemon/context-registration"
import { extensionVersionMismatchLine, legacyDevelopmentCopyLine } from "../cli/commands/diagnose"

const STORE_ID = "gomcpnagjjlhehnkoobkjgnkbleiooed"

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

// The store install and the unpacked copy share one ID; installType
// tells them apart, and the native flag follows the relay Chrome spawned.
describe("context descriptions carry the extension copy identity", () => {
  test("identity fields ride along; malformed values are dropped; 0.24.x shape still registers", () => {
    const map = new Map<string, ContextSocket>()
    const store: ContextSocket = { send: () => {} }
    recordExtensionIdentity(store, { version: "0.25.0", extensionId: STORE_ID, installType: "normal" })
    const unpacked: ContextSocket = { send: () => {} }
    recordExtensionIdentity(unpacked, { version: "0.25.0", extensionId: STORE_ID, installType: "development" })
    const old: ContextSocket = { send: () => {} }
    recordExtensionIdentity(old, { version: "0.24.2" })
    const junk: ContextSocket = { send: () => {} }
    recordExtensionIdentity(junk, { extensionId: "not-an-id", installType: "weird", version: 7 })
    claimContextId(map, store, "store")
    claimContextId(map, unpacked, "dev")
    claimContextId(map, old, "old")
    claimContextId(map, junk, "junk")

    expect(describeContexts(["store", "dev", "old", "junk"], (c) => map.get(c), PREFIXES, STORE_ID)).toEqual([
      { contextId: "store", kind: "extension", version: "0.25.0", extensionId: STORE_ID, installType: "normal", native: true },
      { contextId: "dev", kind: "extension", version: "0.25.0", extensionId: STORE_ID, installType: "development", native: true },
      { contextId: "old", kind: "extension", version: "0.24.2" },
      { contextId: "junk", kind: "extension" },
    ])
    // No relay registered → no native flag; a relay for another ID → no flag either.
    expect(describeContexts(["store"], (c) => map.get(c), PREFIXES)[0].native).toBeUndefined()
    expect(describeContexts(["store"], (c) => map.get(c), PREFIXES, "hkjbaciefhhgekldhncknbjkofbpenng")[0].native).toBeUndefined()
  })

  test("mismatch remediation follows the copy: reload for unpacked, store update for store", () => {
    expect(extensionVersionMismatchLine("main", "0.24.2", "0.25.0", "development")).toContain("interceptor reload --context main")
    expect(extensionVersionMismatchLine("main", "0.24.2", "0.25.0", "development")).not.toContain("Chrome Web Store")
    const store = extensionVersionMismatchLine("main", "0.24.2", "0.25.0", "normal")!
    expect(store).toContain("Chrome Web Store copy")
    expect(store).toContain("interceptor reload --context main")
    expect(store).toContain("unpacked copy")
    expect(extensionVersionMismatchLine("main", "0.25.0", "0.25.0", "normal")).toBeNull()
  })

  test("a version-only pre-0.25.0 copy is told its reload changes the ID and empties settings", () => {
    const line = extensionVersionMismatchLine("main", "0.24.13", "0.25.0")!
    expect(line).toContain("interceptor reload --context main")
    expect(line).toContain("predates the store identity")
    expect(line).toContain("interceptor contexts rename main")
    // Same version but the copy is known: no pre-store guidance.
    expect(extensionVersionMismatchLine("main", "0.24.13", "0.25.0", "development")).not.toContain("predates")
    // A post-store version-only copy (unknown host without chrome.management): plain text.
    expect(extensionVersionMismatchLine("main", "0.25.0", "0.25.1")).not.toContain("predates")
  })

  test("the pre-store development copy is named, the store ID is not", () => {
    expect(legacyDevelopmentCopyLine("x", STORE_ID)).toBeNull()
    expect(legacyDevelopmentCopyLine("x", undefined)).toBeNull()
    const line = legacyDevelopmentCopyLine("legacy", "hkjbaciefhhgekldhncknbjkofbpenng")!
    expect(line).toContain("pre-store development copy")
    expect(line).toContain("interceptor contexts rename legacy")
  })
})
