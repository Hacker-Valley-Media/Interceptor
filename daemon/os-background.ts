// Trusted browser input for a window that is not OS-focused.
//
// The HID tap (os-input.ts) reaches only the frontmost window. When the
// extension's gate reports an active tab in an unfocused window it returns a
// `background` target; this module turns the action into the bridge's
// window-addressed click / type / keys, which name the window by its frame and
// tab title. When the bridge cannot deliver, the caller gets the gate's
// original refusal and hint back.
//
// The actions go to the bridge's `bginput` domain, not to `macos_click` /
// `macos_type` / `macos_keys`. A bridge from before window-addressed input
// ignores the window fields on those and posts to the frontmost app; it has no
// `bginput` handler, so it refuses and nothing is delivered.

import { translateCoords } from "./os-input-loader"

export type BackgroundTarget = {
  title: string; error: string; hint: string; pageHidden?: boolean
  tabId?: number; frameId?: number; watching?: boolean
}

type OsAction = { type?: string; [key: string]: unknown }
type Result = { success: boolean; error?: string; data?: unknown; warning?: string; code?: string; details?: unknown; delivered?: boolean; received?: boolean }
type WindowBounds = { left: number; top: number; width: number; height: number }

// The read goes through the page's main thread, the same thread that handles
// the input, so a busy page delays the answer instead of faking silence.
const RECEIPT_READS = 4
const RECEIPT_WAIT_MS = 100

/**
 * Turns "the OS accepted it" into what the page reports receiving. A page that
 * cannot answer (it navigated away, an older extension, an iframe under the
 * point) gets the old result, which claims nothing. Only a page that answers
 * with silence fails, and a hidden one also names the tab to move.
 */
export async function confirmDelivery(
  result: Result,
  target: BackgroundTarget | undefined,
  readReceipt: () => Promise<Result>,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep
): Promise<Result> {
  if (!result.success || !target?.watching) return result
  let hidden = false
  for (let read = 0; read < RECEIPT_READS; read++) {
    await sleep(RECEIPT_WAIT_MS)
    const receipt = await readReceipt()
    const data = receipt.data as { events?: unknown; hidden?: unknown } | undefined
    if (!receipt.success || !Array.isArray(data?.events)) return result
    if (data.events.length > 0) {
      const { warning: _unneeded, ...received } = result
      return { ...received, data: `${result.data}; the page received it`, received: true }
    }
    hidden = data.hidden === true
  }
  return {
    success: false, delivered: false, received: false,
    error: "the OS accepted the input, but the page received nothing, so nothing happened. " +
      "A browser that is itself the frontmost app drops a background click: use synthetic input, or try again once the person has left the browser",
    data: { hint: target.hint, ...(hidden ? { moveTabId: target.tabId } : {}) },
  }
}

/**
 * One more try from a background window of the tab's own, then home again. A
 * tab that cannot be moved keeps the answer it already has.
 */
export async function deliverInOwnWindow(
  miss: Result,
  ask: (action: Record<string, unknown>) => Promise<Result>,
  retry: () => Promise<Result>
): Promise<Result> {
  const moved = await ask({ type: "os_detach" })
  if (!moved.success) return miss
  try {
    return await retry()
  } finally {
    await ask({ type: "os_return", home: moved.data })
  }
}

/** Action types the extension may answer with a `background` target. */
export const BACKGROUND_OS_ACTIONS = new Set(["os_click", "os_type", "os_key"])

const HIDDEN_PAGE_WARNING =
  "the page reports hidden and could not confirm the input; read it before retrying"

