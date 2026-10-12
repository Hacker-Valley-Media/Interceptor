import { describe, expect, test } from "bun:test"
import { BACKGROUND_OS_ACTIONS, bridgeActionFor, deliverInBackground } from "../daemon/os-background"

// The daemon hands a trusted browser action for an unfocused window to the
// macOS bridge. These pin the action it builds and what the caller gets back.

const BOUNDS = { left: 0, top: 30, width: 1728, height: 1011 }
const TARGET = {
  title: "Flow project",
  error: "window 5 is not the OS-focused window — trusted OS events are routed by the OS to whatever is frontmost, not to the target tab",
  hint: "trusted OS input needs the target tab visible in the OS-focused window.",
}

describe("background trusted input → bridge action", () => {
  test("os_click becomes a window-addressed bridge click at screen coordinates", () => {
    const action = bridgeActionFor({
      type: "os_click", background: TARGET, windowBounds: BOUNDS,
      pageX: 400, pageY: 300, chromeUiHeight: 81, button: "left", clickCount: 1,
    })
    expect(action).toEqual({
      type: "macos_bginput_click", coords: "400,411", right: false, double: false,
      windowTitle: "Flow project", windowBounds: BOUNDS,
    })
  })

  test("right and double clicks keep their kind; a missing UI height falls back to 88", () => {
    const right = bridgeActionFor({ type: "os_click", background: TARGET, windowBounds: BOUNDS, pageX: 10, pageY: 10, button: "right" })
    expect(right).toMatchObject({ right: true, double: false, coords: "10,128" })
    const double = bridgeActionFor({ type: "os_click", background: TARGET, windowBounds: BOUNDS, pageX: 10, pageY: 10, chromeUiHeight: 81, clickCount: 2 })
    expect(double).toMatchObject({ right: false, double: true })
  })

  test("os_type and os_key name the same window", () => {
    expect(bridgeActionFor({ type: "os_type", background: TARGET, windowBounds: BOUNDS, text: "hello" }))
      .toEqual({ type: "macos_bginput_type", text: "hello", windowTitle: "Flow project", windowBounds: BOUNDS })
    expect(bridgeActionFor({ type: "os_key", background: TARGET, windowBounds: BOUNDS, key: "a", modifiers: ["Meta", "Shift"] }))
      .toEqual({ type: "macos_bginput_keys", keys: "Meta+Shift+a", windowTitle: "Flow project", windowBounds: BOUNDS })
    expect(bridgeActionFor({ type: "os_key", background: TARGET, windowBounds: BOUNDS, key: "Enter" }))
      .toMatchObject({ keys: "Enter" })
  })

  test("nothing is built without a window frame, coordinates, or for os_move", () => {
    expect(bridgeActionFor({ type: "os_click", background: TARGET, pageX: 1, pageY: 1 })).toBeNull()
    expect(bridgeActionFor({ type: "os_click", background: TARGET, windowBounds: BOUNDS })).toBeNull()
    expect(bridgeActionFor({ type: "os_type", background: TARGET, windowBounds: BOUNDS, text: "" })).toBeNull()
    expect(bridgeActionFor({ type: "os_move", background: TARGET, windowBounds: BOUNDS, path: [] })).toBeNull()
    expect(BACKGROUND_OS_ACTIONS.has("os_move")).toBe(false)
  })
})

