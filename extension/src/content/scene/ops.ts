import { dispatchClickSequence, dispatchKeySequence } from "../input-simulation"
import type { SceneRect, SceneDocCoord } from "./types"

export function boundingBox(el: Element): SceneRect {
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
    cx: Math.round(r.left + r.width / 2),
    cy: Math.round(r.top + r.height / 2)
  }
}

export function isVisibleRect(r: SceneRect): boolean {
  return r.w > 0 && r.h > 0
}

const TRANSLATE_RE = /translate\(\s*(-?[\d.]+)(?:px)?\s*,\s*(-?[\d.]+)(?:px)?\s*\)/

export function parseTranslate(transform: string | null | undefined): { x: number; y: number } | null {
  if (!transform) return null
  const m = transform.match(TRANSLATE_RE)
  if (!m) return null
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
}

const SCALE_RE = /scale\(\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/

export function parseScale(transform: string | null | undefined): number | null {
  if (!transform) return null
  const m = transform.match(SCALE_RE)
  if (!m) return null
  return parseFloat(m[1])
}

export function findAncestorScale(el: Element): number | null {
  let cur: HTMLElement | null = el as HTMLElement
  for (let i = 0; i < 20 && cur; i++) {
    const s = parseScale(cur.style?.transform)
    if (s !== null) return s
    cur = cur.parentElement
  }
  return null
}

export function parseDocCoord(el: Element): SceneDocCoord | null {
  const he = el as HTMLElement
  const t = parseTranslate(he.style?.transform)
  const w = parseFloat(he.style?.width || "")
  const h = parseFloat(he.style?.height || "")
  if (!t || isNaN(w) || isNaN(h)) return null
  return { x: t.x, y: t.y, w, h }
}

export function scrollElementIntoView(el: Element): void {
  const r = el.getBoundingClientRect()
  if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
    try { (el as HTMLElement).scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior }) } catch {}
  }
}

export function clickElementCenter(el: Element): SceneRect {
  scrollElementIntoView(el)
  const r = boundingBox(el)
  // Use viewport-coordinate click via elementFromPoint so editors whose click
  // handlers are on ancestor layers (Canva, Google Docs canvas surface) receive
  // the event at the correct spatial location — dispatching on the LB element
  // directly would bypass the ancestor handler chain.
  clickAtViewport(r.cx, r.cy)
  return r
}

export function dblclickElementCenter(el: Element): SceneRect {
  scrollElementIntoView(el)
  const r = boundingBox(el)
  const rect = el.getBoundingClientRect()
  const opts = { bubbles: true, cancelable: true, clientX: r.cx, clientY: r.cy, button: 0 }
  dispatchClickSequence(el)
  el.dispatchEvent(new MouseEvent("dblclick", opts))
  void rect
  return r
}

export function clickAtViewport(x: number, y: number): Element | null {
  const el = document.elementFromPoint(x, y)
  if (!el) return null
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
  try {
    el.dispatchEvent(new PointerEvent("pointerover", opts))
    el.dispatchEvent(new MouseEvent("mouseover", opts))
    el.dispatchEvent(new PointerEvent("pointerdown", opts))
    el.dispatchEvent(new MouseEvent("mousedown", opts))
    if ((el as HTMLElement).focus) (el as HTMLElement).focus()
    el.dispatchEvent(new PointerEvent("pointerup", opts))
    el.dispatchEvent(new MouseEvent("mouseup", opts))
    el.dispatchEvent(new MouseEvent("click", opts))
  } catch {}
  return el
}

export function focusIframeTextbox(iframe: HTMLIFrameElement): { doc: Document; textbox: HTMLElement } | null {
  try {
    const doc = iframe.contentDocument
    if (!doc) return null
    const textbox = doc.querySelector<HTMLElement>('[role=textbox]') || doc.querySelector<HTMLElement>('[contenteditable]')
    if (!textbox) return null
    try { iframe.focus() } catch {}
    try { textbox.focus() } catch {}
    return { doc, textbox }
  } catch {
    return null
  }
}

export function dispatchKeysIn(target: Element, keys: string): void {
  dispatchKeySequence(target, keys)
}

export function findElementById(id: string): Element | null {
  try {
    const direct = document.getElementById(id)
    if (direct) return direct
  } catch {}
  try {
    return document.querySelector(`#${CSS.escape(id)}`)
  } catch {
    return null
  }
}
