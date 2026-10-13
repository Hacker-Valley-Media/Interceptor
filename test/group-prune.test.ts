// `interceptor group prune` (cli/commands/group-prune.ts): which chips it may
// delete, how it reads the browser's UI tree, and the order of the calls it
// makes. The tree fixtures are lines copied from a live `macos tree` of Chrome.
import { describe, expect, test } from "bun:test"
import {
  findSavedGroupMenu, isManagedTitle, parseGroupPruneOptions, parseRunningBrowsers,
  countWindowsWithoutBar, parseSavedGroupChips, runGroupPrune, selectPrunable, unsupportedPlatformError,
  type PruneHost,
} from "../cli/commands/group-prune"
import { classify } from "../cli/mcp/tiers"
import { normalizeArgs } from "../cli/normalize"
import type { DaemonResponse } from "../cli/transport"

// A Mac with the bridge installed, and no waiting between steps.
const MAC: PruneHost = { platform: "darwin", providerFailure: async () => null, sleep: async () => {} }
const WINDOWS: PruneHost = { ...MAC, platform: "win32" }
const LINUX: PruneHost = { ...MAC, platform: "linux" }

const BAR = [
  '                [e21641] toolbar "Saved Tab Groups"',
  '                  [e21642] button " interceptor-s-9368e975e66b4906 group - Opened"',
  '                  [e21643] button " interceptor-cf-deskhand group - Closed"',
  '                  [e21644] button " interceptor-s-4074e11fb71b108a group - Closed"',
  '                  [e21645] button " reading list group - Closed"',
  '                  [e21646] button " interceptor group - Closed"',
  '                  [e21649] button "Tab groups"',
  // The same profile's second window repeats every chip under new refs.
  '                [e21734] toolbar "Saved Tab Groups"',
  '                  [e21736] button " interceptor-cf-deskhand group - Closed"',
  '                  [e21737] button " interceptor-s-4074e11fb71b108a group - Closed"',
  '                  [e21742] button "Tab groups"',
].join("\n")

const MENU = [
  "          [e23162] menu",
  '            [e23163] menuitem "Open group"',
  '            [e23164] menuitem "Open group in new window"',
  '            [e23165] menuitem "Unpin group from bookmarks bar"',
  '            [e23166] menuitem "Delete group"',
  "            [e23167] menuitem",
  '            [e23168] menuitem "Tabs in group"',
].join("\n")

describe("reading the saved tab groups bar", () => {
  test("every chip, with its state", () => {
    const chips = parseSavedGroupChips(BAR)
    expect(chips).toHaveLength(7)
    expect(chips[0]).toEqual({ ref: "e21642", title: "interceptor-s-9368e975e66b4906", state: "open" })
    expect(chips[1]).toEqual({ ref: "e21643", title: "interceptor-cf-deskhand", state: "closed" })
  })

  test("the 'Tab groups' button and other buttons are not chips", () => {
    expect(parseSavedGroupChips('  [e1] button "Tab groups"\n  [e2] button "New Tab"')).toEqual([])
  })
})

describe("windows that hide the bookmarks bar", () => {
  const tree = '                [e3] toolbar "Saved Tab Groups"\n                  [e4] button "Tab groups"'

  test("are counted, so the run can say what it did not check", () => {
    expect(countWindowsWithoutBar(tree, 3)).toBe(2)
    expect(countWindowsWithoutBar(BAR, 2)).toBe(0)
    expect(countWindowsWithoutBar(BAR, 1)).toBe(0)
  })

  test("are named in the result's warning", async () => {
    const { send } = fakeBridge({ trees: [tree], windows: 3 })
    const r = await runGroupPrune({ dryRun: true, allowFrontmost: false }, send, MAC)
    expect(r.success).toBe(true)
    expect(r.warning).toContain("2 Google Chrome window(s) show no bookmarks bar")
  })
})

