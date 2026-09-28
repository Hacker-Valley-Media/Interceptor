/// <reference lib="dom" />
// Shadow-piercing selector cases. Run by deep-query.test.ts in a child
// process (`bun run <this file>`), never by `bun test` directly.
//
// Why a child process: bun applies `mock.module` to the whole test process,
// and five suites mock `./element-discovery` (three of them with
// `getShadowRoot: () => null`). Inside the full `bun test` run those mocks
// reach `deep-query.ts` through its import, every shadow case fails, and the
// runner's diff of happy-dom nodes grows without bound (77 GB before the OS
// killed it; CI exit 137). Same isolation as the shadow case in
// sensitive.test.ts. Nodes are compared by identity with a message, never
// with a deep equal, so a failure prints one line instead of a node dump.

import assert from "node:assert/strict"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
;(globalThis as any).chrome = { runtime: { onMessage: { addListener() {} } } }

const { queryAllDeep, queryOneDeep } = await import("./deep-query")
const { handleCount, handleExists, handleTableData, handleAttrGet, handleAttrSet, handleStyleGet } = await import("./data/query")
const { handleClickSelector } = await import("./actions/click")
const { handleRect } = await import("./inspection/rect")
const { handleWaitFor } = await import("./actions/wait")
const { resolveTarget } = await import("./dom-screenshot")

function reset(): void {
  document.body.innerHTML = ""
  // getShadowRoot falls back to chrome.dom for a closed root; a case that
  // installs the stub must not leak it into the next one.
  delete (globalThis as any).chrome.dom
}

