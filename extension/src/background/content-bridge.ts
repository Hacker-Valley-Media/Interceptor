import { shouldRetryContentScript, INPUT_ACTIONS, isResponseLoss } from "../../../shared/content-script-retry"

async function injectContentScript(
  tabId: number,
  frameId?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const target = frameId !== undefined
      ? { tabId, frameIds: [frameId] }
      : { tabId }
    await chrome.scripting.executeScript({ target, files: ["content.js"] })
    await new Promise(resolve => setTimeout(resolve, 200))
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

type ContentScriptResult = { success: boolean; error?: string; data?: unknown; warning?: string }

const NAVIGATION_CAPABLE_ACTIONS = new Set(["click", "click_at", "dblclick", "find_and_click", "click_selector", "submit_form"])

/**
 * Safari can unload a content script before delivering its async sendResponse
 * callback when a click starts a navigation. Chrome closes the message channel
 * in that case; Safari may leave it pending forever. Treat a loading/url update
 * on the exact target tab as the acknowledgement for click-like actions only.
 */
export async function sendToContentScriptOnce(
  tabId: number,
  action: { type: string; [key: string]: unknown },
  frameId?: number
): Promise<ContentScriptResult> {
  const watchesNavigation = NAVIGATION_CAPABLE_ACTIONS.has(action.type)
  let initialUrl: string | undefined
  if (watchesNavigation) {
    try { initialUrl = (await chrome.tabs.get(tabId)).url } catch {}
  }

  return new Promise((resolve) => {
    let settled = false
    let navigationFailureTimer: ReturnType<typeof setTimeout> | null = null
    let navigationListener: ((
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => void) | null = null

    const finish = (result: ContentScriptResult): void => {
      if (settled) return
      settled = true
      if (navigationFailureTimer) clearTimeout(navigationFailureTimer)
      if (navigationListener) chrome.tabs.onUpdated.removeListener(navigationListener)
      resolve(result)
    }

    const navigationResult = (url?: string): ContentScriptResult => ({
      success: true,
      data: { navigated: true, url },
    })

    if (watchesNavigation) {
      navigationListener = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId) return
        if (changeInfo.status !== "loading" && typeof changeInfo.url !== "string") return
        finish(navigationResult(changeInfo.url ?? tab.url))
      }
      chrome.tabs.onUpdated.addListener(navigationListener)
    }

    const targetFrame = frameId !== undefined ? frameId : 0
    chrome.tabs.sendMessage(
      tabId,
      { type: "execute_action", action },
      { frameId: targetFrame } as chrome.tabs.MessageSendOptions,
      (response) => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message
          if (watchesNavigation && shouldRetryContentScript(error)) {
            // Chromium reports the closing message channel before onUpdated;
            // Safari can omit the callback and deliver only onUpdated. Keep the
            // listener alive briefly, then use the exact tab's URL/status as a
            // fallback instead of replaying a click against the new document.
            navigationFailureTimer = setTimeout(async () => {
              try {
                const tab = await chrome.tabs.get(tabId)
                if (
                  tab.status === "loading" ||
                  (typeof initialUrl === "string" && typeof tab.url === "string" && tab.url !== initialUrl)
                ) {
                  finish(navigationResult(tab.url))
                  return
                }
              } catch {}
              finish({ success: false, error })
            }, 250)
          } else {
            finish({ success: false, error })
          }
        } else {
          finish(response ?? { success: false, error: "no response from content script" })
        }
      }
    )
  })
}

// Detect Chrome-restricted origins where chrome.scripting.executeScript will
// always fail (chrome://, edge://, brave://, the Chrome Web Store, etc.).
// We surface a fast, actionable error in that case instead of waiting for
// the upstream timeout and surfacing the raw "Cannot access contents of"
// message.
function isChromeRestrictedInjectError(error: string | undefined): boolean {
  if (!error) return false
  return (
    /Cannot access (?:contents of )?(?:url|chrome|edge|brave|webstore)/i.test(error) ||
    /chrome:\/\/|chrome-untrusted:\/\/|edge:\/\/|brave:\/\//i.test(error) ||
    /chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(error) ||
    /Extensions cannot be added to/i.test(error)
  )
}

