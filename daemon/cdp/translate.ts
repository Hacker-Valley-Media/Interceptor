/**
 * daemon/cdp/translate.ts — map Interceptor actions onto CDP methods against a
 * connected target. Result envelopes match the browser surface ({success,data})
 * so an `app:`/`cdp:` context answers verbs identically to a browser tab.
 *
 * CDP surface verified against ~/Downloads/chromium-main:
 *   Runtime.evaluate (target_handler.cc:331-334), Page.navigate (Page.pdl:883-905),
 *   Page.captureScreenshot, Input.dispatchMouseEvent/dispatchKeyEvent/insertText
 *   (Input.pdl:96-207), Page.createIsolatedWorld.
 */

import type { CdpConnection } from "./connection"
import { jsonShape, redactHeaders } from "../../shared/cdp-app"

export type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export type CdpNetEntry = {
  requestId?: string
  url: string
  method: string
  status?: number
  resourceType?: string
  mimeType?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  bodyShape?: unknown
  timestamp: number
}

export type HeaderOverrideRule = {
  /** Substring matched against the request URL; empty matches all. */
  urlPattern?: string
  /** Header name → value to set (added or replaced). */
  setHeaders?: Record<string, string>
}

export type CdpExecContext = {
  conn: CdpConnection
  net: { enabled: boolean; entries: CdpNetEntry[] }
  ensureNetwork: () => Promise<void>
  isolatedContextId?: number
  /** Enable Fetch-based request/header override (Path A). Provided by the manager. */
  setOverrides?: (rules: HeaderOverrideRule[]) => Promise<void>
  clearOverrides?: () => Promise<void>
}

/**
 * Pure: merge override headers onto a request's existing headers, producing the
 * CDP `Fetch.continueRequest` `headers` array. Override rules win. Unit-tested.
 */
export function mergeHeaderEntries(
  existing: Record<string, string> | undefined,
  rules: HeaderOverrideRule[],
  url: string,
): Array<{ name: string; value: string }> {
  const merged = new Map<string, string>()
  for (const [k, v] of Object.entries(existing ?? {})) merged.set(k, v)
  for (const rule of rules) {
    if (rule.urlPattern && !url.includes(rule.urlPattern)) continue
    for (const [k, v] of Object.entries(rule.setHeaders ?? {})) {
      // replace case-insensitively
      for (const existingKey of [...merged.keys()]) {
        if (existingKey.toLowerCase() === k.toLowerCase()) merged.delete(existingKey)
      }
      merged.set(k, v)
    }
  }
  return [...merged.entries()].map(([name, value]) => ({ name, value }))
}

/**
 * Pure 1:1 mapping for the simple actions — used by the executor and unit tests.
 * Returns null for actions that need multi-step handling (eval result wrapping,
 * read serialization, ref→coords resolution, net buffering).
 */
export function cdpMethodForAction(action: { type: string; [k: string]: unknown }): { method: string; params: Record<string, unknown> } | null {
  switch (action.type) {
    case "navigate":
      return { method: "Page.navigate", params: { url: String(action.url ?? "") } }
    case "reload":
      return { method: "Page.reload", params: {} }
    case "go_back":
    case "go_forward":
      // Handled via Page.getNavigationHistory + navigateToHistoryEntry in executor.
      return null
    case "screenshot":
    case "screenshot_background":
      return { method: "Page.captureScreenshot", params: screenshotParams(action) }
    case "type": {
      const text = String(action.text ?? "")
      return { method: "Input.insertText", params: { text } }
    }
    default:
      return null
  }
}

function screenshotParams(action: { [k: string]: unknown }): Record<string, unknown> {
  const format = action.format === "jpeg" || action.format === "jpg" ? "jpeg"
    : action.format === "webp" ? "webp" : "png"
  const params: Record<string, unknown> = { format, captureBeyondViewport: false }
  if (format === "jpeg" && typeof action.quality === "number") params.quality = action.quality
  return params
}