/** A host whose shadow root holds one button with the given label. */
function hostWithShadowButton(label: string, mode: ShadowRootMode = "open") {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = host.attachShadow({ mode })
  const button = document.createElement("button")
  button.setAttribute("aria-label", label)
  root.appendChild(button)
  return { host, root, button }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cases: Array<[string, () => void | Promise<void>]> = [
  ["queryAllDeep finds an element inside an open shadow root that querySelectorAll cannot see", () => {
    const { button } = hostWithShadowButton("Chat Launcher")
    assert.equal(document.querySelectorAll('button[aria-label="Chat Launcher"]').length, 0, "light DOM is blind")
    const found = queryAllDeep('button[aria-label="Chat Launcher"]')
    assert.equal(found.length, 1)
    assert.ok(found[0] === button, "the shadow button")
  }],

  ["queryAllDeep returns light-DOM matches first, in document order, so nth never re-binds to a shadow element", () => {
    const light = [0, 1, 2].map((i) => { const b = document.createElement("button"); b.id = `light${i}`; document.body.appendChild(b); return b })
    const { button: shadow } = hostWithShadowButton("shadow")
    const found = queryAllDeep("button")
    assert.equal(found.length, 4)
    light.forEach((b, i) => assert.ok(found[i] === b, `light button ${i} at index ${i}`))
    assert.ok(found[3] === shadow, "shadow button last")
  }],

  ["queryAllDeep descends through nested shadow roots", () => {
    const outer = document.createElement("div")
    document.body.appendChild(outer)
    const inner = document.createElement("div")
    outer.attachShadow({ mode: "open" }).appendChild(inner)
    const target = document.createElement("span")
    target.className = "deep"
    inner.attachShadow({ mode: "open" }).appendChild(target)
    const found = queryAllDeep("span.deep")
    assert.equal(found.length, 1)
    assert.ok(found[0] === target, "nested target")
  }],

  ["queryAllDeep pierces a closed root through chrome.dom.openOrClosedShadowRoot", () => {
    const { host, root, button } = hostWithShadowButton("closed", "closed")
    assert.equal(queryAllDeep("button").length, 0, "closed root is unreachable without the extension API")
    ;(globalThis as any).chrome.dom = { openOrClosedShadowRoot: (el: Element) => (el === host ? root : null) }
    const found = queryAllDeep("button")
    assert.equal(found.length, 1)
    assert.ok(found[0] === button, "closed-root button")
  }],

  ["queryAllDeep does not report the same element twice", () => {
    hostWithShadowButton("once")
    assert.equal(queryAllDeep("button").length, 1)
  }],

  ["queryAllDeep propagates an invalid selector before any traversal", () => {
    hostWithShadowButton("irrelevant")
    assert.throws(() => queryAllDeep("[["))
  }],

  ["queryAllDeep costs nothing extra on a page with no shadow hosts", () => {
    for (let i = 0; i < 3; i++) document.body.appendChild(document.createElement("button"))
    const plain = Array.from(document.querySelectorAll("button"))
    const deep = queryAllDeep("button")
    assert.equal(deep.length, plain.length)
    plain.forEach((el, i) => assert.ok(deep[i] === el, `same element at ${i}`))
  }],

  ["queryOneDeep prefers the light DOM and only then descends", () => {
    const light = document.createElement("button")
    document.body.appendChild(light)
    hostWithShadowButton("shadow")
    assert.ok(queryOneDeep("button") === light, "light button wins")
  }],

  ["queryOneDeep reaches a shadow element when the light DOM has none", () => {
    const { button } = hostWithShadowButton("Chat Launcher")
    assert.ok(queryOneDeep("button") === button, "shadow button")
  }],

  ["queryOneDeep returns null when nothing matches anywhere", () => {
    hostWithShadowButton("Chat Launcher")
    assert.equal(queryOneDeep("input"), null)
  }],

  ["count and exists agree with queryAllDeep across a shadow boundary", async () => {
    hostWithShadowButton("Chat Launcher")
    assert.equal((await handleCount({ type: "count", selector: "button" })).data, 1)
    assert.equal((await handleExists({ type: "exists", selector: "button" })).data, true)
  }],

  ["click --selector reaches a launcher inside a shadow root", async () => {
    const { button } = hostWithShadowButton("Chat Launcher")
    let clicked = false
    button.addEventListener("click", () => { clicked = true })
    const res = await handleClickSelector({ type: "click_selector", selector: "button", nth: 0 })
    assert.equal(res.success, true, res.error)
    assert.equal(clicked, true, "listener ran")
  }],

  ["click --selector --nth keeps light-DOM numbering on a page with shadow hosts", async () => {
    const light = [0, 1].map(() => { const b = document.createElement("button"); document.body.appendChild(b); return b })
    hostWithShadowButton("shadow")
    let hit = -1
    light.forEach((b, i) => b.addEventListener("click", () => { hit = i }))
    const res = await handleClickSelector({ type: "click_selector", selector: "button", nth: 1 })
    assert.equal(res.success, true, res.error)
    assert.equal(hit, 1, "second light button")
  }],

  ["table by selector reads rows from a table inside a shadow root", async () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    host.attachShadow({ mode: "open" }).innerHTML = '<table id="t"><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'
    const res = await handleTableData({ type: "table_data", selector: "#t" })
    assert.equal(res.success, true, res.error)
    assert.deepEqual(res.data, [["a", "b"], ["1", "2"]])
  }],

  ["attr get and set by selector reach an element inside a shadow root", async () => {
    const { button } = hostWithShadowButton("Chat Launcher")
    const got = await handleAttrGet({ type: "attr_get", selector: "button", name: "aria-label" })
    assert.equal(got.data, "Chat Launcher")
    const set = await handleAttrSet({ type: "attr_set", selector: "button", name: "data-x", value: "1" })
    assert.equal(set.success, true, set.error)
    assert.equal(button.getAttribute("data-x"), "1")
  }],

  ["style by selector reads computed style of an element inside a shadow root", async () => {
    const { button } = hostWithShadowButton("Chat Launcher")
    button.style.display = "none"
    const res = await handleStyleGet({ type: "style_get", selector: "button", property: "display" })
    assert.equal(res.success, true, res.error)
    assert.equal(res.data, "none")
  }],

  ["rect by selector resolves an element inside a shadow root", async () => {
    hostWithShadowButton("Chat Launcher")
    const res = await handleRect({ type: "rect", selector: "button" })
    assert.equal(res.success, true, res.error)
    assert.ok(res.data && typeof (res.data as { width: unknown }).width === "number", "a rect")
  }],

  ["screenshot --selector resolves an element inside a shadow root", () => {
    const { button } = hostWithShadowButton("Chat Launcher")
    const res = resolveTarget({ type: "dom_screenshot", mode: "selector", selector: "button" })
    assert.equal(res.error, undefined)
    assert.ok(res.node === button, "shadow button")
  }],

  ["wait finds a light-DOM element that appears later", async () => {
    const pending = handleWaitFor({ type: "wait_for", selector: "#late", timeout: 2000 })
    await sleep(50)
    const late = document.createElement("div")
    late.id = "late"
    document.body.appendChild(late)
    const res = await pending
    assert.equal(res.success, true, res.error)
  }],

  ["wait finds an element that appears later inside an existing shadow root (poll, since the observer cannot see it)", async () => {
    const { root } = hostWithShadowButton("existing")
    const pending = handleWaitFor({ type: "wait_for", selector: "input.late", timeout: 3000 })
    await sleep(300)
    const late = document.createElement("input")
    late.className = "late"
    root.appendChild(late)
    const res = await pending
    assert.equal(res.success, true, res.error)
  }],

  ["wait times out honestly when nothing matches", async () => {
    hostWithShadowButton("existing")
    const res = await handleWaitFor({ type: "wait_for", selector: "input.never", timeout: 400 })
    assert.equal(res.success, false)
    assert.match(String(res.error), /timeout waiting for/)
  }],
]

let failed = 0
for (const [name, run] of cases) {
  reset()
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}\n     ${(e as Error).message}`)
  }
}
console.log(`${cases.length - failed} of ${cases.length} passed`)
process.exit(failed ? 1 : 0)
