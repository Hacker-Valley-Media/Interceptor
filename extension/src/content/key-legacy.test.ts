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

function recorder(target: Element, types: string[]): KeyboardEvent[] {
  const seen: KeyboardEvent[] = []
  for (const type of types) target.addEventListener(type, (e) => seen.push(e as KeyboardEvent))
  return seen
}

describe("dispatchKeySequence legacy key properties", () => {
  test("Enter carries keyCode 13, which 13 — the check a shipped composer makes", async () => {
    const { dispatchKeySequence } = await import("./input-simulation")
    const input = document.createElement("input")
    document.body.appendChild(input)

    // This is the failure verbatim: a widget that sends on `e.keyCode === 13`
    // received keyCode 0 and declined the key, with no error on either side.
    let sent = false
    input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).keyCode === 13) sent = true })

    dispatchKeySequence(input, "Enter")
    expect(sent).toBe(true)
  })

  test("named, letter and digit keys all resolve to their legacy numbers", async () => {
    const { getLegacyKeyCode } = await import("./input-simulation")
    expect(getLegacyKeyCode("Enter")).toBe(13)
    expect(getLegacyKeyCode("Tab")).toBe(9)
    expect(getLegacyKeyCode("Escape")).toBe(27)
    expect(getLegacyKeyCode("Backspace")).toBe(8)
    expect(getLegacyKeyCode("ArrowDown")).toBe(40)
    expect(getLegacyKeyCode("Space")).toBe(32)
    expect(getLegacyKeyCode("F5")).toBe(116)
    expect(getLegacyKeyCode("a")).toBe(65)
    expect(getLegacyKeyCode("A")).toBe(65)
    expect(getLegacyKeyCode("7")).toBe(55)
  })

  test("keyCode and which agree on every event of the sequence", async () => {
    const { dispatchKeySequence } = await import("./input-simulation")
    const input = document.createElement("input")
    document.body.appendChild(input)
    const seen = recorder(input, ["keydown", "keypress", "keyup"])

    dispatchKeySequence(input, "Enter")
    expect(seen.length).toBe(3)
    for (const event of seen) {
      expect(event.keyCode).toBe(13)
      expect(event.which).toBe(13)
    }
  })

  test("modifiers still ride along, and do not change the legacy code of the key", async () => {
    const { dispatchKeySequence } = await import("./input-simulation")
    const input = document.createElement("input")
    document.body.appendChild(input)
    const seen = recorder(input, ["keydown"])

    dispatchKeySequence(input, "Control+Shift+a")
    expect(seen[0]!.ctrlKey).toBe(true)
    expect(seen[0]!.shiftKey).toBe(true)
    expect(seen[0]!.keyCode).toBe(65)
  })
})

describe("dispatchKeySequence keypress fidelity", () => {
  test("no keypress for a non-printing key, as in a real browser", async () => {
    const { dispatchKeySequence } = await import("./input-simulation")
    const input = document.createElement("input")
    document.body.appendChild(input)
    const seen = recorder(input, ["keydown", "keypress", "keyup"])

    dispatchKeySequence(input, "ArrowDown")
    expect(seen.map((e) => e.type)).toEqual(["keydown", "keyup"])
  })

  test("a keydown the page cancels suppresses the keypress", async () => {
    const { dispatchKeySequence } = await import("./input-simulation")
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.addEventListener("keydown", (e) => e.preventDefault())
    const seen = recorder(input, ["keydown", "keypress", "keyup"])

    dispatchKeySequence(input, "Enter")
    expect(seen.map((e) => e.type)).toEqual(["keydown", "keyup"])
  })

  test("keypress carries charCode for a printable key", async () => {
    const { dispatchKeySequence } = await import("./input-simulation")
    const input = document.createElement("input")
    document.body.appendChild(input)
    const seen = recorder(input, ["keypress"])

    dispatchKeySequence(input, "a")
    expect(seen.length).toBe(1)
    expect(seen[0]!.charCode).toBe(97)
    // Blink reports keyCode === charCode on keypress, where keydown/keyup carry
    // the virtual key (65). A handler that reads keypress keyCode expects 97.
    expect(seen[0]!.keyCode).toBe(97)
  })
})

describe("legacy codes reach a listener in another world", () => {
  // The bug this guards against is invisible to every test above, because they
  // all listen in the world that dispatched. 0DIN Loki measured a MAIN-world
  // listener still seeing `{keyCode: 0, which: 0}` while these tests passed:
  // `Object.defineProperty` on an event marks the isolated-world wrapper only,
  // and the page is handed a fresh wrapper built from the C++ event.
  //
  // The init dictionary is the only mechanism that crosses, so assert on what
  // reaches the constructor rather than on what a same-world listener reads —
  // a listener here cannot tell the two mechanisms apart, which is precisely
  // how the bug survived a green suite. Drop `keyCode`/`which` from the init
  // dict in `dispatchKeySequence` and this test fails while the rest stay green.
  test("the legacy codes are passed in the init dictionary, not only defined afterwards", async () => {
    const { dispatchKeySequence } = await import("./input-simulation")
    const Real = globalThis.KeyboardEvent
    const inits: Array<Record<string, unknown>> = []
    class SpyKeyboardEvent extends Real {
      constructor(type: string, init: KeyboardEventInit = {}) {
        inits.push({ type, ...init })
        super(type, init)
      }
    }
    ;(globalThis as unknown as Record<string, unknown>).KeyboardEvent = SpyKeyboardEvent
    try {
      const input = document.createElement("input")
      document.body.appendChild(input)
      dispatchKeySequence(input, "Enter")
    } finally {
      ;(globalThis as unknown as Record<string, unknown>).KeyboardEvent = Real
    }

    expect(inits.map((i) => i.type)).toEqual(["keydown", "keypress", "keyup"])
    for (const init of inits) {
      expect(init.keyCode).toBe(13)
      expect(init.which).toBe(13)
    }
    // charCode is 0 on keydown/keyup and carries the character on keypress.
    expect(inits.map((i) => i.charCode)).toEqual([0, 13, 0])
  })
})