describe("which groups prune may delete", () => {
  const brands = ["interceptor"]

  test("a managed title is the brand, or the brand plus a valid label", () => {
    expect(isManagedTitle("interceptor", brands)).toBe(true)
    expect(isManagedTitle("interceptor-s-4074e11fb71b108a", brands)).toBe(true)
    expect(isManagedTitle("interceptor-", brands)).toBe(false)
    expect(isManagedTitle("interceptor-has space", brands)).toBe(false)
    expect(isManagedTitle("interceptors-x", brands)).toBe(false)
    expect(isManagedTitle("reading list", brands)).toBe(false)
    expect(isManagedTitle("acme-lane1", ["interceptor", "acme"])).toBe(true)
  })

  test("closed managed groups only, one per title", () => {
    const picked = selectPrunable(parseSavedGroupChips(BAR), brands, new Set())
    expect(picked.map((c) => c.title)).toEqual(["interceptor-cf-deskhand", "interceptor-s-4074e11fb71b108a", "interceptor"])
    expect(picked[0].ref).toBe("e21643")
  })

  test("a group that is open in a connected profile is kept", () => {
    const picked = selectPrunable(parseSavedGroupChips(BAR), brands, new Set(["interceptor-cf-deskhand"]))
    expect(picked.map((c) => c.title)).toEqual(["interceptor-s-4074e11fb71b108a", "interceptor"])
  })

  test("a title that reads 'Opened' in any window is kept", () => {
    const tree = [
      '  [e1] button " interceptor-lane1 group - Closed"',
      '  [e2] button " interceptor-lane1 group - Opened"',
    ].join("\n")
    expect(selectPrunable(parseSavedGroupChips(tree), brands, new Set())).toEqual([])
  })
})

describe("reading the chip's context menu", () => {
  test("finds the menu and its 'Delete group' item", () => {
    expect(findSavedGroupMenu(MENU)).toEqual({ menuRef: "e23162", deleteRef: "e23166" })
  })

  test("another menu is not mistaken for it", () => {
    const appleMenu = '      [e1] menu\n        [e2] menuitem "About This Mac"\n        [e3] menuitem "Delete group"'
    expect(findSavedGroupMenu(appleMenu)).toEqual({})
  })

  test("a saved-group menu without 'Delete group' reports the menu only", () => {
    const noDelete = '  [e1] menu\n    [e2] menuitem "Open group"\n    [e3] menuitem "Close group"\n  [e4] button "Back"\n  [e5] menuitem "Delete group"'
    expect(findSavedGroupMenu(noDelete)).toEqual({ menuRef: "e1" })
  })
})

describe("finding the browsers to prune", () => {
  test("Chromium browsers only, with the active and hidden markers read", () => {
    expect(parseRunningBrowsers(undefined)).toEqual([])
    const apps = [
      "[750] Safari — com.apple.Safari",
      "[1579] Google Chrome * — com.google.Chrome",
      "[1600] Brave Browser (hidden) — com.brave.Browser",
      "[1601] Microsoft Edge * (hidden) — com.microsoft.edgemac",
      "[82539] Discord — com.hnc.Discord",
    ].join("\n")
    expect(parseRunningBrowsers(apps)).toEqual([
      { name: "Google Chrome", pid: 1579, hidden: false },
      { name: "Brave Browser", pid: 1600, hidden: true },
      { name: "Microsoft Edge", pid: 1601, hidden: true },
    ])
  })

  test("Windows and Linux rows are matched by process or application name", () => {
    const rows = [
      { name: "chrome.exe", pid: 10 }, { name: "msedge", pid: 11 }, { name: "Google Chrome", pid: 12 },
      { name: "chromium-browser", pid: 13 }, { name: "brave", pid: 14 },
      { name: "explorer.exe", pid: 20 }, { name: "Chrome Remote Desktop", pid: 21 }, { name: "firefox", pid: 22 },
    ]
    expect(parseRunningBrowsers(rows).map((b) => b.pid)).toEqual([10, 11, 12, 13, 14])
  })

  test("two instances of one browser stay separate", () => {
    const apps = "[1579] Google Chrome (hidden) — com.google.Chrome\n[30747] Google Chrome — com.google.Chrome"
    expect(parseRunningBrowsers(apps).map((b) => [b.pid, b.hidden])).toEqual([[1579, true], [30747, false]])
  })
})