export async function sendToContentScript(
  tabId: number,
  action: { type: string; [key: string]: unknown },
  frameId?: number
): Promise<unknown> {
  const first = await sendToContentScriptOnce(tabId, action, frameId)
  if (first.success || !shouldRetryContentScript(first.error)) return first

  // A dead reply channel on a DELIVERED input action must not trigger a blind
  // re-execution — the action may have landed (a click that navigates tears
  // the channel down as a side effect of succeeding). Navigation cases for
  // click-like actions already resolve as {navigated:true} in
  // sendToContentScriptOnce; this guards the rest (worker death with the
  // reply in flight, same-URL reloads). Delivery failures ("Receiving end
  // does not exist") mean no receiver existed — those stay on the retry path
  // below for every action type. The guard runs after EVERY attempt: it used
  // to run only here, so "no receiver, then reply lost on the re-send" went on
  // to reinject and send a third time (retry probe, review 2026-09-10).
  const firstGuard = await inputReplayGuard(tabId, action, first)
  if (firstGuard) return firstGuard

  // Before reinjecting via executeScript (which re-evaluates content.js and
  // blows away the in-page refRegistry the consumer has been using), give the
  // manifest's `document_idle` auto-inject a brief window to fire and handle
  // the message. Most "Receiving end does not exist" errors on freshly-opened
  // http(s) tabs are timing races against document_idle, not genuine
  // missing-script states.
  await new Promise(resolve => setTimeout(resolve, 250))
  const retryWithoutInject = await sendToContentScriptOnce(tabId, action, frameId)
  if (retryWithoutInject.success) return retryWithoutInject
  const secondGuard = await inputReplayGuard(tabId, action, retryWithoutInject)
  if (secondGuard) return secondGuard
  // Reinjection follows only a recoverable delivery failure.
  if (!shouldRetryContentScript(retryWithoutInject.error)) return retryWithoutInject

  const injected = await injectContentScript(tabId, frameId)
  if (!injected.success) {
    if (isChromeRestrictedInjectError(injected.error)) {
      return {
        success: false,
        error: `tab ${tabId} has no content script and could not be re-injected (likely a chrome://, edge://, brave://, or Chrome Web Store page). Use 'interceptor open <url>' for a fresh tab.`,
      }
    }
    return {
      success: false,
      error: `content script unavailable on tab ${tabId} and reinjection failed: ${injected.error}`,
    }
  }

  const retried = await sendToContentScriptOnce(tabId, action, frameId)
  if (retried.success) return retried
  const thirdGuard = await inputReplayGuard(tabId, action, retried)
  if (thirdGuard) return thirdGuard

  return {
    success: false,
    error: `content script re-injected on tab ${tabId} but action still failed: ${retried.error || "unknown error"}`,
  }
}

/**
 * The delivered-but-reply-lost decision for one attempt. Returns the result to
 * hand back (never a retry) when the action is input-like and the channel died
 * after delivery; null when the caller may keep going.
 */
async function inputReplayGuard(
  tabId: number,
  action: { type: string; [key: string]: unknown },
  attempt: ContentScriptResult
): Promise<ContentScriptResult | null> {
  if (attempt.success || !INPUT_ACTIONS.has(action.type) || !isResponseLoss(attempt.error)) return null
  let navigating = false
  try { navigating = (await chrome.tabs.get(tabId)).status === "loading" } catch {}
  if (navigating) {
    return {
      success: true,
      data: `${action.type} delivered; the page began navigating before the reply arrived`,
      warning: "reply channel closed during navigation — re-read page state to confirm the outcome",
    }
  }
  return {
    success: false,
    error: `${action.type} was delivered but the reply channel closed (${attempt.error}) — not auto-retried to avoid firing it twice; re-read page state to confirm the outcome, then retry deliberately`,
  }
}

