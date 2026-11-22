// The quiet clock starts at the page's last change, not at the first poll.
import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

const { handleDomQuiet, resetDomQuietForTest } = await import("../extension/src/content/actions/wait")
const { getLastMutation } = await import("../extension/src/content/dom-observer")

const quietMs = (r: { data?: unknown }) => (r.data as { quietMs: number }).quietMs
// Fake times sit after the real clock: another test file may have loaded the
// page-lifetime observer, whose last-mutation stamp is a real performance.now().
const T = Math.ceil(performance.now()) + 1_000_000 // whole ms keep the subtraction exact

beforeEach(() => resetDomQuietForTest())

describe("dom_quiet clock", () => {
  test("a page quiet for 5 s answers about 5 s on the first poll", () => {
    const r = handleDomQuiet({ type: "dom_quiet" }, T + 10_000, T + 5_000)
    expect(r.success).toBe(true)
    expect(quietMs(r)).toBe(5_000)
  })

  test("a page that just changed answers about 0", () => {
    expect(quietMs(handleDomQuiet({ type: "dom_quiet" }, T + 10_000, T + 9_990))).toBe(10)
  })

  test("stop keeps the clock: the next wait does not restart from zero", () => {
    handleDomQuiet({ type: "dom_quiet" }, T + 10_000, T + 5_000)
    handleDomQuiet({ type: "dom_quiet", stop: true })
    expect(quietMs(handleDomQuiet({ type: "dom_quiet" }, T + 12_000, T + 5_000))).toBe(7_000)
  })

  test("a mutation seen by the quiet observer resets the clock", async () => {
    // The page-lifetime stamp is pinned at 0 on both calls, so only the quiet
    // observer can bring the answer under 200 ms.
    handleDomQuiet({ type: "dom_quiet" }, performance.now(), 0)
    document.body.appendChild(document.createElement("p"))
    await new Promise(r => setTimeout(r, 0))
    expect(quietMs(handleDomQuiet({ type: "dom_quiet" }, performance.now(), 0))).toBeLessThan(200)
  })

  test("the page-lifetime clock counts attribute and text changes, not only added nodes", async () => {
    const p = document.body.appendChild(document.createElement("p"))
    p.textContent = "a"
    await new Promise(r => setTimeout(r, 0))
    const before = performance.now()
    p.setAttribute("data-state", "busy")
    await new Promise(r => setTimeout(r, 0))
    expect(getLastMutation()).toBeGreaterThanOrEqual(before)
    const later = performance.now()
    ;(p.firstChild as Text).data = "b"
    await new Promise(r => setTimeout(r, 0))
    expect(getLastMutation()).toBeGreaterThanOrEqual(later)
  })
})

test("a page that swaps in a new body moves the page clock", () => {
  const before = performance.now()
  document.documentElement.replaceChild(document.createElement("body"), document.body)
  expect(getLastMutation()).toBeGreaterThanOrEqual(before)
})
