import { getAccessibleName, getEffectiveRole } from "../a11y-tree"
import { getShadowRoot, isVisible, walkWithShadow } from "../element-discovery"
import { boundingBox, clickAtViewport } from "./ops"
import type {
  SceneObject,
  SceneObjectType,
  SceneProfileDescription,
  SceneRect,
  SceneResolvedTarget,
  SceneSelection,
  SceneText,
  SceneWriteResult
} from "./types"

const sceneRefRegistry = new Map<string, WeakRef<Element>>()
const sceneElementToId = new WeakMap<Element, string>()
const sceneRefMeta = new Map<string, { signature: string; type: SceneObjectType; strategy: string }>()
let nextSceneId = 1
let cachedDiscovery:
  | {
      key: string
      generatedAt: number
      objects: SceneObject[]
    }
  | null = null

type Candidate = {
  el: Element
  type: SceneObjectType
  strategy: string
  text?: string
  extras?: Record<string, unknown>
}

export interface AdaptiveSceneOptions {
  type?: string
  profileName?: string
  notes?: string[]
}

function discoveryCacheKey(): string {
  const structuralCount = document.querySelectorAll(
    '[data-page-id], [role="application"], [role="document"], [role="main"], [contenteditable="true"], canvas, svg'
  ).length
  const active = document.activeElement as HTMLElement | null
  const activeSig = active
    ? [active.tagName, active.getAttribute("role") || "", active.getAttribute("aria-label") || "", active.getAttribute("data-hidden-input") || ""].join("|")
    : "none"
  return [location.href, structuralCount, activeSig].join("::")
}

function isHtmlElement(el: Element | null | undefined): el is HTMLElement {
  return !!el && el instanceof HTMLElement
}

function normalizeRect(rect: SceneRect): string {
  return `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.w)}:${Math.round(rect.h)}`
}

function candidateArea(rect: SceneRect): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h)
}

function isLikelyWritable(el: Element): boolean {
  if (!isHtmlElement(el)) return false
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return true
  const role = el.getAttribute("role")
  return role === "textbox" || role === "searchbox" || role === "combobox" || role === "application"
}

function isHiddenProxyInput(el: Element): boolean {
  if (!isHtmlElement(el) || el.tagName !== "INPUT") return false
  const hiddenAttr = el.getAttribute("data-hidden-input")
  const inputMode = el.getAttribute("inputmode")
  const role = el.getAttribute("role")
  return hiddenAttr === "true" || (role === "application" && inputMode === "none")
}

function readElementText(el: Element): string {
  if (!isHtmlElement(el)) return ""
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    return ((el as HTMLInputElement | HTMLTextAreaElement).value || "").toString()
  }
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
    return (el.textContent || "").toString()
  }
  const role = el.getAttribute("role")
  if (role === "textbox" || role === "combobox" || role === "searchbox") {
    return (el.textContent || "").toString()
  }
  return (getAccessibleName(el) || el.getAttribute("aria-label") || el.textContent || "").toString()
}

function visibleOrActive(el: Element): boolean {
  return isVisible(el) || document.activeElement === el
}

function candidateLabel(el: Element): string | undefined {
  const text = readElementText(el).trim()
  if (text) return text.slice(0, 80)
  const aria = el.getAttribute("aria-label") || getAccessibleName(el)
  return aria ? aria.slice(0, 80) : undefined
}

function isPageLikeSurface(el: Element, rect: SceneRect): boolean {
  const area = candidateArea(rect)
  const viewportArea = window.innerWidth * window.innerHeight
  if (el.hasAttribute("data-page-id")) return true
  if (!isHtmlElement(el)) return false
  const inlineStyle = el.getAttribute("style") || ""
  const centered = rect.cx >= window.innerWidth * 0.15 && rect.cx <= window.innerWidth * 0.85
  if (!centered) return false
  if (area >= viewportArea * 0.12 && (inlineStyle.includes("transform") || inlineStyle.includes("touch-action"))) return true
  return false
}