// macos_click / macos_type / macos_keys on a bridge from before
// window-addressed input ignore the window fields and post to the frontmost
// app. The browser path must never use them.
describe("background trusted input never uses a verb an older bridge would deliver to the frontmost app", () => {
  test("every bridge action goes to the bginput domain", () => {
    const actions = [
      bridgeActionFor({ type: "os_click", background: TARGET, windowBounds: BOUNDS, pageX: 1, pageY: 1 }),
      bridgeActionFor({ type: "os_type", background: TARGET, windowBounds: BOUNDS, text: "x" }),
      bridgeActionFor({ type: "os_key", background: TARGET, windowBounds: BOUNDS, key: "Enter" }),
    ]
    for (const a of actions) expect(String(a?.type)).toStartWith("macos_bginput_")
  })

  test("an older bridge has no such handler, so the caller gets the refusal and nothing is delivered", async () => {
    const type = { type: "os_type", background: TARGET, windowBounds: BOUNDS, text: "secret" }
    const result = await deliverInBackground(type, async () => ({ success: false, error: "no handler for domain: bginput" }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("window 5 is not the OS-focused window")
    expect(result.error).toContain("no handler for domain: bginput")
  })
})

describe("background trusted input → result", () => {
  const click = { type: "os_click", background: TARGET, windowBounds: BOUNDS, pageX: 400, pageY: 300, chromeUiHeight: 81 }

  test("a bridge success says the delivery was in the background", async () => {
    const sent: Record<string, unknown>[] = []
    const result = await deliverInBackground(click, async (a) => { sent.push(a); return { success: true, data: "clicked at (400, 411) → pid=4321 window=7247" } })
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe("macos_bginput_click")
    expect(result).toEqual({ success: true, data: "delivered in the background, focus unchanged: clicked at (400, 411) → pid=4321 window=7247" })
  })

  test("a page the browser has paused adds a warning", async () => {
    const result = await deliverInBackground({ ...click, background: { ...TARGET, pageHidden: true } }, async () => ({ success: true, data: "clicked" }))
    expect(result.success).toBe(true)
    expect(result.warning).toContain("page reports hidden")
  })

  test("a bridge failure returns the gate's refusal and hint, with the reason", async () => {
    const result = await deliverInBackground(click, async () => ({ success: false, error: "no on-screen window matches the tab's window (nothing was delivered)" }))
    expect(result.success).toBe(false)
    expect(result.error).toContain("window 5 is not the OS-focused window")
    expect(result.error).toContain("no on-screen window matches")
    expect((result.data as { hint: string }).hint).toBe(TARGET.hint)
  })

  test("an action the bridge cannot take is refused without calling it", async () => {
    let called = false
    const result = await deliverInBackground({ type: "os_click", background: TARGET }, async () => { called = true; return { success: true } })
    expect(called).toBe(false)
    expect(result).toEqual({ success: false, error: TARGET.error, data: { hint: TARGET.hint } })
  })
})

describe('portable browser background routing and outcomes',()=>{
  const click={type:'os_click',background:TARGET,windowBounds:BOUNDS,pageX:400,pageY:300,chromeUiHeight:81}
  for(const platform of ['win32','linux']){
    test(`${platform} targets the desktop provider with mandatory background-only delivery`,()=>{
      expect(bridgeActionFor(click,platform)).toEqual({type:'desktop_click',coords:'400,411',right:false,double:false,backgroundOnly:true,windowTitle:TARGET.title,windowBounds:BOUNDS})
      expect(bridgeActionFor({...click,type:'os_type',text:'🙂 文件'},platform)).toMatchObject({type:'desktop_type',text:'🙂 文件',backgroundOnly:true})
      expect(bridgeActionFor({...click,type:'os_key',key:'Enter'},platform)).toMatchObject({type:'desktop_keys',keys:'Enter',backgroundOnly:true})
    })
    test(`${platform} preserves actual receipt fields without claiming page acceptance`,async()=>{
      const receipt={method:'owned native receipt fixture',background:true,foregroundUsed:false,focusUnchanged:true,cursorUnchanged:true,targetPid:42,windowId:'84',delivered:2,effectRequiresObservation:true}
      const result=await deliverInBackground(click,async()=>({success:true,data:receipt}),platform)
      expect(result).toEqual({success:true,data:receipt})
    })
    test(`${platform} preserves an unknown outcome and never resends`,async()=>{
      let calls=0
      const details={dispatched:true,delivered:1,verified:false,effectRequiresObservation:true}
      const result=await deliverInBackground(click,async()=>{calls++;return{success:false,code:'timeout_unknown_outcome',error:'native window changed after press',details}},platform)
      expect(calls).toBe(1)
      expect(result).toMatchObject({success:false,code:'timeout_unknown_outcome',details})
      expect(result.error).toContain('native window changed after press')
    })
    test(`${platform} treats missing or contradictory receipt fields as unknown outcomes`,async()=>{
      const receipt={method:'owned native receipt fixture',background:true,foregroundUsed:false,targetPid:42,effectRequiresObservation:true}
      for(const data of ['delivered',{...receipt,background:false},{...receipt,foregroundUsed:true},{...receipt,foregroundUsed:undefined},{...receipt,targetPid:undefined},{...receipt,effectRequiresObservation:false}]){
        const result=await deliverInBackground(click,async()=>({success:true,data}),platform)
        expect(result).toMatchObject({success:false,code:'timeout_unknown_outcome',details:{dispatched:true,verified:false,effectRequiresObservation:true}})
      }
    })
  }
  test('zero browser UI inset and negative monitor origins retain their coordinates',()=>{
    expect(bridgeActionFor({...click,windowBounds:{left:-1920,top:-10,width:1920,height:1080},pageX:10.5,pageY:20.5,chromeUiHeight:0},'win32')).toMatchObject({coords:'-1910,10'})
  })
  test('invalid frames, unmapped coordinates, unsupported clicks and NUL text refuse before provider invocation',async()=>{
    for(const action of [{...click,pageX:NaN},{...click,pageX:-1},{...click,pageX:BOUNDS.width},{...click,pageY:BOUNDS.height},{...click,chromeUiHeight:-1},{...click,button:'middle'},{...click,clickCount:3},{...click,windowBounds:{...BOUNDS,width:0}},{...click,background:{...TARGET,title:'\0'}},{...click,type:'os_type',text:'x\0y'},{...click,type:'os_key',key:'Enter',modifiers:['Ctrl',3]}]){
      let called=false
      const result=await deliverInBackground(action,async()=>{called=true;return{success:true}},'win32')
      expect(result.success).toBe(false)
      expect(called).toBe(false)
    }
    expect(bridgeActionFor(click,'unsupported-host')).toBeNull()
  })
})