// `trees` are returned in order, one per tree call.
// A scripted provider. It answers the macOS bridge's `macos_*` actions and the
// Windows / Linux provider's `desktop_*` actions; `namespaces` records which came in.
function fakeBridge(opts: { trees: string[]; apps?: unknown; frontmostPid?: number; frontmost?: unknown; groups?: unknown[]; windows?: number }) {
  const calls: string[] = []
  const namespaces = new Set<string>()
  let treeIndex = 0
  const send = async (a: { type: string; [k: string]: unknown }, _t?: number, ctx?: string): Promise<DaemonResponse> => {
    const reply = (data: unknown) => ({ id: "x", result: { success: true, data } } as DaemonResponse)
    const nativeCall = /^(macos|desktop)_(.+)$/.exec(a.type)
    if (nativeCall) namespaces.add(nativeCall[1])
    switch (nativeCall ? `macos_${nativeCall[2]}` : a.type) {
      case "contexts": return reply(opts.groups ? ["ctx1"] : [])
      case "group_list": calls.push(`group_list@${ctx}`); return reply(opts.groups ?? [])
      case "macos_apps": return reply(opts.apps ?? "[1] Google Chrome — com.google.Chrome")
      case "macos_frontmost": return reply(opts.frontmost !== undefined ? opts.frontmost : { name: "x", pid: opts.frontmostPid ?? 999 })
      case "macos_click": calls.push(`click:${a.ref}:${a.right === true ? "right" : "left"}`); return reply(undefined)
      case "macos_windows": return reply(Array.from({ length: opts.windows ?? 0 }, (_, i) => ({ windowId: i })))
      case "macos_tree": {
        if (typeof a.pid !== "number") throw new Error("macos_tree must address the browser by pid")
        calls.push(`tree:${a.filter}`)
        return reply(opts.trees[Math.min(treeIndex++, opts.trees.length - 1)])
      }
      case "macos_action": calls.push(`${a.action}:${a.ref}`); return reply(undefined)
      default: throw new Error(`unexpected action ${a.type}`)
    }
  }
  return { send, calls, namespaces }
}

const ONE_CHIP = '  [e10] button " interceptor-lane1 group - Closed"\n  [e11] button " reading list group - Closed"'
const CHIP_GONE = '  [e11] button " reading list group - Closed"'

