import { resolveRef } from "./ref-registry"
import { isVisible } from "./element-discovery"
import { selectorMap } from "./element-discovery"

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

export function dispatchKeySequence(target: Element, combo: string) {
  const parts = combo.split("+")
  const key = parts[parts.length - 1]
  const modifiers = {
    ctrlKey: parts.includes("Control"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    metaKey: parts.includes("Meta")
  }

  const code = getKeyCode(key)
  const keyOpts = { key, code, bubbles: true, cancelable: true, ...modifiers }

  target.dispatchEvent(new KeyboardEvent("keydown", keyOpts))
  target.dispatchEvent(new KeyboardEvent("keypress", keyOpts))
  target.dispatchEvent(new KeyboardEvent("keyup", keyOpts))
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
    const existing = document.querySelector(selector)
    if (existing) { resolve(existing); return }

    const timer = setTimeout(() => {
      observer.disconnect()
      resolve(null)
    }, timeout)

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) {
        clearTimeout(timer)
        observer.disconnect()
        resolve(el)
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
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
