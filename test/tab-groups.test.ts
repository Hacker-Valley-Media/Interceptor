import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GROUP_LABEL_RE, groupTitleFor, colorForLabel, namedGroups, serializeGroupAdd } from "../extension/src/background/tab-group"
import { VALID_COLORS } from "../extension/src/background/brand-tab-group"
import {
  GROUP_LABEL_RE as CLI_GROUP_LABEL_RE,
  parseGroupFlag,
  resolveGroupScope,
  deriveSessionGroupLabel,
  resolveSessionId,
} from "../cli/parse"
import { setGlobalGroup, withGroup } from "../cli/transport"
import { buildFilteredArgs } from "../cli/global-flags"
import { managedTabGateError, resolveGroupDispatchScope } from "../extension/src/background/message-dispatch"

// tab-group.ts is module-load side-effect-free (no `chrome.*` at import time — the
// MV2 transitive-bundle constraint), so its pure helpers are unit-testable here.

describe("tab groups: group label validation", () => {
  test("valid labels pass", () => {
    for (const l of ["ai134", "a", "A-b_c", "x".repeat(32)]) {
      expect(GROUP_LABEL_RE.test(l)).toBe(true)
    }
  })

  test("invalid labels fail", () => {
    for (const l of ["", "has space", "x".repeat(33), "emoji🙂", "a/b", "a.b"]) {
      expect(GROUP_LABEL_RE.test(l)).toBe(false)
    }
  })

  test("extension and CLI enforce the identical label grammar", () => {
    expect(CLI_GROUP_LABEL_RE.source).toBe(GROUP_LABEL_RE.source)
  })
})

describe("tab groups: group title composition + color", () => {
  test("title composes brand + label (default brand is 'interceptor')", () => {
    expect(groupTitleFor("ai134")).toBe("interceptor-ai134")
  })

  test("colorForLabel is deterministic and always a valid Chrome color", () => {
    for (const l of ["ai134", "ai7", "research", "zz"]) {
      const c1 = colorForLabel(l)
      const c2 = colorForLabel(l)
      expect(c1).toBe(c2)
      expect(VALID_COLORS as readonly string[]).toContain(c1)
    }
  })
})

describe("tab groups: concurrent group creation is serialized per label (stress-test regression)", () => {
  test("N concurrent adds for one label run strictly sequentially", async () => {
    // Without serialization, 9 parallel opens over 3 labels minted 9 duplicate
    // groups in the live stress test. The op chain must never interleave.
    let running = 0
    let maxRunning = 0
    const op = async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise(r => setTimeout(r, 5))
      running--
      return 42
    }
    const results = await Promise.all(
      Array.from({ length: 6 }, () => serializeGroupAdd("stress-label", op))
    )
    expect(maxRunning).toBe(1)
    expect(results).toEqual([42, 42, 42, 42, 42, 42])
  })

  test("different labels do not serialize against each other", async () => {
    let running = 0
    let maxRunning = 0
    const op = async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise(r => setTimeout(r, 5))
      running--
      return 1
    }
    await Promise.all([serializeGroupAdd("l1", op), serializeGroupAdd("l2", op)])
    expect(maxRunning).toBe(2)
  })

  test("a rejected op does not wedge the chain", async () => {
    const boom = () => Promise.reject(new Error("boom"))
    await expect(serializeGroupAdd("l3", boom)).rejects.toThrow("boom")
    await expect(serializeGroupAdd("l3", async () => 7)).resolves.toBe(7)
  })
})