function exceptionText(exceptionDetails: Record<string, unknown> | undefined): string {
  if (!exceptionDetails) return "evaluation failed"
  const ex = exceptionDetails.exception as { description?: string; value?: unknown } | undefined
  if (ex?.description) return ex.description
  if (typeof exceptionDetails.text === "string") return exceptionDetails.text
  return "evaluation failed"
}

async function evalInPage(
  conn: CdpConnection,
  expression: string,
  contextId?: number,
): Promise<ActionResult> {
  const params: Record<string, unknown> = {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
  }
  if (contextId !== undefined) params.contextId = contextId
  const r = await conn.send("Runtime.evaluate", params)
  if (r.exceptionDetails) {
    return { success: false, error: exceptionText(r.exceptionDetails as Record<string, unknown>) }
  }
  const result = r.result as { value?: unknown } | undefined
  return { success: true, data: result?.value }
}

async function isolatedContextId(ctx: CdpExecContext): Promise<number | undefined> {
  if (ctx.isolatedContextId !== undefined) return ctx.isolatedContextId
  try {
    const tree = await ctx.conn.send("Page.getFrameTree")
    const frameId = ((tree.frameTree as { frame?: { id?: string } } | undefined)?.frame?.id)
    if (!frameId) return undefined
    const world = await ctx.conn.send("Page.createIsolatedWorld", {
      frameId, worldName: "interceptor", grantUniveralAccess: true,
    })
    const id = typeof world.executionContextId === "number" ? world.executionContextId : undefined
    ctx.isolatedContextId = id
    return id
  } catch {
    return undefined
  }
}

// JS snippets reused for read verbs (the page-world serializer lands in the MV2
// path; the CDP fallback uses these lighter expressions).
const READ_TEXT = `(()=>{const b=document.body||document.documentElement;return b?b.innerText:""})()`
const READ_HTML = `document.documentElement.outerHTML`
// Shape matches cli/format.ts formatState (url/title/elementTree/scrollPosition/tabId).
const READ_STATE = `(()=>({url:location.href,title:document.title,elementTree:"(CDP app surface — use 'eval' + document.querySelector for element refs, or 'screenshot')",scrollPosition:{y:Math.round(scrollY),height:document.documentElement.scrollHeight,viewportHeight:innerHeight},tabId:0,focused:(document.activeElement&&(document.activeElement.tagName||"")).toLowerCase()||undefined,staticText:((document.body||document.documentElement)||{innerText:""}).innerText.slice(0,4000)}))()`

function hasElementTarget(action: { [k: string]: unknown }): boolean {
  return typeof action.ref === "string" || action.index !== undefined || action.semantic !== undefined
}

function serializerUnsupported(verb: string): ActionResult {
  return {
    success: false,
    error: `'${verb}' (DOM tree / element refs) needs the injected page serializer, which is not on the CDP app surface yet. Use 'eval' with document.querySelector(...), or 'screenshot'.`,
  }
}

async function resolveCoords(conn: CdpConnection, action: { [k: string]: unknown }): Promise<{ x: number; y: number } | null> {
  if (typeof action.x === "number" && typeof action.y === "number") {
    return { x: action.x, y: action.y }
  }
  const selector = typeof action.selector === "string" ? action.selector
    : typeof action.ref === "string" ? action.ref : undefined
  if (!selector) return null
  const expr = `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`
  const res = await evalInPage(conn, expr)
  if (res.success && res.data && typeof res.data === "object") {
    const c = res.data as { x?: number; y?: number }
    if (typeof c.x === "number" && typeof c.y === "number") return { x: c.x, y: c.y }
  }
  return null
}

async function dispatchClick(conn: CdpConnection, x: number, y: number, button: "left" | "right", clickCount: number): Promise<void> {
  const buttons = button === "right" ? 2 : 1
  await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount })
  await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons, clickCount })
}