/** The bridge action for a background os_* action, or null when it lacks what delivery needs. */
export function bridgeActionFor(action: OsAction, platform: string = "darwin"): Record<string, unknown> | null {
  const target = action.background as BackgroundTarget | undefined
  const windowBounds = action.windowBounds as WindowBounds | undefined
  if (!target || typeof target.title !== "string" || !target.title || target.title.includes("\0") || Buffer.byteLength(target.title)>4096 || !windowBounds ||
      ![windowBounds.left,windowBounds.top,windowBounds.width,windowBounds.height].every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=2147483647) || windowBounds.width<=0 || windowBounds.height<=0) return null
  if (!["darwin","linux","win32"].includes(platform)) return null
  const portable=platform!=="darwin"
  const window = { windowTitle: target.title, windowBounds, ...(portable?{backgroundOnly:true}:{}) }
  const operation=(verb:string)=>portable?"desktop_"+verb:"macos_bginput_"+verb
  switch (action.type) {
    case "os_click": {
      const pageX = action.pageX as number | undefined
      const pageY = action.pageY as number | undefined
      const inset=action.chromeUiHeight===undefined?88:action.chromeUiHeight
      if (typeof pageX!=='number'||typeof pageY!=='number'||typeof inset!=='number'||![pageX,pageY,inset].every(Number.isFinite)||inset<0||inset>=windowBounds.height||pageX<0||pageY<0||pageX>=windowBounds.width||pageY>=windowBounds.height-inset||action.button!==undefined&&!['left','right'].includes(String(action.button))||action.clickCount!==undefined&&action.clickCount!==1&&action.clickCount!==2) return null
      const { screenX, screenY } = translateCoords(pageX, pageY, windowBounds, inset)
      const x=portable?Math.floor(screenX):screenX,y=portable?Math.floor(screenY):screenY
      if(Math.abs(x)>2147483647||Math.abs(y)>2147483647)return null
      return {
        type: operation("click"), coords: `${x},${y}`,
        right: action.button === "right", double: action.clickCount === 2, ...window,
      }
    }
    case "os_type":
      return typeof action.text === "string" && action.text && !action.text.includes('\0') && Buffer.byteLength(action.text)<=32768 ? { type: operation("type"), text: action.text, ...window } : null
    case "os_key": {
      if (typeof action.key !== "string" || !action.key || action.key.includes('\0') || Buffer.byteLength(action.key)>256) return null
      if(action.modifiers!==undefined&&(!Array.isArray(action.modifiers)||action.modifiers.length>4||action.modifiers.some(x=>typeof x!=='string'||!x||x.includes('\0')||Buffer.byteLength(x)>32)))return null
      const modifiers = Array.isArray(action.modifiers) ? action.modifiers as string[] : []
      return { type: operation("keys"), keys: [...modifiers, action.key].join("+"), ...window }
    }
    default:
      return null
  }
}

export async function deliverInBackground(
  action: OsAction,
  bridgeCall: (action: Record<string, unknown>) => Promise<Result>,
  platform: string = "darwin"
): Promise<Result> {
  const target = action.background as BackgroundTarget | undefined
  const refuse = (reason?: string): Result => ({
    success: false,
    error: reason ? `${target?.error??'background target unavailable'} (native background delivery failed: ${reason})` : target?.error??'background target unavailable',
    data: { hint: target?.hint??'read the target before another input action' },
  })
  const bridgeAction = bridgeActionFor(action,platform)
  if (!bridgeAction) return refuse()
  const result = await bridgeCall(bridgeAction)
  if (!result.success) return {...result,...refuse(result.error),data:{hint:target?.hint,...(result.data===undefined?{}:{nativeData:result.data})}}
  if(platform!=="darwin"){
    const receipt=result.data as Record<string,unknown>|undefined
    if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||receipt.background!==true||receipt.foregroundUsed!==false||typeof receipt.method!=='string'||!receipt.method||!Number.isSafeInteger(receipt.targetPid)||Number(receipt.targetPid)<=0||receipt.effectRequiresObservation!==true){
      return {...refuse("provider acknowledgment omitted the required background receipt; read the target before another action"),code:'timeout_unknown_outcome',data:{hint:target?.hint,nativeData:result.data},details:{dispatched:true,verified:false,effectRequiresObservation:true}}
    }
    return {success:true,data:receipt,...(target?.pageHidden?{warning:HIDDEN_PAGE_WARNING}:{})}
  }
  return {
    success: true,
    data: `delivered in the background, focus unchanged: ${typeof result.data === "string" ? result.data : "ok"}`,
    ...(target?.pageHidden ? { warning: HIDDEN_PAGE_WARNING } : {}),
  }
}