function maybeClassifyCandidate(el: Element): Candidate | null {
  const rect = boundingBox(el)
  if (rect.w < 2 || rect.h < 2) return null
  if (!visibleOrActive(el)) return null

  const tag = el.tagName.toLowerCase()
  const role = getEffectiveRole(el)
  const area = candidateArea(rect)
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)

  if (el.hasAttribute("data-page-id")) {
    return {
      el,
      type: "page",
      strategy: "page-container",
      text: candidateLabel(el),
      extras: { pageId: el.getAttribute("data-page-id") || undefined }
    }
  }

  if (tag === "canvas" && area >= viewportArea * 0.08) {
    return { el, type: "page", strategy: "graphic-surface", text: candidateLabel(el) }
  }

  if (tag === "svg" && area >= viewportArea * 0.02) {
    return {
      el,
      type: area >= viewportArea * 0.12 ? "page" : "shape",
      strategy: "graphic-surface",
      text: candidateLabel(el)
    }
  }

  if (role === "application" || role === "document" || role === "main") {
    const hiddenProxy = isHiddenProxyInput(el)
    if (hiddenProxy || area >= viewportArea * 0.04 || document.activeElement === el) {
      return {
        el,
        type: role === "main" || role === "document" ? "page" : "group",
        strategy: hiddenProxy ? "focus-proxy" : "semantic-root",
        text: candidateLabel(el),
        extras: { hiddenProxy }
      }
    }
  }

  if (isLikelyWritable(el)) {
    return {
      el,
      type: "text",
      strategy: isHiddenProxyInput(el) ? "focus-proxy" : "writable-surface",
      text: candidateLabel(el),
      extras: {
        writable: true,
        hiddenProxy: isHiddenProxyInput(el),
        focused: document.activeElement === el
      }
    }
  }

  if (isPageLikeSurface(el, rect)) {
    return {
      el,
      type: "page",
      strategy: "structural-surface",
      text: candidateLabel(el)
    }
  }

  return null
}

function elementSignature(el: Element): string {
  const rect = boundingBox(el)
  const pageId = el.getAttribute("data-page-id") || ""
  const role = el.getAttribute("role") || ""
  const aria = (el.getAttribute("aria-label") || getAccessibleName(el) || "").slice(0, 60)
  return [
    el.tagName.toLowerCase(),
    role,
    pageId,
    aria,
    normalizeRect(rect)
  ].join("|")
}

export function getOrAssignSceneId(el: Element, type: SceneObjectType, strategy: string): string {
  const existing = sceneElementToId.get(el)
  if (existing) {
    const ref = sceneRefRegistry.get(existing)
    if (ref?.deref() === el) return existing
  }
  const id = `s${nextSceneId++}`
  sceneRefRegistry.set(id, new WeakRef(el))
  sceneElementToId.set(el, id)
  sceneRefMeta.set(id, { signature: elementSignature(el), type, strategy })
  return id
}

export function resolveSceneId(id: string): Element | null {
  const ref = sceneRefRegistry.get(id)
  if (ref) {
    const el = ref.deref()
    if (el && el.isConnected) return el
  }
  const meta = sceneRefMeta.get(id)
  if (!meta) return null
  let found: Element | null = null
  walkWithShadow(document.body, (el) => {
    if (found || !visibleOrActive(el)) return
    if (elementSignature(el) === meta.signature) found = el
  })
  if (found) {
    sceneRefRegistry.set(id, new WeakRef(found))
    sceneElementToId.set(found, id)
  }
  return found
}

