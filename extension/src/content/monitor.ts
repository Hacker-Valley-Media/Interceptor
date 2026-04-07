import { getOrAssignRef } from "./ref-registry"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"

type MonEvent = {
  t: number
  s: number
  k: string
  sid: string
  [key: string]: unknown
}

type UserActionRef = { s: number; t: number }
type MutationBatch = {
  add: number
  rem: number
  attr: number
  txt: number
  targets: Set<string>
}

let armed = false
let sessionId = ""
let seq = 0
const recentUserActions: UserActionRef[] = []
const RECENT_CAP = 16
const CAUSE_WINDOW_MS = 500

let mutationBatch: MutationBatch | null = null
let mutationFlushTimer: ReturnType<typeof setTimeout> | null = null
const MUTATION_DEBOUNCE_MS = 50
const MUTATION_TARGET_CAP = 5

let scrollLastEmit = 0
let scrollAccX = 0
let scrollAccY = 0
let scrollFlushTimer: ReturnType<typeof setTimeout> | null = null
const SCROLL_THROTTLE_MS = 100

let mutationObserver: MutationObserver | null = null

type CapturedListener = { type: string; fn: EventListener; opts: AddEventListenerOptions }
const attachedListeners: CapturedListener[] = []

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

function emit(evt: Partial<MonEvent>): void {
  if (!armed) return
  try {
    const full: MonEvent = {
      t: Date.now(),
      s: seq++,
      k: evt.k || "unknown",
      sid: sessionId,
      ...evt,
    } as MonEvent
    chrome.runtime.sendMessage({ type: "mon_evt", obj: full }).catch(() => {})
  } catch {}
}

function pushUserAction(s: number, t: number): void {
  recentUserActions.push({ s, t })
  if (recentUserActions.length > RECENT_CAP) recentUserActions.shift()
}

function findCause(eventT: number): number | undefined {
  for (let i = recentUserActions.length - 1; i >= 0; i--) {
    const ua = recentUserActions[i]
    if (eventT - ua.t <= CAUSE_WINDOW_MS) return ua.s
    if (eventT - ua.t > CAUSE_WINDOW_MS) return undefined
  }
  return undefined
}

function describeTarget(target: EventTarget | null): Record<string, unknown> {
  if (!target || !(target instanceof Element)) return {}
  const el = target
  const out: Record<string, unknown> = {}
  out.ref = safe(() => getOrAssignRef(el), "")
  const role = safe(() => getEffectiveRole(el), "")
  if (role) out.r = role
  const name = safe(() => getAccessibleName(el), "")
  if (name) out.n = name.slice(0, 80)
  const tag = safe(() => el.tagName.toLowerCase(), "")
  if (tag && !role) out.tg = tag
  return out
}

function isPasswordLike(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false
  const type = (el.type || "").toLowerCase()
  if (type === "password") return true
  const autocomplete = (el.autocomplete || "").toLowerCase()
  if (autocomplete.startsWith("cc-")) return true
  const name = (el.name || "").toLowerCase()
  if (/card|cvv|cvc|credit/.test(name)) return true
  return false
}

function maskedValue(el: HTMLInputElement): string {
  const len = (el.value || "").length
  return `***${len}***`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "…"
}

function targetFromEvent(e: Event): EventTarget | null {
  try {
    const path = (e.composedPath && e.composedPath()) || []
    if (path.length > 0) return path[0]
  } catch {}
  return e.target
}

// -----------------------------------------------------------------------------
// User action listeners
// -----------------------------------------------------------------------------

function makeClickHandler(kind: "click" | "dblclick" | "rclick") {
  return (e: Event) => {
    try {
      const me = e as MouseEvent
      const target = targetFromEvent(e)
      const info = describeTarget(target)
      const t = Date.now()
      const sSnapshot = seq
      emit({
        k: kind,
        ...info,
        x: me.clientX,
        y: me.clientY,
        tr: me.isTrusted,
        ic: (e as Event & { composed?: boolean }).composed === true,
      })
      pushUserAction(sSnapshot, t)
    } catch {}
  }
}

function handleInput(e: Event) {
  try {
    const target = targetFromEvent(e)
    if (!(target instanceof Element)) return
    const info = describeTarget(target)
    let v = ""
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (target instanceof HTMLInputElement && isPasswordLike(target)) {
        v = maskedValue(target)
      } else {
        v = truncate(target.value || "", 120)
      }
    } else if ((target as HTMLElement).isContentEditable) {
      v = truncate(((target as HTMLElement).textContent || ""), 120)
    }
    const t = Date.now()
    const sSnapshot = seq
    emit({
      k: "input",
      ...info,
      v,
      tr: (e as Event).isTrusted,
    })
    pushUserAction(sSnapshot, t)
  } catch {}
}

