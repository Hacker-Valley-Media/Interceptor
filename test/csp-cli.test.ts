import { describe, expect, test } from "bun:test"

import { runCsp } from "../cli/commands/csp"

type CspAction = { type: string; [key: string]: unknown }
type CspResult = { success: boolean; error?: string; data?: unknown }
type CspSender = NonNullable<Parameters<typeof runCsp>[2]>
type SenderCall = {
  action: CspAction
  tabId?: number
  useWs?: boolean
  contextId?: string
}

function makeSender(calls: SenderCall[], result: CspResult = { success: true, data: {} }): CspSender {
  return async (action, tabId, useWs, contextId) => {
    calls.push({ action, tabId, useWs, contextId })
    return result
  }
}

async function withMutedConsole(fn: () => Promise<void>): Promise<void> {
  const originalLog = console.log
  console.log = () => {}
  try {
    await fn()
  } finally {
    console.log = originalLog
  }
}

// Capture stdout/stderr AND intercept process.exit so we can assert the
// human-readable output and the exit-code contract without killing the runner.
async function capture(fn: () => Promise<void>): Promise<{ out: string[]; err: string[]; exit?: number }> {
  const origLog = console.log
  const origErr = console.error
  const origExit = process.exit
  const out: string[] = []
  const err: string[] = []
  let exit: number | undefined
  console.log = (...a: unknown[]) => { out.push(a.join(" ")) }
  console.error = (...a: unknown[]) => { err.push(a.join(" ")) }
  process.exit = ((code?: number) => { exit = code ?? 0; throw new Error("__exit__") }) as typeof process.exit
  try {
    await fn()
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e
  } finally {
    console.log = origLog
    console.error = origErr
    process.exit = origExit
  }
  return { out, err, exit }
}

describe("runCsp", () => {
  test("off disables CSP (reload default true) and passes routing options", async () => {
    const calls: SenderCall[] = []
    await withMutedConsole(() =>
      runCsp(["csp", "off"], { globalTabId: 7, useWs: true, contextId: "work" }, makeSender(calls))
    )
    expect(calls).toEqual([
      { action: { type: "csp_strip", reload: true }, tabId: 7, useWs: true, contextId: "work" },
    ])
  })

  test("on restores CSP", async () => {
    const calls: SenderCall[] = []
    await withMutedConsole(() => runCsp(["csp", "on"], { contextId: "work" }, makeSender(calls)))
    expect(calls).toEqual([
      { action: { type: "csp_restore", reload: true }, tabId: undefined, useWs: undefined, contextId: "work" },
    ])
  })

  test("status queries state and sends no reload flag", async () => {
    const calls: SenderCall[] = []
    await withMutedConsole(() => runCsp(["csp", "status"], {}, makeSender(calls)))
    expect(calls).toEqual([
      { action: { type: "csp_status" }, tabId: undefined, useWs: undefined, contextId: undefined },
    ])
  })

  test("--no-reload sets reload:false", async () => {
    const calls: SenderCall[] = []
    await withMutedConsole(() => runCsp(["csp", "off", "--no-reload"], {}, makeSender(calls)))
    expect(calls[0].action).toEqual({ type: "csp_strip", reload: false })
  })

  test("disable/enable are aliases for off/on", async () => {
    const calls: SenderCall[] = []
    await withMutedConsole(async () => {
      await runCsp(["csp", "disable"], {}, makeSender(calls))
      await runCsp(["csp", "enable"], {}, makeSender(calls))
    })
    expect(calls.map((c) => c.action.type)).toEqual(["csp_strip", "csp_restore"])
  })

  test("status prints disabled / enabled for all tabs", async () => {
    const disabled = await capture(() =>
      runCsp(["csp", "status"], {}, makeSender([], { success: true, data: { scope: "all-tabs", cspStripped: true } }))
    )
    expect(disabled.out).toContain("csp: disabled (all tabs)")

    const enabled = await capture(() =>
      runCsp(["csp", "status"], {}, makeSender([], { success: true, data: { scope: "all-tabs", cspStripped: false } }))
    )
    expect(enabled.out).toContain("csp: enabled (all tabs)")
  })

  test("off reports reloaded-tab count vs applies-on-next-navigation", async () => {
    const reloaded = await capture(() =>
      runCsp(["csp", "off"], {}, makeSender([], { success: true, data: { cspStripped: true, tabsReloaded: 4 } }))
    )
    expect(reloaded.out.join("\n")).toContain("reloaded 4 tab(s)")

    const deferred = await capture(() =>
      runCsp(["csp", "off", "--no-reload"], {}, makeSender([], { success: true, data: { cspStripped: true, tabsReloaded: 0 } }))
    )
    expect(deferred.out.join("\n")).toContain("applies on next navigation")
  })

  test("a failed daemon response exits non-zero", async () => {
    const res = await capture(() =>
      runCsp(["csp", "off"], {}, makeSender([], { success: false, error: "DNR quota" }))
    )
    expect(res.exit).toBe(1)
    expect(res.err.join("\n")).toContain("DNR quota")
  })

  test("an unknown subcommand exits non-zero", async () => {
    const res = await capture(() => runCsp(["csp", "bogus"], {}, makeSender([])))
    expect(res.exit).toBe(1)
    expect(res.err.join("\n")).toContain("unknown csp subcommand")
  })

  test("no subcommand prints usage and exits non-zero", async () => {
    const res = await capture(() => runCsp(["csp"], {}, makeSender([])))
    expect(res.exit).toBe(1)
    expect(res.err.join("\n")).toContain("requires a subcommand")
  })

  test("on prints the restore string with reloaded count", async () => {
    const res = await capture(() =>
      runCsp(["csp", "on"], {}, makeSender([], { success: true, data: { cspStripped: false, tabsReloaded: 2 } }))
    )
    expect(res.out.join("\n")).toContain("CSP restored for all tabs")
    expect(res.out.join("\n")).toContain("reloaded 2 tab(s)")
  })

  test("--json prints the raw result and exits 1 on failure", async () => {
    const ok = await capture(() =>
      runCsp(["csp", "status"], { jsonMode: true }, makeSender([], { success: true, data: { scope: "all-tabs", cspStripped: true } }))
    )
    expect(ok.exit).toBeUndefined()
    expect(JSON.parse(ok.out.join("\n"))).toEqual({ success: true, data: { scope: "all-tabs", cspStripped: true } })

    const fail = await capture(() =>
      runCsp(["csp", "off"], { jsonMode: true }, makeSender([], { success: false, error: "DNR quota" }))
    )
    expect(fail.exit).toBe(1)
    expect(JSON.parse(fail.out.join("\n"))).toEqual({ success: false, error: "DNR quota" })
  })
})
