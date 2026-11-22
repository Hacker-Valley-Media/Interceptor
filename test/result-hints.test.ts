// Hints fire on their triggers and not otherwise.
import { expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

import { hiddenThinHint, THIN_TEXT_CHARS } from "../cli/commands/compound"
const { isSubmittableField } = await import("../extension/src/content/actions/type")

test("a hidden page that rendered controls gets no hint (bench S8: 109 characters and a button)", () => {
  expect(hiddenThinHint({ success: true, data: "Trusted Input Lab Only a trusted click Trusted success: false", hidden: true } as never, 42, "[e1] button \"Trusted Gate\"")).toBeUndefined()
  expect(hiddenThinHint({ success: true, data: "", hidden: true } as never, 42, "")).toContain("tab keepalive 42")
  expect(hiddenThinHint({ success: true, data: "x".repeat(100), hidden: true } as never, 42)).toBeUndefined()
})

test("hidden tab with almost no text suggests keepalive with the tab id", () => {
  expect(hiddenThinHint({ success: true, data: "Videos", hidden: true } as never, 42)).toContain("interceptor tab keepalive 42")
  expect(hiddenThinHint({ success: true, data: "x".repeat(THIN_TEXT_CHARS), hidden: true } as never, 42)).toBeUndefined()
  expect(hiddenThinHint({ success: true, data: "Videos" }, 42)).toBeUndefined()
  // An ordinary short page in a hidden tab is not a lazy page (bench spa-lab: 345 characters).
  expect(hiddenThinHint({ success: true, data: "x".repeat(345), hidden: true } as never, 42)).toBeUndefined()
  expect(hiddenThinHint(undefined, 42)).toBeUndefined()
})

test("a search box or a field in a form with a submit control is submittable", () => {
  document.body.innerHTML = `
    <input id="s" type="search">
    <form><input id="f" name="q"><button>Go</button></form>
    <form><input id="n" name="q"></form>
    <form role="search"><input id="r"></form>
    <form><textarea id="t"></textarea><button>Send</button></form>
    <input id="lone">`
  const el = (id: string) => document.getElementById(id) as HTMLInputElement
  expect(isSubmittableField(el("s"))).toBe(true)
  expect(isSubmittableField(el("f"))).toBe(true)
  expect(isSubmittableField(el("n"))).toBe(false)
  expect(isSubmittableField(el("r"))).toBe(true)
  expect(isSubmittableField(el("t") as unknown as HTMLInputElement)).toBe(false)
  expect(isSubmittableField(el("lone"))).toBe(false)
})