export async function sendNetDirect(
  tabId: number,
  msg: { type: string; [key: string]: unknown }
): Promise<unknown> {
  const sendOnce = (): Promise<{ success: boolean; error?: string; data?: unknown }> => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 } as chrome.tabs.MessageSendOptions, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message })
      } else {
        resolve(response ?? { success: false, error: "no response from content script" })
      }
    })
  })

  const first = await sendOnce()
  if (first.success || !shouldRetryContentScript(first.error)) return first

  const injected = await injectContentScript(tabId, 0)
  if (!injected.success) {
    return {
      success: false,
      error: `content script unavailable on tab ${tabId} and reinjection failed: ${injected.error}`
    }
  }

  const retried = await sendOnce()
  if (retried.success) return retried

  return {
    success: false,
    error: `content script re-injected on tab ${tabId} but message still failed: ${retried.error || "unknown error"}`
  }
}

/**
 * sendNetDirect, plus every child frame: each frame keeps its own net buffer and
 * MAIN-world wrapper. Array replies merge in time order; for writes (clear,
 * overrides) the top frame's reply stands once every frame has been told.
 */
export async function sendNetAllFrames(
  tabId: number,
  msg: { type: string; [key: string]: unknown }
): Promise<unknown> {
  const top = await sendNetDirect(tabId, msg) as { success: boolean; data?: unknown; error?: string }
  const nav = (chrome as unknown as { webNavigation?: typeof chrome.webNavigation }).webNavigation
  if (!top.success || typeof nav?.getAllFrames !== "function") return top
  let frames: { frameId: number }[] = []
  try { frames = (await nav.getAllFrames({ tabId })) ?? [] } catch {}
  const children = frames.filter((f) => f.frameId !== 0)
  if (!children.length) return top
  const replies = await Promise.all(children.map((f) => new Promise<{ success?: boolean; data?: unknown } | undefined>((resolve) => {
    // A frame without a net buffer (about:blank, restricted origin) answers with lastError; one that never answers is capped.
    const timer = setTimeout(() => resolve(undefined), 1500)
    chrome.tabs.sendMessage(tabId, msg, { frameId: f.frameId } as chrome.tabs.MessageSendOptions, (reply) => {
      void chrome.runtime.lastError
      clearTimeout(timer)
      resolve(reply)
    })
  })))
  if (!Array.isArray(top.data)) return top
  const at = (e: unknown) => {
    const r = e as { timestamp?: number; startTime?: number }
    return r?.timestamp ?? r?.startTime ?? 0
  }
  const merged = [...top.data, ...replies.flatMap((r) => r?.success && Array.isArray(r.data) ? r.data : [])]
  return { ...top, data: merged.sort((a, b) => at(a) - at(b)) }
}

type NavEvent = { addListener(cb: (d: { tabId: number; frameId: number }) => void): void; removeListener(cb: (d: { tabId: number; frameId: number }) => void): void }

/**
 * Settles a navigation once: at DOMContentLoaded of the committed document
 * plus one quiet window, or at `status: "complete"` plus one quiet window,
 * whichever comes first. Waiting for `complete` alone held every
 * reused-tab `open` and `navigate` until the page's last image and ad loaded.
 * DOMContentLoaded only counts after a frame-0 commit seen here, so an earlier
 * navigation of the same tab cannot end the wait. A back/forward-cache restore
 * never fires DOMContentLoaded (webNavigation.md, "Event order"), and Safari
 * and Electron may have no webNavigation, so the `complete` path stays.
 */
