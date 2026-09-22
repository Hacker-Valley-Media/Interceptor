import { afterEach, expect, test } from "bun:test"
import { prepareByteSource } from "../extension/src/background/capabilities/binary-sink"

const originalChrome = globalThis.chrome
afterEach(() => { globalThis.chrome = originalChrome })

// Mirrors the CSP-recovery case in eval-contract.test.ts, on the byte sink:
// the first MAIN-world attempt hits Trusted Types, the header strip and reload
// run, the retry succeeds, and the reload has to be disclosed in `warning`.
function chromeThatRecoversOnReload(descriptor: unknown) {
  let reloaded = false
  return {
    scripting: {
      executeScript: async () => [{
        frameId: 0,
        result: reloaded ? { success: true, data: descriptor } : { success: false, error: "TrustedScript required" },
      }],
    },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    runtime: { lastError: undefined },
    tabs: {
      reload: async () => { reloaded = true },
      sendMessage: (_id: number, _msg: unknown, _opts: unknown, cb: (r: unknown) => void) => { cb({ success: true, data: { stable: true } }) },
      onUpdated: {
        addListener: (fn: (id: number, info: { status: string }) => void) => { queueMicrotask(() => fn(42, { status: "complete" })) },
        removeListener() {},
      },
    },
  }
}

test("a CSP recovery that reloads the tab reaches the save result as a warning", async () => {
  globalThis.chrome = chromeThatRecoversOnReload({ url: "blob:https://x/1", kind: "blob", mime: "application/octet-stream", size: 3, created: false }) as any
  const prepared = await prepareByteSource(42, "new Blob([1,2,3])", "MAIN")
  expect(prepared.success).toBe(true)
  expect((prepared.data as { url: string }).url).toBe("blob:https://x/1")
  expect(prepared.warning).toContain("--no-reload")
})

test("an ordinary save carries no warning", async () => {
  globalThis.chrome = {
    scripting: { executeScript: async () => [{ frameId: 0, result: { success: true, data: { url: "blob:https://x/2", kind: "blob", mime: "text/plain", size: 1, created: false } } }] },
  } as any
  const prepared = await prepareByteSource(42, "new Blob(['a'])", "MAIN")
  expect(prepared.success).toBe(true)
  expect(prepared.warning).toBeUndefined()
})
