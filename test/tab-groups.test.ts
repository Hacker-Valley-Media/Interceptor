import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GROUP_LABEL_RE, groupTitleFor, colorForLabel, serializeGroupAdd } from "../extension/src/background/tab-group"
import { VALID_COLORS } from "../extension/src/background/brand-tab-group"
import { GROUP_LABEL_RE as CLI_GROUP_LABEL_RE, parseGroupFlag, resolveGroupScope, deriveSessionGroupLabel } from "../cli/parse"
import { setGlobalGroup, withGroup } from "../cli/transport"
import { buildFilteredArgs } from "../cli/global-flags"

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

  test("derivation: agent sessions derive a per-session group from CLAUDE_CODE_SESSION_ID", () => {
    // Bare `open` from an agent shell must land in a per-session named group so
    // the extension's policy reuse engages (it is deliberately excluded from
    // the shared default group) and the idle sweep bounds the session's tabs.
    const scope = resolveGroupScope(["open"], { CLAUDE_CODE_SESSION_ID: "00000000-1111-4222-8333-444444444444" })
    expect(scope.label).toMatch(/^s-[0-9a-f]{8}$/)
    expect(scope.derived).toBe(true)
    expect(CLI_GROUP_LABEL_RE.test(scope.label!)).toBe(true)
    // Deterministic: the same session always maps to the same label.
    expect(resolveGroupScope(["read"], { CLAUDE_CODE_SESSION_ID: "00000000-1111-4222-8333-444444444444" }).label)
      .toBe(scope.label)
  })

  test("derivation hashes the WHOLE id — format-prefixed ids must stay distinct (entropy, not a prefix)", () => {
    // A sanitized-prefix scheme collapses `local_<uuid>` ids to two
    // discriminating characters; the hash must keep them distinct.
    const a = deriveSessionGroupLabel("local_c1ec3b94-1843-4b5e-9c66-000000000001")
    const b = deriveSessionGroupLabel("local_a9ff1122-0000-4b5e-9c66-000000000002")
    expect(a).toMatch(/^s-[0-9a-f]{8}$/)
    expect(b).toMatch(/^s-[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
    // Hostile characters cannot reach the label (hash output is hex-only)…
    expect(deriveSessionGroupLabel("a!b@c#d$e%f^g&h*")).toMatch(/^s-[0-9a-f]{8}$/)
    // …and an empty id derives nothing.
    expect(deriveSessionGroupLabel("")).toBeUndefined()
    expect(parseGroupFlag(["open"], { CLAUDE_CODE_SESSION_ID: "" })).toBeUndefined()
  })

  test("derivation loses to the flag, INTERCEPTOR_GROUP, and --no-group; explicit scopes are never marked derived", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "00000000-1111-4222-8333-444444444444", INTERCEPTOR_GROUP: "fromenv" }
    expect(resolveGroupScope(["open", "--group", "flagged"], env)).toEqual({ label: "flagged", derived: false })
    expect(resolveGroupScope(["open"], env)).toEqual({ label: "fromenv", derived: false })
    expect(resolveGroupScope(["open", "--no-group"], { CLAUDE_CODE_SESSION_ID: "00000000-1111-4222-8333-444444444444" }))
      .toEqual({ label: undefined, derived: false })
  })

  test("INTERCEPTOR_GROUP set-but-empty opts out of derivation (default group)", () => {
    expect(resolveGroupScope(["open"], { CLAUDE_CODE_SESSION_ID: "00000000-1111-4222-8333-444444444444", INTERCEPTOR_GROUP: "" }))
      .toEqual({ label: undefined, derived: false })
  })

  test("wire shape: a derived label reaches the action as group + groupDerived; explicit labels carry no marker", () => {
    setGlobalGroup("s-deadbeef", undefined, true)
    expect(withGroup({ type: "tab_create" })).toEqual({ type: "tab_create", group: "s-deadbeef", groupDerived: true })
    setGlobalGroup("explicit", undefined, false)
    expect(withGroup({ type: "tab_create" })).toEqual({ type: "tab_create", group: "explicit" })
    // An action that already carries a group is never overridden or marked.
    setGlobalGroup("s-deadbeef", undefined, true)
    expect(withGroup({ type: "tab_create", group: "mine" })).toEqual({ type: "tab_create", group: "mine" })
    setGlobalGroup(undefined, undefined, false)
  })

  test("--no-group is stripped from filtered args; --group '' still errors (no silent empty label)", () => {
    expect(buildFilteredArgs(["open", "https://x", "--no-group"])).toEqual(["open", "https://x"])
    // `--group` with a missing/flag-shaped value exits 1 — pinned via the regex
    // (an empty label must never pass the label gate).
    expect(CLI_GROUP_LABEL_RE.test("")).toBe(false)
  })
})

describe("tab groups: derived scope is soft in dispatch (source assertions)", () => {
  test("derived flag exists and is consulted by the three gates", () => {
    expect(dispatchSrc).toContain('action.groupDerived === true')
    // empty-group hard fail bypassed for derived scope and --any-tab
    expect(dispatchSrc).toContain("!groupDerived && !action.anyTab")
    // membership gate: strict only for explicit groups
    expect(dispatchSrc).toContain("groupLabel && !groupDerived")
  })

  test("liveness stamp uses the tab-activity predicate for BOTH named and default groups", () => {
    // A session heartbeating `status` must not pin its group past the sweep.
    expect(dispatchSrc).toContain('if (needsTab(action.type) || action.type === "tab_create") recordGroupActivity(groupLabel ?? "")')
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
    expect(dispatchSrc).toContain("isTabInNamedGroup(tabId, groupLabel)")
    expect(dispatchSrc).toContain("isTabInAnyManagedGroup(tabId)")
  })

  test("auto-target persists only AFTER the gate — a rejected cross-group request must not poison the key", () => {
    const gateIdx = dispatchSrc.indexOf("is not in group")
    const setIdx = dispatchSrc.lastIndexOf("setActiveTabId(tabId, groupLabel)")
    expect(gateIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeGreaterThan(gateIdx)
  })

  test("stored per-group target is validated for MEMBERSHIP, not mere existence", () => {
    expect(dispatchSrc).toContain("stillInGroup = await isTabInNamedGroup(tabId, groupLabel)")
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
