// The quiet clock starts at the page's last change, not at the first poll.
import { beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

const { handleDomQuiet, resetDomQuietForTest } = await import("../extension/src/content/actions/wait")

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

  test("a mutation seen by the observer resets the clock", async () => {
    handleDomQuiet({ type: "dom_quiet" }, performance.now(), 0)
    document.body.appendChild(document.createElement("p"))
    await new Promise(r => setTimeout(r, 0))
    expect(quietMs(handleDomQuiet({ type: "dom_quiet" }))).toBeLessThan(200)
  })
})
