import { describe, expect, test } from "bun:test"

// Regression guard for issue #178. The MAIN-world bundles must not ship any
// page-visible identifier that names the extension. We build the actual entry
// points and grep the emitted JS, so re-introducing a branded window/navigator
// property, prototype flag, or Trusted-Types policy name fails the suite even if
// it type-checks. Builds in-memory (no dependency on a prior `bun run build`).

const ROOT = new URL("../", import.meta.url).pathname
// background-electron.ts (MV2/Electron) and background-safari.ts (Safari MV3)
// both initialize the same background/router, which imports the de-branded
// evaluate/binary-sink/canvas capabilities — so a re-brand reaching those
// bundles must fail here too, not just in the Chrome MV3 background.
const ENTRYPOINTS = [
  "extension/src/inject-net.ts",
  "extension/src/inject-canvas.ts",
  "extension/src/background.ts",
  "extension/src/background-electron.ts",
  "extension/src/background-safari.ts",
]

// The exact identifiers this PR removed. Deliberately NOT the CustomEvent channel
// names (`__interceptor_net`, `__interceptor_headers`, `__interceptor_set_overrides`,
// …) — those are page-visible too but are a separate, deferred fix (#178), so they
// are expected to remain and must not be asserted against here. Also deliberately
// NOT `__interceptor_trust`: that per-event marker is a documented public contract
// (README / AGENTS / use-cases) set by user `eval --main` code, so renaming it is a
// breaking migration that belongs with the same per-session-namespace work (#178).
const FORBIDDEN = [
  "__interceptor_net_installed",
  "__interceptor_ws_installed",
  "__interceptor_broadcast_installed",
  "__interceptor_beacon_installed",
  "__interceptor_canvas_installed",
  "__interceptor_tt_policy",
  "__interceptor_sink_tt_policy",
  "__interceptor_override_rules",
  "__interceptorCanvasObserver",
  "__interceptor_canvas_wrapped",
  "__interceptor_canvas_get_context_wrapped",
  "interceptor-eval",
  "interceptor-net",
  "interceptor-binary-sink",
]

async function bundle(entry: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [ROOT + entry], target: "browser" })
  expect(result.success).toBe(true)
  let out = ""
  for (const o of result.outputs) out += await o.text()
  return out
}

describe("no branded page-visible identifiers in built bundles (#178)", () => {
  for (const entry of ENTRYPOINTS) {
    test(`${entry} is de-branded`, async () => {
      const js = await bundle(entry)
      const hits = FORBIDDEN.filter((id) => js.includes(id))
      expect(hits).toEqual([])
    })
  }

  test("the one-line detector string does not appear as a guard name", async () => {
    // A page's generic check greps window keys for "__interceptor". After this fix
    // the only "__interceptor" strings left in inject-net are the deferred event
    // NAMES, never an enumerable window/navigator property assignment.
    const js = await bundle("extension/src/inject-net.ts")
    // guard-shaped assignments look like `<obj>.__interceptor..._installed = true`
    expect(/\.__interceptor\w*_installed\b/.test(js)).toBe(false)
  })
})
