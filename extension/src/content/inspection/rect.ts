import { resolveElementOrSelector } from "../input-simulation"
import { getInteractiveElements } from "../element-discovery"
import { getEffectiveRole } from "../a11y-tree"
import { queryAllDeep } from "../deep-query"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

// The iframe element that hosts child frame `frameId`, so a trusted click on a
// ref inside it can be placed in the top page. runtime.getFrameId is exact; the
// src match is the fallback and counts only when one iframe has that URL.
function frameHost(frameId: number, url: unknown): Element | null {
  const frames = queryAllDeep("iframe, frame")
  const getFrameId = (chrome.runtime as { getFrameId?: (target: Element) => number }).getFrameId
  if (typeof getFrameId === "function") {
    const exact = frames.find(f => { try { return getFrameId(f) === frameId } catch { return false } })
    if (exact) return exact
  }
  const bySrc = typeof url === "string" ? frames.filter(f => (f as HTMLIFrameElement).src === url) : []
  return bySrc.length === 1 ? bySrc[0] : null
}

export async function handleRect(action: Action): Promise<ActionResult> {
  const host = typeof action.hostOfFrame === "number"
  const el = host ? frameHost(action.hostOfFrame as number, action.hostUrl) : resolveElementOrSelector(action)
  if (!el) return { success: false, error: host ? "iframe not found" : "element not found" }
  const box = el.getBoundingClientRect()
  // A frame's viewport starts inside the iframe's border and padding.
  const style = host ? getComputedStyle(el) : null
  const r = {
    left: box.left + (style ? el.clientLeft + (parseFloat(style.paddingLeft) || 0) : 0),
    top: box.top + (style ? el.clientTop + (parseFloat(style.paddingTop) || 0) : 0),
    width: box.width, height: box.height, bottom: box.bottom, right: box.right,
  }
  return { success: true, data: {
    top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right,
    // For a trusted OS click: where the page starts inside the window, and
    // whether the browser has paused this page (a fully covered window).
    viewportHeight: window.innerHeight, pageHidden: document.visibilityState === "hidden"
  } }
}

export async function handleRegions(_action: Action): Promise<ActionResult> {
  const regionElements = getInteractiveElements()
  const regions = regionElements.map(e => {
    const rect = e.element.getBoundingClientRect()
    return {
      ref: e.refId,
      role: getEffectiveRole(e.element) || e.tag,
      name: e.text,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    }
  })
  regions.sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y)
  return { success: true, data: regions }
}
