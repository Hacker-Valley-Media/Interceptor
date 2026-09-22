import { afterEach, beforeEach, expect, test } from "bun:test"
import { waitForTabLoad } from "../extension/src/background/content-bridge"

let originalChrome: unknown
let getCalls = 0
let sendCalls = 0

beforeEach(() => {
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  getCalls = 0
  sendCalls = 0
  ;(globalThis as { chrome: unknown }).chrome = {
    runtime: { lastError: undefined },
    tabs: {
      get: async () => { getCalls++; return { id: 7, status: "complete" } },
      sendMessage: (_id: number, _msg: unknown, _opts: unknown, cb: (r: unknown) => void) => { sendCalls++; cb({ success: true, data: { stable: true } }) },
      onUpdated: {
        addListener: (fn: (id: number, info: { status: string }) => void) => { queueMicrotask(() => fn(7, { status: "complete" })) },
        removeListener() {},
      },
    },
  }
})
afterEach(() => { (globalThis as { chrome?: unknown }).chrome = originalChrome })

test("a tab that reports complete leaves no stage-1 probe timer behind", async () => {
  const result = await waitForTabLoad(7, 600)
  expect(result.ready).toBe(true)
  expect(sendCalls).toBe(1)
  // The stage-1 timer (min(timeout, 10 s)) used to survive the listener path and
  // fire a second tabs.get + wait_stable probe into whatever came next.
  await new Promise((resolve) => setTimeout(resolve, 800))
  expect(getCalls).toBe(0)
  expect(sendCalls).toBe(1)
})
