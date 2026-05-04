/// <reference lib="dom" />

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered by another test file */ }

beforeAll(() => {
  ;(globalThis as any).chrome = {
    runtime: { onMessage: { addListener() {} } },
  }
})

// happy-dom does not compute layout, so isVisible() is environment-driven.
// We stub it to a connected-and-not-explicitly-hidden check so the test
// focuses on registry behavior rather than layout simulation.
mock.module("./element-discovery", () => ({
  isVisible: (el: Element) => {
    if (!el.isConnected) return false
    let cur: Element | null = el
    while (cur) {
      const style = (cur as HTMLElement).style
      if (style?.display === "none" || style?.visibility === "hidden") return false
      cur = cur.parentElement
    }
    return true
  },
  isInteractive: () => true,
  INTERACTIVE_TAGS: new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"]),
  INTERACTIVE_ROLES: new Set(["button", "link"]),
  getShadowRoot: () => null,
  walkWithShadow: () => {},
  selectorMap: new Map(),
  nextIndex: 0,
  getInteractiveElements: () => [],
}))

afterEach(() => {
  document.body.innerHTML = ""
})

async function freshRegistry() {
  const mod = await import("./ref-registry")
  for (const id of Array.from(mod.refRegistry.keys())) mod.refRegistry.delete(id)
  for (const id of Array.from(mod.refMetadata.keys())) mod.refMetadata.delete(id)
  return mod
}

describe("resolveRef", () => {
  test("resolves a ref whose element is connected", async () => {
    const reg = await freshRegistry()
    const div = document.createElement("button")
    div.textContent = "Connected"
    document.body.appendChild(div)
    const refId = reg.getOrAssignRef(div)
    expect(reg.resolveRef(refId)).toBe(div)
  })

  test("still resolves the ref when an ancestor toggles display:none", async () => {
    const reg = await freshRegistry()
    const wrap = document.createElement("div")
    const target = document.createElement("button")
    target.textContent = "Target"
    wrap.appendChild(target)
    document.body.appendChild(wrap)
    const refId = reg.getOrAssignRef(target)
    wrap.style.display = "none"
    expect(reg.resolveRef(refId)).toBe(target)
  })

  test("returns null when the element is genuinely disconnected", async () => {
    const reg = await freshRegistry()
    const div = document.createElement("button")
    div.textContent = "Will be removed"
    document.body.appendChild(div)
    const refId = reg.getOrAssignRef(div)
    div.remove()
    expect(reg.resolveRef(refId)).toBeNull()
  })

  test("re-uses the same refId after the WeakRef entry was pruned", async () => {
    // GC may clear a WeakRef while the element is still alive. The next
    // pruneStaleRefs deletes the empty refRegistry entry. getOrAssignRef
    // must re-link to the same refId via elementToRef rather than allocate
    // a new one — otherwise refs the consumer has already received drift
    // silently as the GC churns.
    const reg = await freshRegistry()
    const btn = document.createElement("button")
    btn.textContent = "Persistent"
    document.body.appendChild(btn)
    const first = reg.getOrAssignRef(btn)
    reg.refRegistry.delete(first)
    const second = reg.getOrAssignRef(btn)
    expect(second).toBe(first)
    expect(reg.resolveRef(first)).toBe(btn)
  })
})