export function discoverAdaptiveSceneObjects(opts?: AdaptiveSceneOptions): SceneObject[] {
  const cacheKey = discoveryCacheKey()
  if (cachedDiscovery && cachedDiscovery.key === cacheKey && Date.now() - cachedDiscovery.generatedAt < 1000) {
    return opts?.type ? cachedDiscovery.objects.filter((o) => o.type === opts.type) : cachedDiscovery.objects
  }
  const out: SceneObject[] = []
  const seen = new Set<string>()
  walkWithShadow(document.body, (el) => {
    const candidate = maybeClassifyCandidate(el)
    if (!candidate) return
    if (opts?.type && opts.type !== candidate.type) return
    const rect = boundingBox(candidate.el)
    const key = `${candidate.type}:${candidate.strategy}:${normalizeRect(rect)}`
    if (seen.has(key)) return
    seen.add(key)
    const id = getOrAssignSceneId(candidate.el, candidate.type, candidate.strategy)
    out.push({
      id,
      type: candidate.type,
      rect,
      text: candidate.text,
      extras: {
        ...(candidate.extras || {}),
        strategy: candidate.strategy,
        profile: opts?.profileName || "generic"
      }
    })
  })
  const sorted = out.sort((a, b) => {
    const areaDiff = candidateArea(b.rect) - candidateArea(a.rect)
    if (areaDiff !== 0) return areaDiff
    return a.id.localeCompare(b.id)
  })
  cachedDiscovery = {
    key: cacheKey,
    generatedAt: Date.now(),
    objects: sorted
  }
  return opts?.type ? sorted.filter((o) => o.type === opts.type) : sorted
}

export function resolveAdaptiveSceneTarget(id: string): SceneResolvedTarget | null {
  const el = resolveSceneId(id)
  if (!el) return null
  return {
    id,
    element: el,
    rect: boundingBox(el),
    text: candidateLabel(el),
    extras: {
      role: getEffectiveRole(el),
      hiddenProxy: isHiddenProxyInput(el),
      writable: isLikelyWritable(el)
    }
  }
}

export function hitTestAdaptiveScene(x: number, y: number): SceneObject | null {
  const list = discoverAdaptiveSceneObjects({ profileName: "generic" })
  let best: SceneObject | null = null
  let bestArea = Infinity
  for (const item of list) {
    if (x >= item.rect.x && x <= item.rect.x + item.rect.w && y >= item.rect.y && y <= item.rect.y + item.rect.h) {
      const area = candidateArea(item.rect)
      if (area < bestArea) {
        bestArea = area
        best = item
      }
    }
  }
  if (best) return best
  const el = document.elementFromPoint(x, y)
  const candidate = el ? maybeClassifyCandidate(el) : null
  if (!candidate) return null
  const id = getOrAssignSceneId(candidate.el, candidate.type, candidate.strategy)
  return {
    id,
    type: candidate.type,
    rect: boundingBox(candidate.el),
    text: candidate.text,
    extras: {
      ...(candidate.extras || {}),
      strategy: candidate.strategy
    }
  }
}

function deepestActiveElement(root: Document | ShadowRoot = document): HTMLElement | null {
  let active = (root as Document).activeElement as HTMLElement | null
  while (active) {
    const shadow = getShadowRoot(active)
    const nested = shadow?.activeElement as HTMLElement | null
    if (!nested || nested === active) break
    active = nested
  }
  return active
}

type WritableSurface = {
  element: HTMLElement
  kind: "input" | "textarea" | "contenteditable" | "textbox" | "hidden-input" | "application-proxy"
  text: string
}

export function findFocusedWritableSurface(): WritableSurface | null {
  const active = deepestActiveElement()
  if (!active) return null
  const tag = active.tagName
  const role = active.getAttribute("role")

  if (tag === "TEXTAREA") {
    return { element: active, kind: "textarea", text: (active as HTMLTextAreaElement).value || "" }
  }
  if (tag === "INPUT") {
    const hiddenProxy = isHiddenProxyInput(active)
    return {
      element: active,
      kind: hiddenProxy ? (role === "application" ? "application-proxy" : "hidden-input") : "input",
      text: (active as HTMLInputElement).value || ""
    }
  }
  if (active.isContentEditable || active.getAttribute("contenteditable") === "true") {
    return { element: active, kind: "contenteditable", text: active.textContent || "" }
  }
  if (role === "textbox" || role === "combobox" || role === "searchbox") {
    return { element: active, kind: "textbox", text: active.textContent || "" }
  }
  return null
}