describe("the prune run", () => {
  test("show the chip's menu, press 'Delete group', then confirm the chip is gone", async () => {
    const { send, calls } = fakeBridge({ trees: [ONE_CHIP, ONE_CHIP, `${ONE_CHIP}\n${MENU}`, CHIP_GONE, CHIP_GONE] })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, MAC)
    expect(r.success).toBe(true)
    expect(calls).toEqual(["tree:interactive", "tree:all", "showMenu:e10", "tree:all", "press:e23166", "tree:all", "tree:interactive"])
    expect(r.data).toEqual({
      dryRun: false, deleted: 1,
      browsers: [{ app: "Google Chrome", pid: 1, found: ["interceptor-lane1"], deleted: ["interceptor-lane1"], failed: [] }],
    })
  })

  test("--dry-run lists the groups and touches nothing", async () => {
    const { send, calls } = fakeBridge({ trees: [ONE_CHIP] })
    const r = await runGroupPrune({ dryRun: true, allowFrontmost: false }, send, MAC)
    expect(r.success).toBe(true)
    expect(calls).toEqual(["tree:interactive"])
    expect((r.data as { browsers: Array<{ found: string[] }> }).browsers[0].found).toEqual(["interceptor-lane1"])
  })

  test("a chip that is still there after 'Delete group' is tried twice, then reported, not counted", async () => {
    const withMenu = `${ONE_CHIP}\n${MENU}`
    const { send, calls } = fakeBridge({ trees: [ONE_CHIP, ONE_CHIP, withMenu, ONE_CHIP, withMenu, ONE_CHIP, ONE_CHIP] })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, MAC)
    expect(r.success).toBe(false)
    expect(calls.filter((c) => c === "press:e23166")).toHaveLength(2)
    expect(r.error).toContain("(0 deleted)")
    expect(r.error).toContain("interceptor-lane1 not deleted: still on the bar")
    const browser = (r.data as { browsers: Array<{ deleted: string[]; failed: Array<{ title: string; reason: string }> }> }).browsers[0]
    expect(browser.deleted).toEqual([])
    expect(browser.failed[0].title).toBe("interceptor-lane1")
    expect(browser.failed[0].reason).toContain("still on the bar")
  })

  test("a menu that was dismissed before the press is opened again", async () => {
    // First attempt: the menu never shows (three polls). Second attempt: it does.
    const withMenu = `${ONE_CHIP}\n${MENU}`
    const { send, calls } = fakeBridge({ trees: [ONE_CHIP, ONE_CHIP, ONE_CHIP, ONE_CHIP, ONE_CHIP, ONE_CHIP, withMenu, CHIP_GONE, CHIP_GONE] })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, MAC)
    expect(r.success).toBe(true)
    expect(calls.filter((c) => c === "showMenu:e10")).toHaveLength(2)
    expect((r.data as { deleted: number }).deleted).toBe(1)
  })

  test("a menu without 'Delete group' is closed again and nothing is pressed", async () => {
    const menuNoDelete = '  [e50] menu\n    [e51] menuitem "Open group"'
    const { send, calls } = fakeBridge({ trees: [ONE_CHIP, ONE_CHIP, `${ONE_CHIP}\n${menuNoDelete}`, ONE_CHIP, ONE_CHIP] })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, MAC)
    expect(r.success).toBe(false)
    expect(calls).toContain("cancel:e50")
    expect(calls.some((c) => c.startsWith("press:"))).toBe(false)
  })

  test("the frontmost browser is left alone unless --allow-frontmost", async () => {
    const refused = fakeBridge({ trees: [ONE_CHIP], frontmostPid: 1 })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, refused.send, MAC)
    expect(r.success).toBe(false)
    expect(r.error).toContain("Google Chrome is the frontmost app")
    expect(refused.calls).toEqual(["tree:interactive"])

    const allowed = fakeBridge({ trees: [ONE_CHIP, ONE_CHIP, `${ONE_CHIP}\n${MENU}`, CHIP_GONE, CHIP_GONE], frontmostPid: 1 })
    expect((await runGroupPrune({ dryRun: false, allowFrontmost: true }, allowed.send, MAC)).success).toBe(true)
  })

  test("a hidden browser is left alone", async () => {
    const { send, calls } = fakeBridge({ trees: [ONE_CHIP], apps: "[1] Google Chrome (hidden) — com.google.Chrome" })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: true }, send, MAC)
    expect(r.success).toBe(false)
    expect(r.error).toContain("Google Chrome is hidden")
    expect(calls).toEqual(["tree:interactive"])
  })

  test("a menu that is already open stops the run before anything is pressed", async () => {
    const { send, calls } = fakeBridge({ trees: [ONE_CHIP, `${ONE_CHIP}\n${MENU}`, ONE_CHIP] })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, MAC)
    expect(r.success).toBe(false)
    expect(r.error).toContain("already open")
    expect(calls.some((c) => c.startsWith("showMenu:") || c.startsWith("press:"))).toBe(false)
  })

  test("a group that is open in a connected profile is not deleted, and its brand is learned", async () => {
    const tree = '  [e10] button " acme-lane1 group - Closed"\n  [e12] button " acme-lane2 group - Closed"'
    const { send, calls } = fakeBridge({
      trees: [tree],
      groups: [{ title: "acme-lane1", label: "lane1", default: false }],
    })
    const r = await runGroupPrune({ dryRun: true, allowFrontmost: false }, send, MAC)
    expect(calls[0]).toBe("group_list@ctx1")
    expect((r.data as { browsers: Array<{ found: string[] }> }).browsers[0].found).toEqual(["acme-lane2"])
  })

  test("--app picks the browser by name, and a name that is not running is an error", async () => {
    const apps = "[1] Google Chrome — com.google.Chrome\n[2] Brave Browser — com.brave.Browser"
    const one = await runGroupPrune({ dryRun: true, allowFrontmost: false, app: "brave browser" }, fakeBridge({ trees: [ONE_CHIP], apps }).send, MAC)
    expect((one.data as { browsers: Array<{ app: string }> }).browsers.map((b) => b.app)).toEqual(["Brave Browser"])
    const none = await runGroupPrune({ dryRun: true, allowFrontmost: false, app: "Arc" }, fakeBridge({ trees: [ONE_CHIP], apps }).send, MAC)
    expect(none.success).toBe(false)
    expect(none.error).toContain("'Arc'")
  })

  test("no Chromium browser running is a clean no-op", async () => {
    const { send } = fakeBridge({ trees: [], apps: "[750] Safari — com.apple.Safari" })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, MAC)
    expect(r).toEqual({ success: true, data: { dryRun: false, deleted: 0, browsers: [] } })
  })
})

