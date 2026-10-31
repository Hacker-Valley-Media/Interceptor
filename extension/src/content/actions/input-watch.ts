// What a trusted OS click or keystroke actually reached. The background arms
// this just before a background delivery and reads it after, so the result can
// say what the page received instead of what the OS accepted.

import { getShadowRoot } from "../element-discovery"

type Action = { type: string; [key: string]: unknown }

const WATCHED = ["pointerdown", "mousedown", "mouseup", "click", "keydown", "beforeinput", "input"]
// An event aimed at one of these lands in that frame's own document, where a
// listener here never hears it.
const FRAME_TAGS = new Set(["IFRAME", "FRAME", "FENCEDFRAME", "OBJECT", "EMBED"])

let seen: string[] = []
let disarm: (() => void) | null = null

function targetOf(x?: number, y?: number): Element | null {
  const inRoot = (root: DocumentOrShadowRoot) =>
    x !== undefined && y !== undefined ? root.elementFromPoint(x, y) : root.activeElement
  let el = inRoot(document)
  for (let root = el && getShadowRoot(el); root; root = el && getShadowRoot(el)) {
    const inner = inRoot(root)
    if (!inner || inner === el) break
    el = inner
  }
  return el
}

export function handleInputWatch(action: Action): { success: boolean; data: { armed: boolean } } {
  disarm?.()
  const target = targetOf(action.x as number | undefined, action.y as number | undefined)
  if (!target || FRAME_TAGS.has(target.tagName)) return { success: true, data: { armed: false } }

  const events: string[] = seen = []
  const note = (e: Event) => { if (e.isTrusted) events.push(e.type) }
  for (const type of WATCHED) window.addEventListener(type, note, true)
  const timer = setTimeout(() => disarm?.(), 10_000)
  disarm = () => {
    clearTimeout(timer)
    for (const type of WATCHED) window.removeEventListener(type, note, true)
    disarm = null
  }
  return { success: true, data: { armed: true } }
}

// No `events` means this document was never armed (a click navigated here), so
// its silence says nothing about the click.
export function handleInputWatchRead(): { success: boolean; data: { events?: string[]; hidden: boolean } } {
  return { success: true, data: { ...(disarm ? { events: [...seen] } : {}), hidden: document.visibilityState === "hidden" } }
}
