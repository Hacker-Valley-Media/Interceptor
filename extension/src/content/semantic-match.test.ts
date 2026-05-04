/// <reference lib="dom" />

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered by another test file */ }

beforeAll(() => {
  ;(globalThis as any).chrome = {
    runtime: { onMessage: { addListener() {} } },
  }
})

// happy-dom does not compute layout, so isVisible() returns false for everything.
// Stub it with a connected-and-not-explicitly-hidden check so the test focuses
// on matcher logic rather than layout simulation.
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

async function freshSetup() {
  const reg = await import("./ref-registry")
  for (const id of Array.from(reg.refRegistry.keys())) reg.refRegistry.delete(id)
  for (const id of Array.from(reg.refMetadata.keys())) reg.refMetadata.delete(id)
  const sm = await import("./semantic-match")
  return { reg, sm }
}

describe("findBestMatch", () => {
  test("matches a div by textContent when the query uses the text: pseudo-role", async () => {
    // The matcher's role filter would otherwise skip every element whose
    // effective role is not 'text', and getEffectiveRole never returns 'text'.
    // The text: pseudo-role bypasses the role filter and scores against
    // textContent so plain elements (e.g. clickable framework cards) match.
    const { reg, sm } = await freshSetup()
    const card = document.createElement("div")
    card.textContent = "Target"
    card.tabIndex = 0
    document.body.appendChild(card)
    reg.getOrAssignRef(card)

    const match = sm.findBestMatch("Target", "text")
    expect(match).not.toBeNull()
    expect(match?.element).toBe(card)
  })

  test("still honors the role filter for non-text roles", async () => {
    const { reg, sm } = await freshSetup()
    const btn = document.createElement("button")
    btn.textContent = "Submit"
    document.body.appendChild(btn)
    reg.getOrAssignRef(btn)
    const link = document.createElement("a")
    link.setAttribute("href", "#")
    link.textContent = "Submit"
    document.body.appendChild(link)
    reg.getOrAssignRef(link)

    const buttonMatch = sm.findBestMatch("Submit", "button")
    expect(buttonMatch?.element.tagName).toBe("BUTTON")
    const linkMatch = sm.findBestMatch("Submit", "link")
    expect(linkMatch?.element.tagName).toBe("A")
  })
})
