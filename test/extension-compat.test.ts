import { describe, expect, test } from "bun:test"
import { claimContextId, describeContexts, recordExtensionIdentity, type ContextSocket } from "../daemon/context-registration"
import { staleExtensionHintLine } from "../cli/commands/diagnose"

// The daemon never refuses an extension for its version, and when
// an older copy answers "unknown action type" the CLI names the copy-specific fix.
const PREFIXES = { runtime: "runtime:", cdp: "cdp:", ios: "ios:" }

describe("older extensions keep working against a newer daemon", () => {
  test("a 0.24.x registration (version only) and a pre-0.24 one (context only) register unchanged", () => {
    const map = new Map<string, ContextSocket>()
    const v0242: ContextSocket = { send: () => {} }
    recordExtensionIdentity(v0242, { version: "0.24.2" })
    const ancient: ContextSocket = { send: () => {} }
    recordExtensionIdentity(ancient, {})
    expect(claimContextId(map, v0242, "store-copy").status).toBe("registered")
    expect(claimContextId(map, ancient, "ancient").status).toBe("registered")
    expect(describeContexts(["store-copy", "ancient"], (c) => map.get(c), PREFIXES, "gomcpnagjjlhehnkoobkjgnkbleiooed")).toEqual([
      { contextId: "store-copy", kind: "extension", version: "0.24.2" },
      { contextId: "ancient", kind: "extension" },
    ])
  })

  test("unknown-action hint: generic when the copy is unknown, copy-specific when known", () => {
    const generic = staleExtensionHintLine("0.25.0")
    expect(generic).toContain("older than this CLI (0.25.0)")
    expect(generic).toContain("interceptor reload")
    expect(generic).toContain("Chrome Web Store copy")
    expect(generic).toContain("interceptor diagnose")

    const store = staleExtensionHintLine("0.25.0", { contextId: "main", version: "0.24.2", installType: "normal" })
    expect(store).toContain("store extension 0.24.2 is older than this CLI (0.25.0)")
    expect(store).toContain("interceptor reload --context main")
    expect(store).toContain("unpacked copy")

    const dev = staleExtensionHintLine("0.25.0", { contextId: "main", version: "0.24.2", installType: "development" })
    expect(dev).toContain("unpacked extension 0.24.2 is older than this CLI (0.25.0)")
    expect(dev).toContain("interceptor reload --context main")
    expect(dev).not.toContain("Chrome Web Store")

    // Version known, copy unknown (0.24.x extension): still copy-agnostic reload advice.
    const versionOnly = staleExtensionHintLine("0.25.0", { contextId: "main", version: "0.24.2" })
    expect(versionOnly).toContain("unknown copy extension 0.24.2")
    expect(versionOnly).toContain("interceptor reload --context main")
  })
})
