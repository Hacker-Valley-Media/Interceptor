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
  context.captured = []
  runInContext('activeTransport="native"; sendToHost=message=>captured.push(message); chrome.tabGroups={query:async()=>[]}; transferringGroups.add("transfer")', context)
  await runInContext('handleDaemonMessage({id:"read-transfer",action:{type:"click",group:"transfer"}})', context)
  await runInContext('handleDaemonMessage({id:"close-transfer",action:{type:"group_close",label:"transfer",group:"other",groupSoft:true}})', context)
  expect(context.captured).toHaveLength(2)
  for (const response of context.captured) expect(response.result).toMatchObject({ success: false, error: "group 'transfer' transfer in progress; retry after it completes" })
  expect(runInContext('pendingRequests.size', context)).toBe(0)
  runInContext('transferringTabs.set(77,"s-1111111111111111")', context)
  await runInContext('handleDaemonMessage({id:"close-foreign-transfer",action:{type:"tab_close",tabId:77,group:"s-2222222222222222",groupSoft:true}})', context)
  expect(context.captured.at(-1).result).toMatchObject({success:false,error:"group 's-1111111111111111' transfer in progress; retry after it completes"})
  expect(runInContext('pendingRequests.size', context)).toBe(0)
  runInContext('managedTabGateError=async()=>null',context)
  await runInContext('handleDaemonMessage({id:"close-already-checked-transfer",action:{type:"tab_close",tabId:77,group:"s-2222222222222222",groupSoft:true}})', context)
  expect(context.captured.at(-1).result.success).toBe(false)
  expect(context.captured.at(-1).result.error).toContain("belongs to another agent session's group 's-1111111111111111'")
  expect(runInContext('pendingRequests.size', context)).toBe(0)
  const restoredChrome = {...chrome, tabs:{...chrome.tabs,query:answer([]),get:answer({id:77,windowId:3,active:true,groupId:-1})},
    storage:{...chrome.storage, session:{
      get:async()=>({failedTransferTabs:{77:"s-1111111111111111",bad:"invalid label"}}),set:async()=>{},
    }},
  }
  const restarted = createContext({ chrome:restoredChrome, console: { log() {}, warn() {}, error() {} }, URL, crypto, TextEncoder, TextDecoder,
    navigator: { userAgent: "fixture" }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    WebSocket: class { static OPEN = 1; readyState = 0; close() {}; send() {} },
  })
  runInContext(bundle,restarted,{timeout:3000})
  await runInContext('hydrateNamedGroups()',restarted)
  expect(await runInContext('managedTabGateError(77,"s-2222222222222222",false)',restarted)).toContain("transfer in progress; retry")
})
