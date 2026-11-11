import { afterEach, expect, test } from "bun:test"
import type { DesktopHello } from "../shared/desktop-contract"
import { darwinOsInputSupport, nativeOsInputSupport, osInputSupport, unavailableOsInput } from "../shared/browser-os-input"
import { handleMetaActions } from "../extension/src/background/capabilities/meta"
import { handleOsInputActions } from "../extension/src/background/capabilities/os-input"
import { routeAction } from "../extension/src/background/router"
import { confirmDelivery, deliverInBackground } from "../daemon/os-background"

const saved = globalThis.chrome
afterEach(() => { globalThis.chrome = saved })
const bounds = { left: 0, top: 0, width: 800, height: 600 }
test("Windows reports foreground-only support and refuses covered, hidden and minimized targets before input", async () => {
  const map = nativeOsInputSupport("win32", provider())
  for (const op of ["click", "key", "type"] as const) expect(osInputSupport(map)[op]).toMatchObject({available:true,foreground:true,background:false,reason:expect.stringContaining("foreground")})
  for (const state of ["covered", "hidden", "minimized"]) for (const type of ["os_click", "os_key", "os_type"]) {
    const sent = chromeFixture()
    chrome.windows.get = (async () => ({id:3,focused:state!=="covered",state:state==="minimized"?"minimized":"normal",...bounds})) as unknown as typeof chrome.windows.get
    chrome.tabs.get = (async () => ({id:7,windowId:3,title:"fixture",active:state!=="hidden"})) as unknown as typeof chrome.tabs.get
    const result = await handleOsInputActions({type,osInput:map,backgroundOk:map.click.background,nativeInput:"win32",ref:"e1",key:"Enter",text:"hello"},7)
    expect(result).toMatchObject({success:false,delivered:false,data:{hint:expect.stringContaining("foreground")}})
    expect(result.data).not.toHaveProperty("moveTabId")
    expect(sent).toEqual([])
  }
})
function provider(host = "win32", backend = "Windows.UIAutomation+Win32"): DesktopHello {
  return { host: host as DesktopHello["host"], session: "1", protocolVersion: 1, maxFrameBytes: 1048576,
    provider: "fixture", version: "2.1.12", pid: 100, capabilities: ["click", "keys", "type", "scroll"].map(operation => ({
    operation, compiled: true, present: true, effective: true, permission: "not_applicable", session: "1",
    background: "window", provider: backend, versions: {}, limits: [],
  })) }
}
function chromeFixture() {
  const sent: string[] = []
  globalThis.chrome = {
    runtime: { getManifest: () => ({ permissions: [] }), getPlatformInfo: async () => ({ os: "mac" }) },
    windows: { get: async () => ({ id: 3, focused: true, state: "normal", type: "normal", ...bounds }) },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      get: async () => ({ id: 7, windowId: 3, title: "fixture", active: true }),
      sendMessage: (_id: number, msg: any, _opts: any, callback: (x: any) => void) => {
        sent.push(msg.action.type)
        callback(msg.action.type === "input_watch" ? { success: true, data: { armed: true } }
          : msg.action.type === "rect" ? { success: true, data: { left: 10, top: 20, width: 20, height: 20, viewportHeight: 512 } }
          : { success: true, warning: "no DOM change", refId: "e1" })
      },
      getZoom: async () => 1,
    },
  } as unknown as typeof chrome
  return sent
}

for (const [host, backend] of [["win32", "Windows.UIAutomation+Win32"]]) {
  test(`${host} ${backend} qualifies native click/key/type with independent move refusal`, async () => {
    const hello = provider(host, backend)
    if (backend.startsWith("Hyprland")) hello.capabilities.find(c => c.operation === "scroll")!.provider = "Hyprland/background-pointer-v1+AT-SPI2"
    const map = nativeOsInputSupport(host, hello)
    chromeFixture()
    const r = await handleMetaActions({ type: "capabilities", osInput: map }, 7)
    expect(r.data).toMatchObject({ layers: { os_input: true }, osInput: { move: { available: false } } })
    for (const type of ["os_click", "os_key", "os_type"]) {
      const r = await handleOsInputActions({ type, osInput: map, nativeInput: host, ref: "e1", key: "Enter", text: "hello" }, 7)
      expect(r.success).toBe(true)
      expect(r.data).toMatchObject({ method: "os_event", background: { title: "fixture", tabId: 7, foreground: host === "win32" } })
    }
    expect(await handleOsInputActions({ type: "os_move", osInput: map }, 7)).toMatchObject({ success: false, delivered: false, error: map.move.reason })
  })
}

test("Linux browser OS input refuses before delivery even when the native provider advertises input", async () => {
  for (const backend of ["AT-SPI2", "X11.XSendEvent/XRes+AT-SPI2", "Hyprland.Lua.send_shortcut+AT-SPI2"]) {
    const map = nativeOsInputSupport("linux", provider("linux", backend))
    const sent = chromeFixture()
    expect((await handleMetaActions({type:"capabilities",osInput:map},7)).data).toMatchObject({layers:{os_input:false}})
    for (const [op,type] of [["click","os_click"],["key","os_key"],["type","os_type"]] as const) {
      expect(map[op]).toMatchObject({available:false,foreground:false,background:false,reason:expect.stringContaining("not qualified")})
      expect(await handleOsInputActions({type,osInput:map,ref:"e1",key:"Enter",text:"hello"},7)).toMatchObject({success:false,delivered:false})
    }
    expect(sent).toEqual([])
  }
})

