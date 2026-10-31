// A soft session's input never falls back to the
// user's tab, and a session cannot close another session's group or tabs.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  softFallbackError,
  softFallbackNote,
  foreignSessionCloseError,
  SESSION_LABEL_RE,
} from "../extension/src/background/message-dispatch"
import { READ_ACTIONS, TAB_FREE_ACTIONS, isReadAction } from "../extension/src/background/read-actions"
import { deriveSessionGroupLabel } from "../cli/parse"

const root = join(import.meta.dir, "..")
const dispatchSrc = readFileSync(join(root, "extension/src/background/message-dispatch.ts"), "utf-8")
const contentSrc = readFileSync(join(root, "extension/src/content.ts"), "utf-8")
const routerSrc = readFileSync(join(root, "extension/src/background/router.ts"), "utf-8")
const me = deriveSessionGroupLabel("session-a")!
const other = deriveSessionGroupLabel("session-b")!

describe("soft fallback refuses input, keeps reads", () => {
  test("reads fall back with a note naming the tab", () => {
    for (const type of ["get_a11y_tree", "extract_text", "screenshot", "net_log", "find_element", "wait_stable"]) {
      expect(softFallbackError(type, me, 42, "example.com")).toBeNull()
    }
    expect(softFallbackNote(42, "example.com")).toContain("reading the active tab 42 (example.com)")
  })

  test("input and unknown types refuse and name the way out", () => {
    for (const type of ["click", "input_text", "send_keys", "evaluate", "navigate", "tab_close", "file_upload", "submit_form", "some_future_action"]) {
      const err = softFallbackError(type, me, 42, "example.com")
      expect(err).toContain(`your session group '${me}' has no tabs`)
      expect(err).toContain("interceptor open <url>")
      expect(err).toContain("--any-tab")
    }
  })

  test("every read type is a real action type", () => {
    const known = (t: string) => contentSrc.includes(`"${t}"`) || routerSrc.includes(`"${t}"`)
    for (const type of READ_ACTIONS) expect(known(type), type).toBe(true)
    expect(isReadAction("click")).toBe(false)
  })

  test("verbs that never use the tab keep working in an empty session", () => {
    for (const type of TAB_FREE_ACTIONS) expect(routerSrc.includes(`"${type}"`), type).toBe(true)
    for (const type of ["click", "input_text", "evaluate", "navigate", "search_query"]) expect(TAB_FREE_ACTIONS.has(type), type).toBe(false)
  })

  test("the refusal runs before the membership gate, only for soft callers with tab groups", () => {
    const refusal = dispatchSrc.indexOf("softFallbackError(action.type")
    expect(refusal).toBeGreaterThan(dispatchSrc.indexOf("query({ active: true, currentWindow: true })"))
    expect(refusal).toBeLessThan(dispatchSrc.indexOf("managedTabGateError(tabId, groupLabel, groupHard)"))
    expect(dispatchSrc).toContain("if (tabId && groupSoft && hasTabGroupApi())")
    expect(dispatchSrc).toContain("if (action.anyTab !== true && !TAB_FREE_ACTIONS.has(action.type)) {")
  })

  test("a fallback tab is never saved as the session's target, even under --any-tab", () => {
    // Found in live validation: an --any-tab call saved the user's tab, and the
    // next plain click reached it through the stored-target path.
    expect(dispatchSrc).toContain("if (tabId && !switchBack && !softFallbackTab && action.keepTarget !== true) setActiveTabId(tabId, groupLabel)")
    const fallbackBlock = dispatchSrc.slice(dispatchSrc.indexOf("if (tabId && groupSoft && hasTabGroupApi())"))
    expect(fallbackBlock.indexOf("softFallbackTab = true")).toBeLessThan(fallbackBlock.indexOf("if (action.anyTab !== true && !TAB_FREE_ACTIONS"))
  })
})

describe("sessions own their groups and tabs", () => {
  test("session labels match the CLI's derived labels only", () => {
    expect(SESSION_LABEL_RE.test(me)).toBe(true)
    expect(SESSION_LABEL_RE.test("s-mylane")).toBe(false)
    expect(SESSION_LABEL_RE.test("lane-1")).toBe(false)
  })

  test("another session's group or tab is refused", () => {
    expect(foreignSessionCloseError("group", other, me, other)).toContain("--any-tab")
    expect(foreignSessionCloseError("tab", other, me, 7)).toContain("tab 7 belongs to another agent session")
  })

  test("own groups, named groups, ungrouped tabs pass", () => {
    expect(foreignSessionCloseError("group", me, me, me)).toBeNull()
    expect(foreignSessionCloseError("group", "lane-1", me, "lane-1")).toBeNull()
    expect(foreignSessionCloseError("tab", null, me, 7)).toBeNull()
  })

  test("the check applies only to soft callers without --any-tab on browsers with tab groups", () => {
    expect(dispatchSrc).toContain('if (groupSoft && action.anyTab !== true && hasTabGroupApi()\n      && (action.type === "group_close" || action.type === "tab_close" || moveTabId !== undefined)) {')
  })
})

describe("CLI group ownership", () => {
  const { parseGroupCommand, markOwnGroup } = require("../cli/commands/group") as typeof import("../cli/commands/group")

  test("group close with no label closes the caller's own group", () => {
    expect(parseGroupCommand(["group", "close"], me)).toEqual({ type: "group_close", label: me })
    expect(parseGroupCommand(["group", "close", "lane-1"], me)).toEqual({ type: "group_close", label: "lane-1" })
  })

  test("group list marks only the caller's group", () => {
    const result = markOwnGroup({ success: true, data: [{ label: me }, { label: other }, { label: null }] }, me)
    expect(result.data).toEqual([{ label: me, own: true }, { label: other }, { label: null }])
    expect(markOwnGroup({ success: true, data: [{ label: me }] }, undefined).data).toEqual([{ label: me }])
  })
})

describe("fixes from a real agent run", () => {
  const { softFallbackGateError } = require("../extension/src/background/message-dispatch") as typeof import("../extension/src/background/message-dispatch")
  const skill = readFileSync(join(root, ".agents/skills/interceptor-browser/SKILL.md"), "utf-8")

  test("refusals no longer read as an invitation to bypass", () => {
    expect(foreignSessionCloseError("group", other, me, other)).toContain("pass --any-tab only if the user named this group")
    expect(foreignSessionCloseError("group", other, me, other)).not.toContain("if you were asked")
    expect(foreignSessionCloseError("tab", other, me, 7)).toContain("pass --any-tab only if the user named this tab")
  })

  test("the skill tells agents to leave other agents' groups alone", () => {
    expect(skill).toContain("leave it alone, even when asked to clean up")
    expect(skill).not.toContain("is refused unless `--any-tab` is passed")
  })

  test("a soft fallback read refused by the gate says to open a page first", () => {
    expect(softFallbackGateError(me, 42, "example.com")).toContain("Open a page first (interceptor open <url>)")
    expect(dispatchSrc).toContain("fail(softFallbackRefusal ?? membershipError)")
  })

  test("another session's group is judged only in the profile that holds it", () => {
    expect(dispatchSrc).toContain("if (label && await ensureNamedGroup(label) !== -1) refusal = foreignSessionCloseError(")
  })
})
