import { resolveRef } from "./ref-registry"
import { isVisible } from "./element-discovery"
import { selectorMap } from "./element-discovery"
import { queryOneDeep } from "./deep-query"

export type StaleElementResult = { success: false; error: string; delivered: false }

// One wording for every handler. Name the ref the caller passed (the handlers
// used to print the internal `index`, so agents saw `stale element [undefined]`
// 339 times in the 2026-09-10 session review), say that nothing happened, and
// name the recovery. `delivered: false` lets the CLI drop its "delivery is
// unverified" caveat: the content script answered before touching the page.
export function staleElementError(action: { [key: string]: unknown }, verb: string): StaleElementResult {
  const label = String(action.ref ?? action.index ?? "unknown")
  return {
    success: false,
    error: `stale element [${label}] — it is no longer in the DOM, so nothing was ${verb}. Run 'interceptor read' for fresh refs.`,
    delivered: false,
  }
}

export function resolveElement(indexOrRef: number | undefined, ref?: string): Element | null {
  if (ref) {
    return resolveRef(ref)
  }
  if (indexOrRef === undefined) return null
  const selector = selectorMap.get(indexOrRef)
  if (!selector) return null
  const el = document.querySelector(selector)
  if (!el) return null
  if (!isVisible(el)) return null
  return el
}

/** Ref or index first; otherwise a shadow-piercing CSS selector. */
export function resolveElementOrSelector(action: { [key: string]: unknown }): Element | null {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (el) return el
  return action.selector ? queryOneDeep(String(action.selector)) : null
}

export function scrollIntoViewIfNeeded(el: Element) {
  const rect = el.getBoundingClientRect()
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    el.scrollIntoView({ block: "center", behavior: "instant" })
  }
}

export function dispatchClickSequence(el: Element, atX?: number, atY?: number) {
  const rect = el.getBoundingClientRect()
  const x = atX !== undefined ? rect.left + atX : rect.left + rect.width / 2
  const y = atY !== undefined ? rect.top + atY : rect.top + rect.height / 2

  // Prefer dispatching the gesture in the page's MAIN world. Synthetic pointer
  // events fired from this (ISOLATED) content-script world don't drive some
  // frameworks' pointerdown handlers — e.g. Radix / Floating UI menus open on
  // `pointerdown` but ignore isolated-world events, so `act` would click the
  // trigger yet the menu never opens (verified: identical events, main world
  // opens it, isolated world doesn't). inject-net.js (world: MAIN) listens for
  // `__interceptor_click` and re-fires the full sequence there, acking back
  // synchronously. Only when no ack returns (main-world bridge unavailable) do
  // we fall back to the legacy isolated dispatch — so nothing that works today
  // regresses.
  let acked = false
  const onAck = () => { acked = true }
  el.addEventListener("__interceptor_click_ack", onAck, true)
  try {
    el.dispatchEvent(new CustomEvent("__interceptor_click", { bubbles: true, detail: { x, y } }))
  } finally {
    el.removeEventListener("__interceptor_click_ack", onAck, true)
  }
  if (acked) return

  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
  el.dispatchEvent(new PointerEvent("pointerover", opts))
  el.dispatchEvent(new MouseEvent("mouseover", opts))
  el.dispatchEvent(new PointerEvent("pointerdown", opts))
  el.dispatchEvent(new MouseEvent("mousedown", opts))
  if ((el as HTMLElement).focus) (el as HTMLElement).focus()
  el.dispatchEvent(new PointerEvent("pointerup", opts))
  el.dispatchEvent(new MouseEvent("mouseup", opts))
  el.dispatchEvent(new MouseEvent("click", opts))
}

export function dispatchHoverSequence(el: Element) {
  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y }

  el.dispatchEvent(new PointerEvent("pointerover", opts))
  el.dispatchEvent(new MouseEvent("mouseover", opts))
  el.dispatchEvent(new PointerEvent("pointermove", opts))
  el.dispatchEvent(new MouseEvent("mousemove", opts))
}

const KEY_CODES: Record<string, string> = {
  Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace",
  Space: "Space", Delete: "Delete", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
}

