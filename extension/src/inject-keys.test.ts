import { describe, expect, test } from "bun:test"
import {
  IK_BEACON, IK_BROADCAST, IK_CANVAS, IK_CANVAS_OBSERVER, IK_CANVAS_WRAPPED,
  IK_GETCTX_WRAPPED, IK_NET, IK_SINK_TT_POLICY, IK_TT_POLICY, IK_WS,
  K_BEACON, K_BROADCAST, K_CANVAS, K_CANVAS_OBSERVER, K_CANVAS_WRAPPED,
  K_GETCTX_WRAPPED, K_NET, K_TT_POLICY, K_WS,
  SINK_TT_POLICY_NAME, TT_NET_POLICY_NAME, TT_POLICY_NAME,
} from "./inject-keys"

// The whole fix (issue #178) rests on one cross-context invariant: the inject
// scripts (which `import` the symbol) and the background executeScript functions
// (which re-derive it from the STRING with Symbol.for, because they run with no
// lexical scope) must resolve to the SAME symbol. If that ever drifts, the canvas
// observer read returns undefined and eval loses its Trusted-Types policy —
// silently, with no type error. These tests pin the invariant.

describe("inject-keys cross-context invariant", () => {
  const pairs: [string, symbol][] = [
    [IK_NET, K_NET], [IK_CANVAS, K_CANVAS], [IK_WS, K_WS],
    [IK_BROADCAST, K_BROADCAST], [IK_BEACON, K_BEACON], [IK_TT_POLICY, K_TT_POLICY],
    [IK_CANVAS_OBSERVER, K_CANVAS_OBSERVER], [IK_CANVAS_WRAPPED, K_CANVAS_WRAPPED],
    [IK_GETCTX_WRAPPED, K_GETCTX_WRAPPED],
  ]

  test("Symbol.for(string) re-derivation equals the imported symbol", () => {
    // This is exactly what the executeScript bodies do: Symbol.for(keyArg).
    for (const [str, sym] of pairs) expect(Symbol.for(str)).toBe(sym)
  })

  test("write via imported symbol, read via re-derived string — round-trips", () => {
    // inject-canvas.ts writes window[K_CANVAS_OBSERVER]; canvas.ts reads
    // window[Symbol.for(IK_CANVAS_OBSERVER)]. Simulate both sides on one object.
    const win: Record<PropertyKey, unknown> = {}
    const observer = { partialCoverageReasons: ["x"] }
    win[K_CANVAS_OBSERVER] = observer // inject side
    const readBack = win[Symbol.for(IK_CANVAS_OBSERVER)] // background executeScript side
    expect(readBack).toBe(observer)
  })

  test("IK_SINK_TT_POLICY re-derivation is stable (binary-sink has no exported symbol)", () => {
    expect(Symbol.for(IK_SINK_TT_POLICY)).toBe(Symbol.for(IK_SINK_TT_POLICY))
    expect(Symbol.for(IK_SINK_TT_POLICY)).not.toBe(K_TT_POLICY) // sink policy is distinct from eval policy
  })

  test("all registry strings are distinct", () => {
    const all = [IK_NET, IK_CANVAS, IK_WS, IK_BROADCAST, IK_BEACON, IK_TT_POLICY,
      IK_SINK_TT_POLICY, IK_CANVAS_OBSERVER, IK_CANVAS_WRAPPED, IK_GETCTX_WRAPPED]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe("inject-keys are not page-detectable by name", () => {
  test("symbol-keyed props are excluded from all string enumeration", () => {
    const win: Record<PropertyKey, unknown> = {}
    win[K_NET] = true
    win[K_CANVAS_OBSERVER] = {}
    win[K_TT_POLICY] = {}
    expect(Object.keys(win)).toEqual([])
    expect(Object.getOwnPropertyNames(win)).toEqual([])
    expect(JSON.stringify(win)).toBe("{}")
    // the exact one-liner from the PoC in issue #178
    expect(Object.keys(win).some((k) => k.startsWith("__interceptor"))).toBe(false)
    for (const k in win) throw new Error(`for..in leaked ${String(k)}`)
  })

  test("registry strings and policy names carry no vendor name", () => {
    const strings = [IK_NET, IK_CANVAS, IK_WS, IK_BROADCAST, IK_BEACON, IK_TT_POLICY,
      IK_SINK_TT_POLICY, IK_CANVAS_OBSERVER, IK_CANVAS_WRAPPED, IK_GETCTX_WRAPPED,
      TT_POLICY_NAME, TT_NET_POLICY_NAME, SINK_TT_POLICY_NAME]
    for (const s of strings) expect(s.toLowerCase()).not.toContain("interceptor")
  })
})
