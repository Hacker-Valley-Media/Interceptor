/// <reference lib="dom" />

import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered by another test file */ }

beforeAll(() => {
  ;(globalThis as any).chrome = {
    runtime: { onMessage: { addListener() {} } },
  }
})

afterEach(() => {
  document.body.innerHTML = ""
})

/**
 * Stand in for a never-foregrounded Chrome tab.
 *
 * Chrome does not run layout for a tab that has never been rendered, and
 * `innerText` is defined in terms of layout, so it returns "" for a body full
 * of text. `textContent` is unaffected. happy-dom has no layout either, but it
 * does populate `innerText`, so the condition has to be staged explicitly.
 */
function throttleRendering(el: HTMLElement): void {
  Object.defineProperty(el, "innerText", { get: () => "", configurable: true })
}

describe("safeText on a background tab", () => {
  test("falls back to textContent when the rendered read comes back blank", async () => {
    const { safeText } = await import("./sensitive")
    const bubble = document.createElement("div")
    bubble.textContent = "Thanks for reaching out — how can I help?"
    document.body.appendChild(bubble)
    throttleRendering(bubble)

    // The bug: `innerText ?? textContent` does not fall back on "", only on
    // null, so every read of a background tab reported an empty page and every
    // reply read as "no reply".
    expect(bubble.innerText).toBe("")
    expect(safeText(bubble, true)).toBe("Thanks for reaching out — how can I help?")
  })

  test("prefers innerText whenever layout actually produced one", async () => {
    const { safeText } = await import("./sensitive")
    const el = document.createElement("div")
    el.textContent = "visible"
    document.body.appendChild(el)
    Object.defineProperty(el, "innerText", { get: () => "rendered", configurable: true })

    // innerText honours display:none and collapses whitespace the way a reader
    // sees it; the fallback must not cost those anywhere they are available.
    expect(safeText(el, true)).toBe("rendered")
  })

  test("an element that is genuinely empty stays empty", async () => {
    const { safeText } = await import("./sensitive")
    const el = document.createElement("div")
    document.body.appendChild(el)
    throttleRendering(el)
    expect(safeText(el, true)).toBe("")
  })

  test("whitespace-only rendered text is treated as blank, not as content", async () => {
    const { safeText } = await import("./sensitive")
    const el = document.createElement("div")
    el.textContent = "real content"
    document.body.appendChild(el)
    Object.defineProperty(el, "innerText", { get: () => "   \n  ", configurable: true })
    expect(safeText(el, true)).toBe("real content")
  })
})

describe("safeText fallback skips what a renderer would not show", () => {
  test("stylesheet rules, script source, noscript and template content stay out", async () => {
    const { safeText } = await import("./sensitive")
    document.body.innerHTML = `<style>.x{color:red}</style><script>window.__init = "token-abc"</script><noscript>enable js</noscript><template><span>tpl</span></template><p>Visible paragraph</p>`
    throttleRendering(document.body)
    expect(safeText(document.body, true)).toBe("Visible paragraph")
  })

  test("elements hidden by computed display or visibility stay out", async () => {
    const { safeText } = await import("./sensitive")
    document.head.innerHTML = `<style>.h{visibility:hidden}</style>`
    document.body.innerHTML = `<nav style="display:none">Hidden menu</nav><p class="h">Hidden note</p><p>Shown</p>`
    throttleRendering(document.body)
    expect(safeText(document.body, true)).toBe("Shown")
    document.head.innerHTML = ""
  })

  test("whitespace across nodes collapses to single spaces", async () => {
    const { safeText } = await import("./sensitive")
    document.body.innerHTML = `<div>\n  <span>one</span>\n  <span>two</span>\n</div>\n<p>three</p>`
    throttleRendering(document.body)
    expect(safeText(document.body, true)).toBe("one two three")
  })

  test("a password field's text-backed value is still masked on the fallback path", async () => {
    const { safeText, SECURE_MASK, markSensitive } = await import("./sensitive")
    document.body.innerHTML = `<div id="cred">CANARY-secret</div><p>public</p>`
    markSensitive(document.getElementById("cred")!)
    throttleRendering(document.body)
    const out = safeText(document.body, true)
    expect(out).not.toContain("CANARY-secret")
    expect(out).toContain(SECURE_MASK)
    expect(out).toContain("public")
  })
})