function getKeyCode(key: string): string {
  if (KEY_CODES[key]) return KEY_CODES[key]
  if (key.length === 1 && key >= "0" && key <= "9") return `Digit${key}`
  if (key.length === 1 && /^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`
  return KEY_CODES[key] || `Key${key.toUpperCase()}`
}

// Legacy `keyCode` numbers, by `key` name. Deprecated, but a large amount of
// shipped widget code still branches on them — `if (e.keyCode === 13) send()`
// is the canonical chat composer, and several live ones (socialintents and
// Ada among them) test *only* keyCode. A KeyboardEvent constructed without one
// reports `keyCode: 0`, so pressing Enter in such a composer typed nothing and
// sent nothing, with no error anywhere: the key was delivered and the handler
// declined it.
const LEGACY_KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
  Escape: 27, Space: 32, " ": 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Delete: 46, Meta: 91,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
}

export function getLegacyKeyCode(key: string): number {
  const named = LEGACY_KEY_CODES[key]
  if (named !== undefined) return named
  if (key.length !== 1) return 0
  // US-layout approximation, the same one Puppeteer/Selenium ship: letters and
  // digits are exact, punctuation is layout-dependent and cannot be exact from
  // a `key` name alone. Handlers that branch on punctuation keyCodes are rare;
  // handlers that branch on Enter are everywhere.
  return key.toUpperCase().charCodeAt(0)
}

// Belt-and-braces for same-world listeners only.
//
// The init dictionary is what actually reaches the page — see `fire()` below.
// This own-property shadowing is kept for engines whose KeyboardEventInit does
// not carry the legacy members, where it is the only thing that fills them in.
// It CANNOT be the primary mechanism: a content script and the page share the
// DOM but not JS object identity, so when the event crosses into the page Blink
// builds a fresh wrapper from the C++ event and an own property defined here
// does not come with it. Same reason `click.ts` relays through
// `__interceptor_click` to re-fire in the MAIN world rather than tagging its
// events here.
function withLegacyCodes(event: KeyboardEvent, keyCode: number, charCode: number): KeyboardEvent {
  for (const [name, value] of [["keyCode", keyCode], ["which", keyCode], ["charCode", charCode]] as const) {
    try { Object.defineProperty(event, name, { get: () => value, configurable: true }) } catch { /* non-configurable in this engine; the init-dict value stands */ }
  }
  return event
}

// Real browsers fire `keypress` only for keys that produce a character, plus
// Enter — never for Tab, Escape, or the arrows. Firing it for everything is a
// fingerprintable artifact on exactly the sites that care, and can double-
// handle a key on widgets listening to both keydown and keypress.
function producesKeypress(key: string): boolean {
  return key === "Enter" || key === "Space" || key.length === 1
}

export function dispatchKeySequence(target: Element, combo: string) {
  const parts = combo.split("+")
  const modifiers = {
    ctrlKey: parts.includes("Control"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    metaKey: parts.includes("Meta")
  }
  const raw = parts[parts.length - 1]
  // Shift with one lowercase letter is that letter's uppercase form, as a
  // keyboard sends it: key "A", keypress charCode 65. Every other key is
  // passed as written (shifted punctuation and digits depend on the layout).
  const key = modifiers.shiftKey && /^[a-z]$/.test(raw) ? raw.toUpperCase() : raw

  const code = getKeyCode(key)
  const legacy = getLegacyKeyCode(key)
  const base = { key, code, bubbles: true, cancelable: true, ...modifiers }

  // The legacy members go in the INIT DICTIONARY, which is the only route that
  // reaches the page. `keyCode`/`charCode` are KeyboardEventInit members and
  // `which` is a UIEventInit member (the UI Events "legacy key and character"
  // extensions); Blink stores them on the C++ event, so they survive into the
  // wrapper a MAIN-world listener receives. Verified in Chrome 153:
  // `new KeyboardEvent("keydown", {keyCode: 13}).keyCode === 13`.
  const fire = (type: string, keyCode: number, charCode: number): boolean =>
    target.dispatchEvent(withLegacyCodes(
      // `which` mirrors charCode on keypress and keyCode elsewhere, as in Blink.
      new KeyboardEvent(type, { ...base, keyCode, charCode, which: charCode || keyCode }),
      keyCode, charCode,
    ))

  // A page that calls preventDefault() on keydown suppresses the keypress in a
  // real browser. Honour that rather than delivering a keypress the page just
  // refused.
  const notCancelled = fire("keydown", legacy, 0)
  if (notCancelled && producesKeypress(key)) {
    // charCode carries the character for keypress, and is 13 for Enter. Blink
    // reports keyCode === charCode on keypress, unlike keydown/keyup where
    // keyCode is the virtual key ('a' is 65 down, 97 on keypress).
    const charCode = key === "Enter" ? 13 : key === "Space" ? 32 : key.charCodeAt(0)
    fire("keypress", charCode, charCode)
  }
  fire("keyup", legacy, 0)
}

export function waitForMutation(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false
    const observer = new MutationObserver(() => {
      if (!resolved) {
        resolved = true
        observer.disconnect()
        resolve(true)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        observer.disconnect()
        resolve(false)
      }
    }, timeoutMs)
  })
}

export function waitForElement(selector: string, timeout: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = queryOneDeep(selector)
    if (existing) { resolve(existing); return }

    let done = false
    const finish = (el: Element | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      observer.disconnect()
      resolve(el)
    }
    const check = () => {
      const el = queryOneDeep(selector)
      if (el) finish(el)
    }

    const timer = setTimeout(() => finish(null), timeout)
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    // A light-DOM observer never reports mutations inside a shadow tree, so an
    // element rendered later inside an existing shadow root needs the poll.
    const poll = setInterval(check, 250)
  })
}

export function waitForDomStable(debounceMs = 200, timeoutMs = 5000): Promise<{ stable: boolean; elapsed: number; mutations: number }> {
  return new Promise((resolve) => {
    const start = Date.now()
    let mutationCount = 0
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const hardTimeout = setTimeout(() => {
      observer.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
      resolve({ stable: false, elapsed: Date.now() - start, mutations: mutationCount })
    }, timeoutMs)

    const observer = new MutationObserver(() => {
      mutationCount++
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        observer.disconnect()
        clearTimeout(hardTimeout)
        resolve({ stable: true, elapsed: Date.now() - start, mutations: mutationCount })
      }, debounceMs)
    })

    observer.observe(document.body, { childList: true, subtree: true, attributes: true })

    debounceTimer = setTimeout(() => {
      observer.disconnect()
      clearTimeout(hardTimeout)
      resolve({ stable: true, elapsed: Date.now() - start, mutations: mutationCount })
    }, debounceMs)
  })
}