function handleChange(e: Event) {
  try {
    const target = targetFromEvent(e)
    if (!(target instanceof Element)) return
    const info = describeTarget(target)
    let v = ""
    if (target instanceof HTMLInputElement) {
      if (isPasswordLike(target)) {
        v = maskedValue(target)
      } else if (target.type === "checkbox" || target.type === "radio") {
        v = target.checked ? "true" : "false"
      } else {
        v = truncate(target.value || "", 120)
      }
    } else if (target instanceof HTMLSelectElement) {
      v = truncate(target.value || "", 120)
    } else if (target instanceof HTMLTextAreaElement) {
      v = truncate(target.value || "", 120)
    }
    const t = Date.now()
    const sSnapshot = seq
    emit({
      k: "change",
      ...info,
      v,
      tr: (e as Event).isTrusted,
    })
    pushUserAction(sSnapshot, t)
  } catch {}
}

function handleSubmit(e: Event) {
  try {
    const target = targetFromEvent(e)
    const info = describeTarget(target)
    const t = Date.now()
    const sSnapshot = seq
    emit({
      k: "submit",
      ...info,
      tr: (e as Event).isTrusted,
    })
    pushUserAction(sSnapshot, t)
  } catch {}
}

function handleKeydown(e: Event) {
  try {
    const ke = e as KeyboardEvent
    const parts: string[] = []
    if (ke.ctrlKey) parts.push("Control")
    if (ke.shiftKey) parts.push("Shift")
    if (ke.altKey) parts.push("Alt")
    if (ke.metaKey) parts.push("Meta")
    parts.push(ke.key)
    const target = targetFromEvent(e)
    const info = describeTarget(target)
    const t = Date.now()
    const sSnapshot = seq
    emit({
      k: "key",
      ...info,
      kc: parts.join("+"),
      tr: ke.isTrusted,
    })
    // Only keys like Enter/Tab/Escape/Arrow are interesting as causes; char keys will be followed by input events
    if (ke.key === "Enter" || ke.key === "Tab" || ke.key === "Escape" || ke.key.startsWith("Arrow")) {
      pushUserAction(sSnapshot, t)
    }
  } catch {}
}

function handleFocusEvent(kind: "focus" | "blur") {
  return (e: Event) => {
    try {
      const target = targetFromEvent(e)
      const info = describeTarget(target)
      emit({
        k: kind,
        ...info,
        tr: (e as Event).isTrusted,
      })
    } catch {}
  }
}

function handleCopyPaste(kind: "copy" | "paste") {
  return (e: Event) => {
    try {
      const target = targetFromEvent(e)
      const info = describeTarget(target)
      emit({
        k: kind,
        ...info,
        tr: (e as Event).isTrusted,
      })
    } catch {}
  }
}

function flushScroll() {
  if (!armed) return
  if (scrollAccX === 0 && scrollAccY === 0) return
  emit({
    k: "scroll",
    sx: scrollAccX,
    sy: scrollAccY,
  })
  scrollAccX = 0
  scrollAccY = 0
  scrollLastEmit = Date.now()
}

function handleScroll(_e: Event) {
  try {
    const now = Date.now()
    scrollAccX = window.scrollX
    scrollAccY = window.scrollY
    if (now - scrollLastEmit >= SCROLL_THROTTLE_MS) {
      flushScroll()
    } else if (!scrollFlushTimer) {
      scrollFlushTimer = setTimeout(() => {
        scrollFlushTimer = null
        flushScroll()
      }, SCROLL_THROTTLE_MS)
    }
  } catch {}
}

// -----------------------------------------------------------------------------
// Mutation batching
// -----------------------------------------------------------------------------

function ensureMutationBatch(): MutationBatch {
  if (!mutationBatch) {
    mutationBatch = { add: 0, rem: 0, attr: 0, txt: 0, targets: new Set() }
  }
  return mutationBatch
}

function flushMutationBatch() {
  if (!armed) return
  if (!mutationBatch) return
  const batch = mutationBatch
  mutationBatch = null
  if (mutationFlushTimer) {
    clearTimeout(mutationFlushTimer)
    mutationFlushTimer = null
  }
  const total = batch.add + batch.rem + batch.attr + batch.txt
  if (total === 0) return
  const now = Date.now()
  const cause = findCause(now)
  emit({
    k: "mut",
    c: total,
    add: batch.add,
    rem: batch.rem,
    attr: batch.attr,
    txt: batch.txt,
    tgts: Array.from(batch.targets).slice(0, MUTATION_TARGET_CAP),
    ...(cause !== undefined ? { cause } : {}),
  })
}

function scheduleMutationFlush() {
  if (mutationFlushTimer) return
  mutationFlushTimer = setTimeout(() => {
    mutationFlushTimer = null
    flushMutationBatch()
  }, MUTATION_DEBOUNCE_MS)
}