describe("on Windows and Linux", () => {
  const ROWS = [{ name: "chrome.exe", pid: 4321 }, { name: "explorer.exe", pid: 8 }]
  const deleted = () => [ONE_CHIP, ONE_CHIP, `${ONE_CHIP}\n${MENU}`, CHIP_GONE, CHIP_GONE]

  for (const host of [WINDOWS, LINUX]) {
    test(`${host.platform}: the same run through the desktop provider, with a background right-click for the menu`, async () => {
      const { send, calls, namespaces } = fakeBridge({ trees: deleted(), apps: ROWS, frontmost: { pid: 8 } })
      const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, host)
      expect(r.success).toBe(true)
      expect([...namespaces]).toEqual(["desktop"])
      expect(calls).toEqual(["tree:interactive", "tree:all", "click:e10:right", "tree:all", "press:e23166", "tree:all", "tree:interactive"])
      expect((r.data as { deleted: number; browsers: Array<{ app: string; pid: number }> }).browsers[0]).toMatchObject({ app: "chrome.exe", pid: 4321 })
    })
  }

  test("macOS keeps its own action names and the accessibility menu action", async () => {
    const { send, calls, namespaces } = fakeBridge({ trees: deleted() })
    await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, MAC)
    expect([...namespaces]).toEqual(["macos"])
    expect(calls).toContain("showMenu:e10")
    expect(calls.some((c) => c.startsWith("click:"))).toBe(false)
  })

  test("the frontmost browser is left alone, whether the host answers with one window or a list", async () => {
    for (const frontmost of [{ pid: 4321 }, [{ pid: 4321 }]]) {
      const { send, calls } = fakeBridge({ trees: [ONE_CHIP], apps: ROWS, frontmost })
      const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, LINUX)
      expect(r.error).toContain("chrome.exe is the frontmost app")
      expect(calls).toEqual(["tree:interactive"])
    }
  })

  test("no foreground window at all does not stop the run", async () => {
    const { send } = fakeBridge({ trees: deleted(), apps: ROWS, frontmost: null })
    expect((await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, WINDOWS)).success).toBe(true)
  })

  test("a menu with no 'Delete group' is not cancelled by reference off macOS", async () => {
    const menuNoDelete = '  [e50] menu\n    [e51] menuitem "Open group"'
    const { send, calls } = fakeBridge({ trees: [ONE_CHIP, ONE_CHIP, `${ONE_CHIP}\n${menuNoDelete}`], apps: ROWS, frontmost: null })
    const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, WINDOWS)
    expect(r.success).toBe(false)
    expect(calls.some((c) => c.startsWith("cancel:") || c.startsWith("press:"))).toBe(false)
    expect(r.error).toContain("already open")
  })

  test("refs are opaque: the Windows and Linux provider's long refs are read", () => {
    const ref = "e000000000000000000000000000001791866400000000000000000042"
    expect(parseSavedGroupChips(`  [${ref}] button " interceptor-lane1 group - Closed"`)[0].ref).toBe(ref)
  })
})

describe("where the UI cannot be driven", () => {
  test("an install without the native provider is told why, and nothing else is sent", async () => {
    const send = async (): Promise<DaemonResponse> => { throw new Error("must not be called") }
    for (const host of [MAC, WINDOWS, LINUX]) {
      const r = await runGroupPrune({ dryRun: true, allowFrontmost: false }, send, { ...host, providerFailure: async () => "run:\n  interceptor upgrade --full" })
      expect(r.success).toBe(false)
      expect(r.error).toContain("run: interceptor upgrade --full")
      expect(r.error).toContain("Delete group")
    }
  })

  test("a platform with no desktop provider is refused with the manual path, and nothing is sent", async () => {
    let sent = 0
    const send = async (): Promise<DaemonResponse> => { sent += 1; throw new Error("must not be called") }
    for (const platform of ["freebsd", "aix"]) {
      const r = await runGroupPrune({ dryRun: false, allowFrontmost: false }, send, { ...MAC, platform })
      expect(r.success).toBe(false)
      expect(r.error).toBe(unsupportedPlatformError(platform))
      expect(r.error).toContain("Delete group")
    }
    expect(sent).toBe(0)
  })
})

describe("the command line", () => {
  test("flags", () => {
    expect(parseGroupPruneOptions(["group", "prune"])).toEqual({ dryRun: false, allowFrontmost: false })
    expect(parseGroupPruneOptions(["group", "prune", "--dry-run", "--app", "Brave Browser", "--brand", "acme", "--allow-frontmost"]))
      .toEqual({ dryRun: true, allowFrontmost: true, app: "Brave Browser", brand: "acme" })
  })

  test("a stray argument or a flag without its value is a usage error", () => {
    expect(parseGroupPruneOptions(["group", "prune", "lane1"])).toHaveProperty("error")
    expect(parseGroupPruneOptions(["group", "prune", "--app"])).toHaveProperty("error")
    expect(parseGroupPruneOptions(["group", "prune", "--older-than", "7"])).toHaveProperty("error")
  })

  test("the strict flag inventory accepts prune's flags", () => {
    expect(() => normalizeArgs(["group", "prune", "--dry-run", "--allow-frontmost", "--app", "Google Chrome", "--brand", "acme"])).not.toThrow()
  })

  test("prune is destructive over MCP; list and close keep their tiers", () => {
    expect(classify("browser", "group", ["prune"]).tier).toBe("destructive")
    expect(classify("browser", "group", ["close", "lane1"]).tier).toBe(classify("browser", "group", ["close", "x"]).tier)
    expect(classify("browser", "group", ["close", "lane1"]).tier).not.toBe("destructive")
  })
})