test("missing provider, older daemon, permission denial and missing session refuse before input", async () => {
  const absent = provider(); absent.session = "0"
  const denied = provider(); denied.capabilities[0].permission = "denied"
  const wayland = provider("linux", "AT-SPI2")
  for (const map of [osInputSupport(undefined), nativeOsInputSupport("win32"), nativeOsInputSupport("win32", absent), nativeOsInputSupport("win32", denied), nativeOsInputSupport("linux", wayland)]) {
    const sent = chromeFixture()
    expect((await handleMetaActions({ type: "capabilities", osInput: map }, 7)).data).toMatchObject({ layers: { os_input: false } })
    expect(await handleOsInputActions({ type: "os_click", osInput: map }, 7)).toMatchObject({ success: false, delivered: false })
    expect(sent).toEqual([])
  }
})

test("macOS browser-only keeps permission-qualified foreground input and no background move", () => {
  expect(darwinOsInputSupport(true, false)).toMatchObject({ click: { available: true, background: false }, move: { available: true, background: false } })
  expect(darwinOsInputSupport(false, false).click.available).toBe(false)
  expect(darwinOsInputSupport(false, true)).toMatchObject({ click: { available: true, foreground: false, background: true }, move: { available: false } })
  expect(darwinOsInputSupport(true, true)).toMatchObject({ click: { available: true, foreground: true, background: true }, move: { available: true, foreground: true, background: false } })
})

for (const os of ["mac", "win", "linux"]) test(`new extension with older daemon on ${os} preserves legacy dispatch and reports host support`, async () => {
  chromeFixture()
  chrome.runtime.getPlatformInfo = (async () => ({ os })) as typeof chrome.runtime.getPlatformInfo
  const capabilities = await handleMetaActions({ type: "capabilities" }, 7)
  expect(capabilities.data).toMatchObject({ layers: { os_input: os === "mac" } })
  const trusted = await handleOsInputActions({ type: "os_click", ref: "e1" }, 7)
  expect(trusted.data).toMatchObject({ method: "os_event" })
  const auto = await routeAction({ type: "click", ref: "e1" }, 7)
  expect(auto.warning).toContain("no trusted click was sent")
  expect(auto.data).toBeUndefined()
})

test("malformed and contradictory older-peer capability fields never qualify", () => {
  for (const value of [null, {}, { click: { available: true } }, { click: { available: true, foreground: false, background: false, reason: 1 } }]) {
    expect(osInputSupport(value).click).toMatchObject({ available: false, foreground: false, background: false })
    expect(typeof osInputSupport(value).click.reason).toBe("string")
  }
})

for (const type of ["click", "click_selector", "scene_click"]) test(`${type} reports no mutation without delivering another click`, async () => {
  const sent = chromeFixture()
  const skipped = await routeAction({ type, ref: "e1", osInput: unavailableOsInput("provider absent") }, 7)
  expect(skipped.success).toBe(true)
  expect(skipped.warning).toContain("no trusted click was sent; --trusted sends one")
  expect(sent).toEqual([type])
  const explicit = await routeAction({ type: "scene_click", os: true, osInput: unavailableOsInput("provider absent") }, 7)
  expect(explicit.success).toBe(false)
  const implicit = await routeAction({ type, ref: "e1", osInput: nativeOsInputSupport("win32", provider()), nativeInput: "win32" }, 7)
  expect(implicit.data).toBeUndefined()
  const escalated = await routeAction({ type: "scene_click", os: true, ref: "e1", osInput: nativeOsInputSupport("win32", provider()), nativeInput: "win32" }, 7)
  expect(escalated.data).toMatchObject({ method: "os_event", escalated: { to: "os_click" } })
})

test("foreground Windows browser delivery uses native input and confirms the page once", async () => {
  const calls: any[] = []
  const action = { type: "os_click", pageX: 10, pageY: 20, chromeUiHeight: 88, windowBounds: bounds,
    background: { title: "fixture", error: "refused", hint: "read", foreground: true, watching: true } }
  const window = { title: "fixture - Brave", pid: 100, windowId: "84", frame: { x: 0, y: 0, width: 800, height: 600 } }
  const result = await deliverInBackground(action, async a => {
    calls.push(a)
    if (a.type === "desktop_windows") return { success: true, data: [window] }
    return { success: true, data: { method: "Win32.SendInput", background: false, focusUnchanged: true, targetPid: 100 } }
  }, "win32")
  expect(calls).toHaveLength(2)
  expect(calls[1]).toMatchObject({ type: "desktop_click", backgroundOnly: false, windowTitle: window.title, window: 84, pid: 100 })
  expect((await confirmDelivery(result, action.background, async () => ({ success: true, data: { events: ["click"] } }), async () => {})).received).toBe(true)
  const unknown = await deliverInBackground(action, async a => ({ success: true, data: a.type === "desktop_windows" ? [window] : {} }), "win32")
  expect(unknown).toMatchObject({ success: false, code: "timeout_unknown_outcome" })
})