/** Full executor: drives the connection and returns the Interceptor envelope. */
export async function executeCdpAction(ctx: CdpExecContext, action: { type: string; [k: string]: unknown }): Promise<ActionResult> {
  const { conn } = ctx
  try {
    switch (action.type) {
      case "evaluate": {
        const code = String(action.code ?? "")
        const world = action.world === "ISOLATED" ? "ISOLATED" : "MAIN"
        if (world === "ISOLATED") {
          const ctxId = await isolatedContextId(ctx)
          if (ctxId !== undefined) return await evalInPage(conn, code, ctxId)
        }
        return await evalInPage(conn, code)
      }

      case "get_state":
        return await evalInPage(conn, READ_STATE)
      // CLI read verbs: `text`/`text --markdown` (full page when no ref).
      case "extract_text":
      case "extract_markdown":
        if (hasElementTarget(action)) return serializerUnsupported(action.type)
        return await evalInPage(conn, READ_TEXT)
      case "text": // raw action alias
        return await evalInPage(conn, READ_TEXT)
      case "html":
        return await evalInPage(conn, READ_HTML)
      // `html <ref>` and the tree/find/diff verbs depend on the page-world serializer.
      case "extract_html":
      case "get_a11y_tree":
      case "cdp_tree":
      case "find_element":
      case "diff":
        return serializerUnsupported(action.type)

      case "navigate":
        await conn.send("Page.enable").catch(() => {})
        return wrap(await conn.send("Page.navigate", { url: String(action.url ?? "") }))
      case "reload":
        return wrap(await conn.send("Page.reload", {}))
      case "go_back":
        await evalInPage(conn, "history.back()")
        return { success: true, data: { navigated: "back" } }
      case "go_forward":
        await evalInPage(conn, "history.forward()")
        return { success: true, data: { navigated: "forward" } }

      case "screenshot":
      case "screenshot_background": {
        const r = await conn.send("Page.captureScreenshot", screenshotParams(action))
        const b64 = typeof r.data === "string" ? r.data : ""
        const format = (screenshotParams(action).format as string) || "png"
        const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png"
        // Default to saving a file (matches the browser surface). Pass save:false
        // (e.g. for --json dataURL consumers) to get the dataURL inline instead.
        return { success: true, data: { dataUrl: `data:${mime};base64,${b64}`, format, save: action.save !== false } }
      }

      // `type` (CLI: input_text) — inserts into the FOCUSED element (CDP has no
      // element refs; focus the field first, e.g. with click_at).
      case "type":
      case "input_text": {
        const text = String(action.text ?? "")
        await conn.send("Input.insertText", { text })
        return { success: true, data: { typed: text.length, note: "inserted into the focused element (CDP surface has no element refs — focus the field first, e.g. with click_at)" } }
      }

      // `keys` (CLI: send_keys) — dispatched to the focused element.
      case "keys":
      case "send_keys": {
        const key = String(action.key ?? action.keys ?? "")
        if (!key) return { success: false, error: "no key given" }
        await conn.send("Input.dispatchKeyEvent", { type: "keyDown", key })
        await conn.send("Input.dispatchKeyEvent", { type: "keyUp", key })
        return { success: true, data: { key } }
      }

      case "scroll": {
        const dir = String(action.direction ?? "down")
        const amount = typeof action.amount === "number" ? String(action.amount) : "Math.round(innerHeight*0.8)"
        const expr = dir === "top" ? "window.scrollTo(0,0)"
          : dir === "bottom" ? "window.scrollTo(0,document.documentElement.scrollHeight)"
          : dir === "up" ? `window.scrollBy(0,-(${amount}))`
          : `window.scrollBy(0,(${amount}))`
        await evalInPage(conn, expr)
        return { success: true, data: { scrolled: dir } }
      }

      // Coordinate clicks (CLI: click_at X Y) work; ref-based click needs the serializer.
      case "click":
      case "click_at":
      case "click-at":
      case "rightclick":
      case "dblclick": {
        const coords = await resolveCoords(conn, action)
        if (!coords) {
          return {
            success: false,
            error: "click target not resolvable on the CDP surface (element refs need the injected serializer). Use 'click-at X Y', or 'eval' with document.querySelector(sel).click().",
          }
        }
        const button = action.type === "rightclick" ? "right" : "left"
        const clickCount = action.type === "dblclick" ? 2 : 1
        await dispatchClick(conn, coords.x, coords.y, button, clickCount)
        return { success: true, data: { at: coords, button, clickCount } }
      }

      // Ref/serializer-dependent interaction verbs — honest pointer to eval.
      case "hover":
      case "focus":
      case "blur":
      case "check":
      case "select_option":
      case "drag":
      case "find_and_click":
      case "find_and_type":
      case "what_at":
      case "regions":
      case "get_focus":
        return serializerUnsupported(action.type)

      case "net_capture": {
        await ctx.ensureNetwork()
        return { success: true, data: { capturing: true } }
      }
      case "net_log": {
        await ctx.ensureNetwork()
        return { success: true, data: ctx.net.entries }
      }
      case "net_clear": {
        ctx.net.entries.length = 0
        return { success: true, data: { cleared: true } }
      }
      case "net_headers": {
        await ctx.ensureNetwork()
        return { success: true, data: ctx.net.entries.map(e => ({ url: e.url, status: e.status, requestHeaders: e.requestHeaders, responseHeaders: e.responseHeaders })) }
      }
      case "set_net_overrides": {
        if (!ctx.setOverrides) return { success: false, error: "header override not available on this context" }
        const rules = Array.isArray(action.rules) ? action.rules as HeaderOverrideRule[]
          : Array.isArray(action.overrides) ? action.overrides as HeaderOverrideRule[] : []
        await ctx.setOverrides(rules)
        return { success: true, data: { overrides: rules.length } }
      }
      case "clear_net_overrides": {
        if (ctx.clearOverrides) await ctx.clearOverrides()
        return { success: true, data: { cleared: true } }
      }

      default:
        return { success: false, error: `action '${action.type}' is not supported over the CDP app surface` }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

function wrap(result: Record<string, unknown>): ActionResult {
  return { success: true, data: result }
}

/** Fold a CDP Network.* event into a redacted ring-buffer entry. */
export function recordNetworkEvent(buffer: CdpNetEntry[], method: string, params: Record<string, unknown>, cap = 500): void {
  const requestId = typeof params.requestId === "string" ? params.requestId : undefined
  if (method === "Network.requestWillBeSent") {
    const request = params.request as { url?: string; method?: string; headers?: Record<string, string> } | undefined
    if (!request?.url) return
    // A redirect arrives as a NEW requestWillBeSent carrying `redirectResponse`
    // for the SAME requestId — close out the prior hop before adding the new one.
    const redirect = params.redirectResponse as { status?: number; headers?: Record<string, string> } | undefined
    if (redirect && requestId) {
      const prior = findOpenEntry(buffer, requestId)
      if (prior) {
        prior.status = redirect.status
        prior.responseHeaders = redactHeaders(redirect.headers) as Record<string, string> | undefined
      }
    }
    buffer.push({
      requestId,
      url: request.url,
      method: request.method || "GET",
      resourceType: typeof params.type === "string" ? params.type : undefined,
      requestHeaders: redactHeaders(request.headers) as Record<string, string> | undefined,
      timestamp: Date.now(),
    })
    while (buffer.length > cap) buffer.shift()
  } else if (method === "Network.responseReceived") {
    const response = params.response as { status?: number; mimeType?: string; headers?: Record<string, string> } | undefined
    if (!response || !requestId) return
    // Correlate by requestId (not URL) so concurrent same-URL requests don't cross.
    const entry = findOpenEntry(buffer, requestId)
    if (entry) {
      entry.status = response.status
      entry.mimeType = response.mimeType
      entry.responseHeaders = redactHeaders(response.headers) as Record<string, string> | undefined
    }
  }
}

function findOpenEntry(buffer: CdpNetEntry[], requestId: string): CdpNetEntry | undefined {
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].requestId === requestId && buffer[i].status === undefined) return buffer[i]
  }
  return undefined
}

export { jsonShape }