export function waitForTabLoad(
  tabId: number,
  timeoutMs = 15000,
  nav: { committed?: NavEvent; domContentLoaded?: NavEvent } = webNavigationEvents(),
  // A caller that can tell the new document apart (history: the URL changed)
  // passes a cheap check polled every 100 ms. A back/forward-cache restore
  // completes before these listeners attach and fires no DOMContentLoaded, so
  // without it `back` waited the full 10 s stage-1 timer (measured 10,062 ms).
  alreadyLoaded?: () => Promise<boolean>
): Promise<{ ready: boolean; elapsed: number; settledOn?: "dom" | "complete" | "timeout" }> {
  return new Promise((resolve) => {
    const start = Date.now()
    const stage1Timeout = Math.min(timeoutMs, 10000)
    let finished = false
    let committed = false

    const finish = async (settledOn: "dom" | "complete" | "timeout", minRemaining: number) => {
      if (finished) return
      finished = true
      clearTimeout(hardTimer)
      clearTimeout(stage1Timer)
      if (pollTimer) clearInterval(pollTimer)
      chrome.tabs.onUpdated.removeListener(listener)
      nav.committed?.removeListener(onCommitted)
      nav.domContentLoaded?.removeListener(onDomContentLoaded)
      const ready = await probeContentReady(tabId, Math.max(timeoutMs - (Date.now() - start), minRemaining))
      resolve({ ready, elapsed: Date.now() - start, settledOn })
    }

    const hardTimer = setTimeout(() => { void finish("timeout", 1000) }, timeoutMs)

    function listener(updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") void finish("complete", 2000)
    }
    function onCommitted(d: { tabId: number; frameId: number }) {
      if (d.tabId === tabId && d.frameId === 0) committed = true
    }
    function onDomContentLoaded(d: { tabId: number; frameId: number }) {
      if (d.tabId === tabId && d.frameId === 0 && committed) void finish("dom", 2000)
    }

    // Cleared on the listener path: a stray stage-1 probe would otherwise fire
    // seconds later against whatever tab state exists by then.
    const stage1Timer = setTimeout(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      if (tab && tab.status === "complete") void finish("complete", 2000)
    }, stage1Timeout)

    chrome.tabs.onUpdated.addListener(listener)
    nav.committed?.addListener(onCommitted)
    nav.domContentLoaded?.addListener(onDomContentLoaded)
    let polling = false
    const pollTimer = alreadyLoaded ? setInterval(async () => {
      if (polling || finished) return
      polling = true
      try { if (await alreadyLoaded()) void finish("complete", 2000) } catch {} finally { polling = false }
    }, 100) : undefined
  })
}

function webNavigationEvents(): { committed?: NavEvent; domContentLoaded?: NavEvent } {
  const wn = (chrome as unknown as { webNavigation?: { onCommitted?: NavEvent; onDOMContentLoaded?: NavEvent } }).webNavigation
  return { committed: wn?.onCommitted, domContentLoaded: wn?.onDOMContentLoaded }
}

/**
 * `wait_stable`, timed here and not in the page. A hidden tab throttles every
 * page timer to about one second (setTimeout, AbortSignal.timeout and
 * scheduler.postTask all measured so, 2026-10-31), so a 200 ms debounce run in
 * the page cost a second on every background tab. The page only reports how
 * long it has been quiet.
 */
export async function waitStable(
  tabId: number, debounceMs = 200, timeoutMs = 5000, frameId?: number
): Promise<ContentScriptResult> {
  const start = Date.now()
  const quiet = () => sendToContentScript(tabId, { type: "dom_quiet" }, frameId) as Promise<ContentScriptResult>
  let read = await quiet()
  try {
    while (read.success) {
      const { quietMs, mutations } = read.data as { quietMs: number; mutations: number }
      const elapsed = Date.now() - start
      if (quietMs >= debounceMs) return { success: true, data: { stable: true, elapsed, mutations } }
      if (elapsed >= timeoutMs) return { success: true, data: { stable: false, elapsed, mutations } }
      await new Promise(r => setTimeout(r, Math.min(debounceMs - quietMs, timeoutMs - elapsed)))
      read = await quiet()
    }
    return read
  } finally {
    sendToContentScriptOnce(tabId, { type: "dom_quiet", stop: true }, frameId).catch(() => {})
  }
}

