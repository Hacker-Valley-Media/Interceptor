import { describe, expect, test } from "bun:test"
import { parseTabsCommand } from "../cli/commands/tabs"
import { handleWindowActions } from "../extension/src/background/capabilities/windows"

// `window new` is background-first. Chromium's own default for
// chrome.windows.create is focused: true (tabs_api.cc WindowsCreateFunction),
// so the CLI has to send the decision and the handler has to forward only an
// explicit true.

describe("window new — CLI parse", () => {
  test("plain: no url, focused false", async () => {
    expect(await parseTabsCommand(["window", "new"])).toEqual({ type: "window_create", url: undefined, incognito: false, focused: false })
  })
  test("url without flags", async () => {
    expect(await parseTabsCommand(["window", "new", "https://example.com"])).toEqual({ type: "window_create", url: "https://example.com", incognito: false, focused: false })
  })
  test("--activate alone is a flag, not a url", async () => {
    expect(await parseTabsCommand(["window", "new", "--activate"])).toEqual({ type: "window_create", url: undefined, incognito: false, focused: true })
  })
  test("url + --activate + --incognito in any order", async () => {
    expect(await parseTabsCommand(["window", "new", "--incognito", "https://example.com", "--activate"])).toEqual({ type: "window_create", url: "https://example.com", incognito: true, focused: true })
  })
})

describe("window_create — handler focus gate", () => {
  async function createWith(action: Record<string, unknown>) {
    const globals = globalThis as { chrome?: unknown }
    const originalChrome = globals.chrome
    let received: Record<string, unknown> | undefined
    globals.chrome = {
      windows: {
        create: async (data: Record<string, unknown>) => { received = data; return { id: 11, tabs: [] } },
      },
    }
    try {
      const result = await handleWindowActions({ type: "window_create", ...action }, 0)
      expect(result.success).toBe(true)
      return received!
    } finally {
      globals.chrome = originalChrome
    }
  }

  test("default sends focused: false", async () => {
    expect((await createWith({})).focused).toBe(false)
  })
  test("focused: false stays false", async () => {
    expect((await createWith({ focused: false })).focused).toBe(false)
  })
  test("only a literal true focuses", async () => {
    expect((await createWith({ focused: true })).focused).toBe(true)
    expect((await createWith({ focused: "true" })).focused).toBe(false)
  })
})
