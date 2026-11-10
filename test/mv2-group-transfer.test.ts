import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createContext, runInContext } from "node:vm"

test("the shipped MV2 entrypoint creates an ungrouped window without group APIs", async () => {
  const event = { addListener() {}, removeListener() {} }
  const answer = (value: unknown) => (...args: any[]) => {
    const cb = args.at(-1)
    if (typeof cb === "function") cb(value)
    else return Promise.resolve(value)
  }
  const chrome = {
    runtime: { id: "fixture", getURL: (p: string) => `chrome-extension://fixture/${p}`,
      getManifest: () => ({ version: "2.1.12", permissions: [] }), onMessage: event, onConnect: event },
    storage: { local: { get: answer({}), set: answer(undefined), remove: answer(undefined) }, onChanged: event },
    tabs: { query: answer([]), get: answer({ id: 77, windowId: 3, active: true }),
      executeScript: answer([]), onCreated: event, onRemoved: event, onUpdated: event, onActivated: event },
    windows: { create: answer({ id: 3, tabs: [{ id: 77 }] }), get: answer({ id: 3, type: "normal" }), onRemoved: event },
  }
  const context = createContext({ chrome, console: { log() {}, warn() {}, error() {} }, URL, crypto, TextEncoder, TextDecoder,
    navigator: { userAgent: "fixture" }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    WebSocket: class { static OPEN = 1; readyState = 0; close() {}; send() {} },
  })
  const bundle = readFileSync(new URL("../extension/dist-mv2/background-electron.js", import.meta.url), "utf8")
  runInContext(bundle, context, { timeout: 3000 })
  const result = await runInContext('handleWindowActions({type:"window_create",group:"mv2test"},0)', context)
  expect(result).toMatchObject({ success: true, data: { windowId: 3 } })
  expect(result.data.groupWarning).toBeUndefined()
  await runInContext('moveNamedGroupToWindow("mv2test",3)', context)
})