export async function probeContentReady(tabId: number, timeoutMs: number): Promise<boolean> {
  try {
    const result = await waitStable(tabId, 500, Math.min(timeoutMs, 5000))
    return result.success && ((result.data as { stable?: boolean } | undefined)?.stable ?? true)
  } catch {
    return false
  }
}

type WaitConditionAction = { type: string; kind?: unknown; text?: unknown; selector?: unknown; count?: unknown; timeout?: unknown; [key: string]: unknown }

export function describeCondition(a: WaitConditionAction): string {
  switch (a.kind) {
    case "text": return `text "${a.text}"`
    case "gone": return `text "${a.text}" to disappear`
    case "url": return `the URL to contain "${a.text}"`
    case "selector": return typeof a.count === "number" ? `${a.count} or more matches for ${a.selector}` : `an element matching ${a.selector}`
    case "gone_selector": return `no element matching ${a.selector}`
    default: return String(a.kind)
  }
}

/**
 * `wait --text|--gone|--url|--selector|--count` and `act --until` 
 * Polled every 100 ms from the service worker: page timers in a hidden
 * tab are throttled to about a second. The URL is read from the tab, so the
 * wait survives a navigation; a page check that fails while a new document
 * loads is retried until the deadline. A timeout of 0 checks once (verify).
 */
const SINGLE_CHECK_MS = 5_000

export async function waitCondition(
  tabId: number,
  action: WaitConditionAction,
  frameId?: number,
  pollMs = 100,
): Promise<ContentScriptResult> {
  const timeout = Math.max(0, Number(action.timeout ?? 10_000) || 0)
  const start = Date.now()
  let observed = "not checked"
  // Whether the last look actually read the page. A wait that ends without
  // one reports met: null, so verify says unverifiable rather than failed.
  let readable = false
  for (;;) {
    let met = false
    if (action.kind === "url") {
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      const url = tab?.url ?? ""
      met = url.includes(String(action.text ?? ""))
      readable = !!tab
      observed = `URL is ${url || "(unknown)"}`
    } else {
      const check = sendToContentScriptOnce(tabId, { type: "condition_check", kind: action.kind, text: action.text, selector: action.selector, count: action.count }, frameId)
        .catch((err: Error) => ({ success: false, error: err.message }) as ContentScriptResult)
      // A frame that never answers (a busy or hung renderer) must not hold the
      // wait past its deadline; a reply after that is ignored. A single check
      // (timeout 0, as verify sends) gets a few seconds.
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = timeout === 0 ? SINGLE_CHECK_MS : Math.max(1, timeout - (Date.now() - start))
      const reply = await Promise.race([
        check,
        new Promise<ContentScriptResult>(r => { timer = setTimeout(() => r({ success: false, error: "the page did not answer" }), bound) }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if (reply.success) {
        const d = reply.data as { met?: boolean; observed?: string }
        met = d?.met === true
        readable = true
        observed = d?.observed ?? observed
      } else if (/unknown wait condition|invalid selector/.test(reply.error ?? "")) {
        return { success: false, error: reply.error }
      } else {
        readable = false
        observed = `page not readable yet (${reply.error ?? "no reply"})`
      }
    }
    const elapsed = Date.now() - start
    if (met) return { success: true, data: { met: true, elapsed, observed } }
    if (elapsed >= timeout) {
      return {
        success: false,
        error: timeout === 0 ? `not met: ${describeCondition(action)}; ${observed}` : `timed out after ${timeout} ms waiting for ${describeCondition(action)}; last seen: ${observed}`,
        data: { met: readable ? false : null, elapsed, observed },
      }
    }
    await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(1, timeout - elapsed))))
  }
}