describe("tab groups: CLI global flags", () => {
  test("--group and --group-color (with values) are stripped from filtered args", () => {
    expect(buildFilteredArgs(["open", "https://x", "--group", "ai1"])).toEqual(["open", "https://x"])
    expect(buildFilteredArgs(["open", "https://x", "--group-color", "purple"])).toEqual(["open", "https://x"])
    expect(buildFilteredArgs(["group", "close", "ai1"])).toEqual(["group", "close", "ai1"])
  })

  test("parseGroupFlag: flag wins over INTERCEPTOR_GROUP env; env is the fallback", () => {
    expect(parseGroupFlag(["open", "--group", "flagged"], { INTERCEPTOR_GROUP: "fromenv" })).toBe("flagged")
    expect(parseGroupFlag(["open"], { INTERCEPTOR_GROUP: "fromenv" })).toBe("fromenv")
    expect(parseGroupFlag(["open"], {})).toBeUndefined()
  })

  test("automatic scope: every verified harness gets an opaque per-session group", () => {
    // Bare `open` from an agent shell must land in a per-session named group so
    // the extension's policy reuse engages (it is deliberately excluded from
    // the shared default group) and the idle sweep bounds the session's tabs.
    for (const key of [
      "INTERCEPTOR_SESSION_ID",
      "MAESTRO_COWORKING_SESSION_ID",
      "CLAUDE_CODE_SESSION_ID",
      "CODEX_SESSION_ID",
      "CODEX_THREAD_ID",
    ]) {
      const scope = resolveGroupScope(["open"], { [key]: "00000000-1111-4222-8333-444444444444" })
      expect(scope.label).toMatch(/^s-[0-9a-f]{16}$/)
      expect(scope.soft).toBe(true)
      expect(CLI_GROUP_LABEL_RE.test(scope.label!)).toBe(true)
      expect(resolveGroupScope(["read"], { [key]: "00000000-1111-4222-8333-444444444444" }).label)
        .toBe(scope.label)
    }
  })

  test("automatic labels use SHA-256 over the whole id and disclose none of it", () => {
    // A sanitized-prefix scheme collapses `local_<uuid>` ids to two
    // discriminating characters; the hash must keep them distinct.
    const a = deriveSessionGroupLabel("local_c1ec3b94-1843-4b5e-9c66-000000000001")
    const b = deriveSessionGroupLabel("local_a9ff1122-0000-4b5e-9c66-000000000002")
    expect(deriveSessionGroupLabel("abc")).toBe("s-ba7816bf8f01cfea")
    expect(a).toMatch(/^s-[0-9a-f]{16}$/)
    expect(b).toMatch(/^s-[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
    // Hostile characters cannot reach the label (hash output is hex-only)…
    const hostile = "a!b@c#d$e%f^g&h*"
    expect(deriveSessionGroupLabel(hostile)).toMatch(/^s-[0-9a-f]{16}$/)
    expect(deriveSessionGroupLabel(hostile)).not.toContain(hostile)
    // …and an empty id derives nothing.
    expect(deriveSessionGroupLabel("")).toBeUndefined()
    expect(parseGroupFlag(["open"], { INTERCEPTOR_SESSION_ID: "" })).toBeUndefined()
  })

  test("neutral and verified host session variables use documented precedence", () => {
    const env = {
      INTERCEPTOR_SESSION_ID: "neutral",
      MAESTRO_COWORKING_SESSION_ID: "maestro",
      CLAUDE_CODE_SESSION_ID: "claude",
      CODEX_SESSION_ID: "codex",
      CODEX_THREAD_ID: "thread",
    }
    expect(resolveSessionId(env)).toBe("neutral")
    expect(resolveSessionId({ ...env, INTERCEPTOR_SESSION_ID: "" })).toBe("maestro")
    expect(resolveSessionId({ CLAUDE_CODE_SESSION_ID: "claude", CODEX_SESSION_ID: "codex" })).toBe("claude")
    expect(resolveSessionId({ CODEX_SESSION_ID: "", CODEX_THREAD_ID: "thread" })).toBe("thread")
    expect(resolveSessionId({})).toBeUndefined()
  })

  test("explicit group inputs and shared opt-outs beat automatic session scope", () => {
    const env = { INTERCEPTOR_SESSION_ID: "session", INTERCEPTOR_GROUP: "fromenv" }
    expect(resolveGroupScope(["open", "--group", "flagged"], env)).toEqual({ label: "flagged", soft: false })
    expect(resolveGroupScope(["open"], env)).toEqual({ label: "fromenv", soft: false })
    expect(resolveGroupScope(["open", "--shared-group"], env)).toEqual({ label: undefined, soft: false })
    expect(resolveGroupScope(["open"], { INTERCEPTOR_SESSION_ID: "session", INTERCEPTOR_GROUP: "" }))
      .toEqual({ label: undefined, soft: false })
    expect(resolveGroupScope(["open"], {})).toEqual({ label: undefined, soft: false })
  })

  test("--shared-group conflicts with an explicit --group", () => {
    const realExit = process.exit
    const realError = console.error
    try {
      process.exit = ((code?: number) => { throw new Error(`__exit_${code}`) }) as never
      console.error = () => {}
      expect(() => resolveGroupScope(["open", "--shared-group", "--group", "lane-1"], {}))
        .toThrow("__exit_1")
    } finally {
      process.exit = realExit
      console.error = realError
    }
  })

  test("group-looking values after the option terminator remain literal", () => {
    const env = { INTERCEPTOR_SESSION_ID: "session" }
    const expected = deriveSessionGroupLabel("session")
    expect(resolveGroupScope(["type", "e1", "--", "--shared-group"], env))
      .toEqual({ label: expected, soft: true })
    expect(resolveGroupScope(["type", "e1", "--", "--group", "literal"], env))
      .toEqual({ label: expected, soft: true })
  })

  test("wire shape: an automatic label carries groupSoft; explicit and MCP labels do not", () => {
    setGlobalGroup("s-ba7816bf8f01cfea", undefined, true)
    expect(withGroup({ type: "tab_create" })).toEqual({ type: "tab_create", group: "s-ba7816bf8f01cfea", groupSoft: true })
    setGlobalGroup("explicit", undefined, false)
    expect(withGroup({ type: "tab_create" })).toEqual({ type: "tab_create", group: "explicit" })
    // An action that already carries a group is never overridden or marked.
    setGlobalGroup("s-ba7816bf8f01cfea", undefined, true)
    expect(withGroup({ type: "tab_create", group: "mine" })).toEqual({ type: "tab_create", group: "mine" })
    setGlobalGroup(undefined, undefined, false)
  })

  test("--shared-group is stripped from filtered args; --group '' still errors", () => {
    expect(buildFilteredArgs(["open", "https://x", "--shared-group"])).toEqual(["open", "https://x"])
    // `--group` with a missing/flag-shaped value exits 1 — pinned via the regex
    // (an empty label must never pass the label gate).
    expect(CLI_GROUP_LABEL_RE.test("")).toBe(false)
  })
})

describe("tab groups: dispatch scope behavior", () => {
  test("automatic groups are soft; explicit groups are hard by default", () => {
    expect(resolveGroupDispatchScope({ group: "s-ba7816bf8f01cfea", groupSoft: true }))
      .toEqual({ label: "s-ba7816bf8f01cfea", soft: true, hard: false })
    expect(resolveGroupDispatchScope({ group: "lane-1" }))
      .toEqual({ label: "lane-1", soft: false, hard: true })
    expect(resolveGroupDispatchScope({ group: "lane-1", anyTab: true }))
      .toEqual({ label: "lane-1", soft: false, hard: false })
    expect(resolveGroupDispatchScope({ groupSoft: true }))
      .toEqual({ label: undefined, soft: false, hard: false })
  })

  test("liveness stamp uses the tab-activity predicate for BOTH named and default groups", () => {
    // A session heartbeating `status` must not pin its group past the sweep.
    expect(dispatchSrc).toContain('if (needsTab(action.type) || action.type === "tab_create") recordGroupActivity(groupLabel ?? "")')
  })

  test("rejected membership checks happen before the liveness stamp", () => {
    expect(dispatchSrc.lastIndexOf("managedTabGateError(")).toBeLessThan(dispatchSrc.indexOf("recordGroupActivity(groupLabel"))
  })

  test("a stale explicit hard-group tab becomes a prompt actionable error", async () => {
    const savedChrome = globalThis.chrome
    namedGroups.set("stale", 71)
    globalThis.chrome = {
      tabs: { get: async () => { throw new Error("No tab with id: 999999999") } },
      tabGroups: {
        get: async () => ({ id: 71, title: "interceptor-stale" }),
        query: async () => [],
      },
      storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    } as unknown as typeof chrome
    try {
      const error = await managedTabGateError(999999999, "stale", true)
      expect(error).toContain("tab 999999999 is unavailable")
      expect(error).toContain("interceptor tabs --group stale")
    } finally {
      globalThis.chrome = savedChrome
      namedGroups.delete("stale")
    }
  })
})

// Source assertions (the brand-tab-group.test.ts precedent): lock in the
// structural guarantees the feature's acceptance criteria depend on.

const root = join(import.meta.dir, "..")
const dispatchSrc = readFileSync(join(root, "extension", "src", "background", "message-dispatch.ts"), "utf-8")
const tabsSrc = readFileSync(join(root, "extension", "src", "background", "capabilities", "tabs.ts"), "utf-8")
const routerSrc = readFileSync(join(root, "extension", "src", "background", "router.ts"), "utf-8")
const noTabSrc = readFileSync(join(root, "extension", "src", "background", "no-tab-actions.ts"), "utf-8")

describe("tab groups: dispatch never falls back to the browser-active tab for grouped requests", () => {
  test("grouped resolution errors out instead of reaching the active-tab query", () => {
    // The grouped branch must terminate (fail + return) before the ungrouped
    // active-tab fallback runs — the fallback is the cross-agent bleed.
    const groupedBlock = dispatchSrc.indexOf("needsTab(action.type) && groupLabel")
    const activeFallback = dispatchSrc.indexOf("query({ active: true, currentWindow: true })")
    expect(groupedBlock).toBeGreaterThan(-1)
    expect(activeFallback).toBeGreaterThan(groupedBlock)
    expect(dispatchSrc).toContain("has no tabs — open one with")
  })

  test("per-group auto-target key derives from the label", () => {
    expect(dispatchSrc).toContain('group ? `activeTabId:${group}` : "activeTabId"')
  })

  test("gate scopes to the caller's group when a label is present", () => {
    expect(dispatchSrc).toContain("isTabInNamedGroup(tabId, groupLabel!)")
    expect(dispatchSrc).toContain("isTabInAnyManagedGroup(tabId)")
  })

  test("auto-target persists only AFTER the gate — a rejected cross-group request must not poison the key", () => {
    const gateIdx = dispatchSrc.indexOf("is not in group")
    const setIdx = dispatchSrc.lastIndexOf("setActiveTabId(tabId, groupLabel)")
    expect(gateIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeGreaterThan(gateIdx)
  })

  test("stored per-group target is validated for MEMBERSHIP, not mere existence", () => {
    expect(dispatchSrc).toContain("stillInGroup = await isTabInNamedGroup(tabId, groupLabel!)")
  })
})

describe("tab groups: group_close is one atomic tabs.remove over the group's own ids", () => {
  test("handler exists and uses a single chrome.tabs.remove(ids)", () => {
    const closeCase = tabsSrc.slice(tabsSrc.indexOf('case "group_close"'))
    expect(closeCase.length).toBeGreaterThan(10)
    const body = closeCase.slice(0, closeCase.indexOf("case ", 10))
    expect(body).toContain("chrome.tabs.remove(ids)")
    expect((body.match(/chrome\.tabs\.remove/g) || []).length).toBe(1)
    expect(body).not.toContain("chrome.windows.remove")
  })
})

describe("tab groups: new actions are registered everywhere they must be", () => {
  test("router TAB_ACTIONS", () => {
    expect(routerSrc).toContain('"group_list"')
    expect(routerSrc).toContain('"group_close"')
  })

  test("NO_TAB_ACTIONS (a tabless verb dies with 'no active tab' otherwise)", () => {
    expect(noTabSrc).toContain('"group_list"')
    expect(noTabSrc).toContain('"group_close"')
  })

  test("reuse path is group-scoped in tab_create", () => {
    expect(tabsSrc).toContain("group ? await ensureNamedGroup(group) : await ensureInterceptorGroup()")
  })
})
