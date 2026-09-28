import { afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
try { GlobalRegistrator.register() } catch {}
import { markSensitive, isSensitive, safeValue, safeText, safeHtml, SECURE_MASK } from "./sensitive"
import { getRelevantAttrs } from "./element-tree"
import { getAccessibleName } from "./a11y-tree"
import { getOrAssignRef, refRegistry } from "./ref-registry"
import { cacheSnapshot, computeSnapshotDiff, lastSnapshot } from "./snapshot-diff"
import { handleForms } from "./data/forms"
import { handleAttrGet, handleQuery, handleQueryOne } from "./data/query"
import { handleExtractHtml, handleExtractMarkdown, handleExtractText } from "./data/extract"
import { handleInputText } from "./actions/type"
import { handleFocus } from "./actions/focus"

afterEach(() => { document.body.innerHTML = ""; refRegistry.clear() })
const canary = 'CANARY<&"-0123456789'.repeat(4)
function fixture() {
  document.body.innerHTML = '<form><label for="pw">Password</label><input id="pw" type="password"><input id="plain" value="ordinary"><textarea id="area"></textarea><div id="editor" contenteditable="true"></div></form>'
  const password = document.querySelector<HTMLInputElement>("#pw")!
  password.setAttribute("value", canary)
  // Happy DOM has no layout; give the existing visibility checks rendered boxes.
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    Object.defineProperty(el, "offsetParent", { get: () => document.body })
    el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON() {} })
  }
  return { password, ref: getOrAssignRef(password) }
}
function masked(value: unknown) {
  const output = JSON.stringify(value)
  expect(output).not.toContain("CANARY")
  expect(output).toContain(SECURE_MASK)
}

test("values, attributes, forms, and both diff snapshots mask before truncation", async () => {
  const { password, ref } = fixture()
  masked(getRelevantAttrs(password))
  masked(await handleForms({ type: "forms" }))
  masked(await handleAttrGet({ type: "attr_get", ref, name: "value" }))
  cacheSnapshot()
  masked(lastSnapshot)
  password.value = "CHANGED-CANARY"
  expect(JSON.stringify(computeSnapshotDiff())).not.toContain("CANARY")
  password.value = ""
  masked(computeSnapshotDiff())
  expect(safeValue(document.querySelector("#plain")!)).toBe("ordinary")
})

test("HTML, query-one, and attribute reads mask prefilled credentials without changing the page", async () => {
  const { password, ref } = fixture()
  masked(safeHtml(document.body))
  masked(await handleExtractHtml({ type: "extract_html", ref }))
  masked(await handleQueryOne({ type: "query_one", selector: "#pw" }))
  expect(password.value).toBe(canary)
  expect(password.getAttribute("value")).toBe(canary)
  expect(safeHtml(document.querySelector("#plain")!)).toContain('value="ordinary"')
  expect((await handleAttrGet({ type: "attr_get", ref, name: "type" })).data).toBe("password")
})

test("vault text, textarea, contenteditable and descendant text are masked", async () => {
  fixture()
  for (const id of ["plain", "area", "editor"]) {
    const el = document.getElementById(id)!
    markSensitive(el)
    if (id === "editor") el.innerHTML = `<span>${canary.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</span>`
    else { (el as HTMLInputElement).value = canary; if (id === "area") el.textContent = canary }
    masked(safeHtml(el))
    if (id !== "plain") { masked(safeText(el)); masked(getAccessibleName(el)) }
  }
  masked(await handleExtractText({ type: "extract_text" }))
  masked(await handleExtractMarkdown({ type: "extract_markdown" }))
  masked(await handleQuery({ type: "query", selector: "#editor span" }))
  expect(safeText(document.body)).toContain("Password")
  const editor = document.getElementById("editor")!
  for (const markup of ['<table><tr><td contenteditable="true"></td><td>ordinary-cell</td></tr></table>', '<ul><li contenteditable="true"></li></ul>']) {
    editor.insertAdjacentHTML("afterend", markup)
    for (const el of [editor.nextElementSibling!, ...Array.from(editor.nextElementSibling!.querySelectorAll("*"))]) {
      Object.defineProperty(el, "offsetParent", { get: () => document.body })
      el.getBoundingClientRect = editor.getBoundingClientRect
    }
    const field = editor.nextElementSibling!.querySelector("[contenteditable]")!
    field.textContent = canary
    markSensitive(field)
    masked(await handleExtractMarkdown({ type: "extract_markdown" }))
  }
  expect((await handleExtractMarkdown({ type: "extract_markdown" })).data).toContain("ordinary-cell")
})

test("typed and empty passwords remain sensitive after reveal-type changes", async () => {
  const { password, ref } = fixture()
  password.value = ""
  expect(safeValue(password)).toBe("")
  password.type = "text"
  await handleInputText({ type: "input_text", ref, text: canary, clear: true })
  expect(isSensitive(password)).toBe(true)
  expect(safeValue(password)).toBe(SECURE_MASK)
  const plain = document.querySelector<HTMLInputElement>("#plain")!
  await handleInputText({ type: "input_text", ref: getOrAssignRef(plain), text: canary, clear: true, sensitive: true })
  expect(safeValue(plain)).toBe(SECURE_MASK)
})

test("trusted credential focus marks its actual target and fails on a stale ref", async () => {
  fixture()
  const plain = document.querySelector<HTMLInputElement>("#plain")!
  const ref = getOrAssignRef(plain)
  expect((await handleFocus({ type: "focus", ref, sensitive: true })).success).toBe(true)
  plain.value = canary
  expect(safeValue(plain)).toBe(SECURE_MASK)
  plain.blur()
  plain.disabled = true
  expect((await handleFocus({ type: "focus", ref, sensitive: true })).success).toBe(false)
  plain.remove()
  expect((await handleFocus({ type: "focus", ref, sensitive: true })).success).toBe(false)
  expect((await handleFocus({ type: "focus", focused: true, sensitive: true })).success).toBe(false)
})

test("failed credential focus leaves an ordinary field unmarked", async () => {
  fixture()
  const plain = document.querySelector<HTMLInputElement>("#plain")!
  plain.disabled = true
  expect((await handleFocus({ type: "focus", ref: getOrAssignRef(plain), sensitive: true })).success).toBe(false)
  expect(isSensitive(plain)).toBe(false)
  expect(safeValue(plain)).toBe("ordinary")
})

test("focused credential delivery preserves the deepest shadow input and marks only it", async () => {
  // Other suites mock getShadowRoot as null; use real shadow behavior in isolation.
  const child = Bun.spawn([process.execPath, "-e", `
    import assert from "node:assert/strict";
    import { GlobalRegistrator } from "@happy-dom/global-registrator";
    GlobalRegistrator.register();
    const { handleFocus } = await import("./extension/src/content/actions/focus.ts");
    const { isSensitive, safeValue, SECURE_MASK } = await import("./extension/src/content/sensitive.ts");
    const host = document.createElement("div");
    host.tabIndex = 0;
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div tabindex="0"></div><input value="ordinary-sibling">';
    const nested = shadow.querySelector("div").attachShadow({ mode: "open" });
    nested.innerHTML = '<input value="credential-canary">';
    const input = nested.querySelector("input");
    input.focus();
    assert.equal(document.activeElement, host);
    assert.equal((await handleFocus({ type: "focus", focused: true, sensitive: true })).success, true);
    assert.equal(nested.activeElement, input);
    assert.equal(safeValue(input), SECURE_MASK);
    assert.equal(isSensitive(host), false);
    assert.equal(safeValue(shadow.querySelector("input")), "ordinary-sibling");
  `], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
})
