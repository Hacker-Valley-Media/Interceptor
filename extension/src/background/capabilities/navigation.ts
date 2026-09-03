import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

// How long the page-side history.go() gets to start a navigation before we
// conclude there was nothing to go to.
const HISTORY_GO_START_MS = 2000

type HistoryDeps = { waitForTabLoad: (tabId: number) => Promise<unknown> }

async function waitForNavigationStart(tabId: number, beforeUrl: string, timeoutMs = HISTORY_GO_START_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) return false
    if (tab.status === "loading" || (tab.url ?? "") !== beforeUrl) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

// Issue #237. chrome.tabs.goBack/goForward reject with Chrome's "Cannot find a
// next page in history." whenever the adjacent entry is marked skippable by the
// history-manipulation intervention. Chromium treats extension-initiated
// navigations (tabs.create / tabs.update) as renderer-initiated without a user
// gesture, so every entry Interceptor itself produced is skippable and the tabs
// API can never step over it — while history.go() from inside the page still
// can (verified live: goBack rejected, page-side history.back() moved, and
// goForward then succeeded). Try the API first (it works for user-driven
// history), then drive the page's own history and verify the tab actually moved
// so "nothing to go back to" stays an honest error instead of a silent no-op.
export async function historyGo(tabId: number, delta: -1 | 1, deps: HistoryDeps = { waitForTabLoad }): Promise<ActionResult> {
  const label = delta < 0 ? "back" : "forward"
  const before = await chrome.tabs.get(tabId).catch(() => null)
  if (!before) return { success: false, error: `tab ${tabId} not found` }
  let apiError: string
  try {
    if (delta < 0) await chrome.tabs.goBack(tabId)
    else await chrome.tabs.goForward(tabId)
    await deps.waitForTabLoad(tabId)
    return { success: true }
  } catch (err) {
    apiError = (err as Error).message
  }
  // The injected function resolves with the event the page itself saw:
  // popstate/hashchange for a same-document entry (no document load follows,
  // so the load wait is skipped) or pagehide as a cross-document step begins.
  // A target entry with the SAME url is therefore still recognized as
  // movement; the tab-status poll below is the fallback.
  let ack: string | undefined
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: (d: number) => new Promise<string | false>((resolve) => {
        for (const ev of ["popstate", "hashchange", "pagehide"]) addEventListener(ev, () => resolve(ev), { once: true })
        setTimeout(() => resolve(false), 800)
        history.go(d)
      }),
      args: [delta] as [number],
    })
    const results = Array.isArray(injected) ? injected.map((r) => (r as { result?: unknown } | undefined)?.result) : []
    ack = results.find((r): r is string => typeof r === "string")
  } catch (err) {
    // A cross-document step can tear the injected context down before it
    // answers; that is only a failure when the tab did not move.
    if (!(await waitForNavigationStart(tabId, before.url ?? ""))) {
      return { success: false, error: `${apiError} (page-side history.${label}() also failed: ${(err as Error).message})` }
    }
    await deps.waitForTabLoad(tabId)
    return { success: true }
  }
  if (ack === "popstate" || ack === "hashchange") return { success: true }
  if (!ack && !(await waitForNavigationStart(tabId, before.url ?? ""))) {
    return { success: false, error: `no ${label} history for tab ${tabId} — nothing to go ${label} to` }
  }
  await deps.waitForTabLoad(tabId)
  return { success: true }
}

export async function handleNavigationActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: action.url as string })
      await waitForTabLoad(tabId)
      return { success: true }

    case "go_back":
      return historyGo(tabId, -1)

    case "go_forward":
      return historyGo(tabId, 1)

    case "reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache })
      await waitForTabLoad(tabId)
      return { success: true }
  }
  return { success: false, error: `unknown navigation action: ${action.type}` }
}