export function readFocusedWritableText(): SceneText | null {
  const surface = findFocusedWritableSurface()
  if (!surface) return null
  return {
    text: surface.text,
    length: surface.text.length
  }
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): boolean {
  const tag = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(tag, "value")?.set
  if (setter) setter.call(el, text)
  else el.value = text
  el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }))
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return el.value === text
}

export function writeToFocusedWritableSurface(text: string, clear = false): SceneWriteResult {
  const surface = findFocusedWritableSurface()
  if (!surface) return { success: false, error: "no focused writable editor surface" }
  const current = surface.text
  const next = clear ? text : current + text
  try {
    surface.element.focus()
  } catch {}

  if (surface.kind === "input" || surface.kind === "textarea" || surface.kind === "hidden-input" || surface.kind === "application-proxy") {
    const ok = setInputValue(surface.element as HTMLInputElement | HTMLTextAreaElement, next)
    return {
      success: ok,
      error: ok ? undefined : "focused input surface did not accept the value update",
      method: "dom",
      verified: ok
    }
  }

  if (surface.kind === "contenteditable") {
    try {
      if (clear) {
        document.execCommand("selectAll", false)
        document.execCommand("delete", false)
      }
      document.execCommand("insertText", false, text)
      surface.element.dispatchEvent(new Event("input", { bubbles: true }))
      const updated = surface.element.textContent || ""
      const verified = clear ? updated === text : updated.includes(text)
      return {
        success: verified,
        error: verified ? undefined : "contenteditable surface did not reflect inserted text",
        method: "dom",
        verified
      }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  if (surface.kind === "textbox") {
    surface.element.textContent = next
    surface.element.dispatchEvent(new Event("input", { bubbles: true }))
    const updated = surface.element.textContent || ""
    const verified = updated === next
    return {
      success: verified,
      error: verified ? undefined : "textbox surface did not reflect inserted text",
      method: "dom",
      verified
    }
  }

  return { success: false, error: "focused writable surface is unsupported" }
}

export function selectedAdaptiveScene(): SceneSelection {
  const writable = findFocusedWritableSurface()
  if (writable) {
    const id = getOrAssignSceneId(writable.element, "text", "focused-writable")
    const label = getAccessibleName(writable.element) || writable.element.getAttribute("aria-label") || writable.kind
    return {
      has: true,
      id,
      label,
      text: writable.text.slice(0, 200),
      extras: {
        kind: writable.kind,
        writable: true,
        focused: true
      }
    }
  }

  const active = deepestActiveElement()
  if (active) {
    const id = getOrAssignSceneId(active, "group", "focused-element")
    return {
      has: true,
      id,
      label: getAccessibleName(active) || active.getAttribute("aria-label") || active.tagName.toLowerCase(),
      text: readElementText(active).slice(0, 200),
      extras: {
        role: getEffectiveRole(active),
        focused: true
      }
    }
  }

  const app = document.querySelector('[role="application"]')
  const label = app?.getAttribute("aria-label") || undefined
  return { has: !!label, label }
}

export function cursorToAdaptiveScene(x: number, y: number): { success: boolean; error?: string } {
  try {
    clickAtViewport(x, y)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export function describeAdaptiveProfile(name = "generic", notes?: string[]): SceneProfileDescription {
  const objects = discoverAdaptiveSceneObjects({ profileName: name })
  const strategies = Array.from(new Set(
    objects
      .map((o) => String(o.extras?.strategy || "unknown"))
      .concat(findFocusedWritableSurface() ? ["focused-writable"] : [])
  ))
  const writable = findFocusedWritableSurface()
  const capabilities = ["list", "resolve", "selected", "hitTest", "cursorTo", "trustedInput"]
  if (objects.length > 0) capabilities.push("geometry")
  if (writable) capabilities.push("text", "writeAtCursor")
  return {
    name,
    capabilities,
    strategies: strategies.length > 0 ? strategies : ["fallback"],
    geometryAddressable: objects.length > 0,
    focusAddressable: !!document.activeElement,
    textWritable: !!writable,
    modelProbe: false,
    trustedInput: true,
    notes
  }
}
