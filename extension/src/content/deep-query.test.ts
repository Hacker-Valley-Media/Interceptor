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
  // getShadowRoot falls back to chrome.dom when a root is closed; individual
  // tests install it and must not leak that into the next one.
  delete (globalThis as any).chrome.dom
})

/** A host whose open shadow root holds one button with the given label. */
function hostWithShadowButton(label: string, mode: ShadowRootMode = "open"): { host: HTMLElement; button: HTMLButtonElement } {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = host.attachShadow({ mode })
  const button = document.createElement("button")
  button.setAttribute("aria-label", label)
  root.appendChild(button)
  return { host, button }
}

describe("queryAllDeep", () => {
  test("finds an element inside an open shadow root that querySelectorAll cannot see", async () => {
    const { queryAllDeep } = await import("./deep-query")
    const { button } = hostWithShadowButton("Chat Launcher")

    // The regression this whole module exists for: the light-DOM query is blind.
    expect(document.querySelectorAll('button[aria-label="Chat Launcher"]').length).toBe(0)
    expect(queryAllDeep('button[aria-label="Chat Launcher"]')).toEqual([button])
  })

  test("returns light-DOM matches first, so nth never re-binds to a shadow element", async () => {
    const { queryAllDeep } = await import("./deep-query")
    const light = document.createElement("button")
    light.id = "light"
    document.body.appendChild(light)
    const { button: shadow } = hostWithShadowButton("shadow")

    const found = queryAllDeep("button")
    expect(found.length).toBe(2)
    expect(found[0]).toBe(light)
    expect(found[1]).toBe(shadow)
  })

  test("descends through nested shadow roots", async () => {
    const { queryAllDeep } = await import("./deep-query")
    const outer = document.createElement("div")
    document.body.appendChild(outer)
    const outerRoot = outer.attachShadow({ mode: "open" })
    const inner = document.createElement("div")
    outerRoot.appendChild(inner)
    const innerRoot = inner.attachShadow({ mode: "open" })
    const target = document.createElement("span")
    target.className = "deep"
    innerRoot.appendChild(target)

    expect(queryAllDeep("span.deep")).toEqual([target])
  })

  test("pierces a closed root through chrome.dom.openOrClosedShadowRoot", async () => {
    const { queryAllDeep } = await import("./deep-query")
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = host.attachShadow({ mode: "closed" })
    const button = document.createElement("button")
    root.appendChild(button)

    // A closed root is not reachable via `.shadowRoot`; the extension API is
    // the only way in, and is exactly what a vendor who closed the root did
    // not anticipate. Without the stub there is nothing to find.
    expect(queryAllDeep("button")).toEqual([])
    ;(globalThis as any).chrome.dom = { openOrClosedShadowRoot: (el: Element) => (el === host ? root : null) }
    expect(queryAllDeep("button")).toEqual([button])
  })

  test("does not report the same element twice", async () => {
    const { queryAllDeep } = await import("./deep-query")
    const { button } = hostWithShadowButton("once")
    // Two selectors' worth of overlap is impossible in one call, but a host
    // that is itself reachable from two collected roots would be; assert the
    // dedupe set is doing its job on the simple shape at least.
    expect(queryAllDeep("button")).toEqual([button])
  })

  test("propagates an invalid selector from the first root, before any traversal", async () => {
    const { queryAllDeep } = await import("./deep-query")
    hostWithShadowButton("irrelevant")
    expect(() => queryAllDeep("[[")).toThrow()
  })

  test("costs nothing extra on a page with no shadow hosts", async () => {
    const { queryAllDeep } = await import("./deep-query")
    for (let i = 0; i < 3; i++) document.body.appendChild(document.createElement("button"))
    expect(queryAllDeep("button")).toEqual(Array.from(document.querySelectorAll("button")))
  })
})

describe("queryOneDeep", () => {
  test("prefers the light DOM and only then descends", async () => {
    const { queryOneDeep } = await import("./deep-query")
    const light = document.createElement("button")
    document.body.appendChild(light)
    hostWithShadowButton("shadow")
    expect(queryOneDeep("button")).toBe(light)
  })

  test("reaches a shadow element when the light DOM has none", async () => {
    const { queryOneDeep } = await import("./deep-query")
    const { button } = hostWithShadowButton("Chat Launcher")
    expect(queryOneDeep("button")).toBe(button)
  })

  test("returns null when nothing matches anywhere", async () => {
    const { queryOneDeep } = await import("./deep-query")
    hostWithShadowButton("Chat Launcher")
    expect(queryOneDeep("input")).toBeNull()
  })
})

describe("selector verbs", () => {
  test("count and exists agree with queryAllDeep across a shadow boundary", async () => {
    const { handleCount, handleExists } = await import("./data/query")
    hostWithShadowButton("Chat Launcher")

    expect((await handleCount({ type: "count", selector: "button" })).data).toBe(1)
    expect((await handleExists({ type: "exists", selector: "button" })).data).toBe(true)
  })

  test("click --selector reaches a launcher inside a shadow root", async () => {
    const { handleClickSelector } = await import("./actions/click")
    const { button } = hostWithShadowButton("Chat Launcher")
    let clicked = false
    button.addEventListener("click", () => { clicked = true })

    const res = await handleClickSelector({ type: "click_selector", selector: "button", nth: 0 })
    expect(res.success).toBe(true)
    expect(clicked).toBe(true)
  })
})