function onMutations(mutations: MutationRecord[]) {
  if (!armed) return
  try {
    const batch = ensureMutationBatch()
    for (const m of mutations) {
      if (m.type === "childList") {
        batch.add += m.addedNodes.length
        batch.rem += m.removedNodes.length
      } else if (m.type === "attributes") {
        batch.attr += 1
      } else if (m.type === "characterData") {
        batch.txt += 1
      }
      if (batch.targets.size < MUTATION_TARGET_CAP) {
        const t = m.target
        if (t instanceof Element) {
          const ref = safe(() => getOrAssignRef(t), "")
          if (ref) batch.targets.add(ref)
        }
      }
    }
    scheduleMutationFlush()
  } catch {}
}

// -----------------------------------------------------------------------------
// __slop_net subscription (network correlation)
// -----------------------------------------------------------------------------

function onSlopNet(e: Event) {
  if (!armed) return
  try {
    const detail = (e as CustomEvent).detail as {
      url: string
      method: string
      status: number
      body: string
      type: string
      timestamp: number
    }
    if (!detail) return
    const bodyLen = typeof detail.body === "string" ? detail.body.length : 0
    const now = Date.now()
    const cause = findCause(now)
    emit({
      k: detail.type === "xhr" ? "xhr" : "fetch",
      u: truncate(detail.url || "", 512),
      m: detail.method || "GET",
      st: detail.status,
      bz: bodyLen,
      ...(cause !== undefined ? { cause } : {}),
    })
  } catch {}
}

// -----------------------------------------------------------------------------
// arm / disarm
// -----------------------------------------------------------------------------

function attach(type: string, fn: EventListener, opts: AddEventListenerOptions) {
  document.addEventListener(type, fn, opts)
  attachedListeners.push({ type, fn, opts })
}

export function arm(newSessionId: string, _startedAt: number): void {
  if (armed) return
  armed = true
  sessionId = newSessionId
  seq = 0
  recentUserActions.length = 0
  mutationBatch = null
  if (mutationFlushTimer) { clearTimeout(mutationFlushTimer); mutationFlushTimer = null }
  scrollAccX = 0
  scrollAccY = 0
  scrollLastEmit = 0

  const captureOpts: AddEventListenerOptions = { capture: true, passive: true }

  attach("click", makeClickHandler("click"), captureOpts)
  attach("dblclick", makeClickHandler("dblclick"), captureOpts)
  attach("contextmenu", makeClickHandler("rclick"), captureOpts)
  attach("input", handleInput, captureOpts)
  attach("change", handleChange, captureOpts)
  attach("submit", handleSubmit, captureOpts)
  attach("keydown", handleKeydown, captureOpts)
  attach("focus", handleFocusEvent("focus"), captureOpts)
  attach("blur", handleFocusEvent("blur"), captureOpts)
  attach("copy", handleCopyPaste("copy"), captureOpts)
  attach("paste", handleCopyPaste("paste"), captureOpts)
  // Scroll fires on document, capture phase
  attach("scroll", handleScroll, captureOpts)

  // __slop_net events from the MAIN-world inject script
  document.addEventListener("__slop_net", onSlopNet as EventListener)

  // MutationObserver on documentElement so <html> attribute changes are seen
  mutationObserver = new MutationObserver(onMutations)
  if (document.documentElement) {
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
  }
}

export function disarm(): { evt: number; mut: number; net: number } {
  if (!armed) return { evt: 0, mut: 0, net: 0 }
  flushMutationBatch()
  flushScroll()

  for (const l of attachedListeners) {
    try { document.removeEventListener(l.type, l.fn, l.opts) } catch {}
  }
  attachedListeners.length = 0

  try { document.removeEventListener("__slop_net", onSlopNet as EventListener) } catch {}

  if (mutationObserver) {
    try { mutationObserver.disconnect() } catch {}
    mutationObserver = null
  }
  if (mutationFlushTimer) { clearTimeout(mutationFlushTimer); mutationFlushTimer = null }
  if (scrollFlushTimer) { clearTimeout(scrollFlushTimer); scrollFlushTimer = null }

  const counts = { evt: seq, mut: 0, net: 0 }
  armed = false
  sessionId = ""
  seq = 0
  recentUserActions.length = 0
  return counts
}

export function isArmed(): boolean { return armed }
export function getSessionId(): string { return sessionId }

// -----------------------------------------------------------------------------
// Message handlers
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return
  if (msg.type === "monitor_arm") {
    try {
      arm(msg.sessionId as string, (msg.startedAt as number) || Date.now())
      sendResponse({ success: true, armed: true })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "monitor_disarm") {
    try {
      const counts = disarm()
      sendResponse({ success: true, counts })
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
  if (msg.type === "monitor_ping") {
    sendResponse({ success: true, armed, sessionId })
    return true
  }
  // Do not return true for unhandled messages — let other listeners respond.
})
