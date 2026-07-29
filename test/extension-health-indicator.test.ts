import { beforeEach, describe, expect, test } from "bun:test"
import {
  _currentVisibleState,
  _resetForTests,
  clearContextConflict,
  reportContextConflict,
  reportNativeState,
  reportWsRegistered,
  reportWsState,
} from "../extension/src/background/health-indicator"

type Call = ["text" | "color" | "title", Record<string, string>]

function actionApi(calls: Call[]) {
  return {
    setBadgeText: (details: { text: string }) => calls.push(["text", details]),
    setBadgeBackgroundColor: (details: { color: string }) => calls.push(["color", details]),
    setTitle: (details: { title: string }) => calls.push(["title", details]),
  }
}

function chromeStub(calls: Call[]) {
  return { action: actionApi(calls) }
}

function lastBadgeText(calls: Call[]): string | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === "text") return (calls[i][1] as { text: string }).text
  }
  return undefined
}

function lastTitle(calls: Call[]): string | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === "title") return (calls[i][1] as { title: string }).title
  }
  return undefined
}

describe("extension health indicator", () => {
  beforeEach(() => {
    _resetForTests()
  })

  test("cold-start state is disconnected", () => {
    expect(_currentVisibleState()).toBe("disconnected")
  })

  test("native connected → healthy (empty badge, healthy title)", () => {
    const calls: Call[] = []
    reportNativeState(chromeStub(calls), "connected")
    expect(_currentVisibleState()).toBe("healthy")
    expect(lastBadgeText(calls)).toBe("")
    expect(lastTitle(calls)).toContain("connected")
  })

  test("ws connected + registered → healthy even if native down", () => {
    reportWsState(chromeStub([]), "connected")
    reportWsRegistered(chromeStub([]), true)
    expect(_currentVisibleState()).toBe("healthy")
  })

  test("ws connected but not yet registered → degraded", () => {
    reportWsState(chromeStub([]), "connected")
    expect(_currentVisibleState()).toBe("degraded")
  })

  test("either transport connecting → connecting", () => {
    reportNativeState(chromeStub([]), "connecting")
    expect(_currentVisibleState()).toBe("connecting")
  })

  test("both transports down → disconnected with red ✕ badge", () => {
    const calls: Call[] = []
    const stub = chromeStub(calls)
    reportNativeState(stub, "connected")
    reportWsState(stub, "connected")
    reportWsRegistered(stub, true)
    reportNativeState(stub, "disconnected")
    reportWsState(stub, "disconnected")
    expect(_currentVisibleState()).toBe("disconnected")
    expect(lastBadgeText(calls)).toBe("✕")
    expect(lastTitle(calls)).toContain("disconnected")
  })

  test("native down but ws still registered stays healthy", () => {
    const stub = chromeStub([])
    reportNativeState(stub, "connected")
    reportWsState(stub, "connected")
    reportWsRegistered(stub, true)
    reportNativeState(stub, "disconnected")
    expect(_currentVisibleState()).toBe("healthy")
  })

  test("context conflict latches until registration succeeds", () => {
    const calls: Call[] = []
    const stub = chromeStub(calls)
    reportNativeState(stub, "connected")
    reportContextConflict(stub)
    expect(_currentVisibleState()).toBe("conflict")
    expect(lastBadgeText(calls)).toBe("!")
    expect(lastTitle(calls)).toContain("conflict")

    // A native reconnect must not silently clear the conflict badge.
    reportNativeState(stub, "disconnected")
    reportNativeState(stub, "connected")
    expect(_currentVisibleState()).toBe("conflict")

    // Only a successful registration clears the latch.
    reportWsRegistered(stub, true)
    expect(_currentVisibleState()).toBe("healthy")
  })

  test("clearContextConflict unlatches without needing registration", () => {
    const stub = chromeStub([])
    reportNativeState(stub, "connected")
    reportContextConflict(stub)
    expect(_currentVisibleState()).toBe("conflict")
    clearContextConflict(stub)
    expect(_currentVisibleState()).toBe("healthy")
  })

  test("ws transitioning to non-connected drops registration flag", () => {
    const stub = chromeStub([])
    reportWsState(stub, "connected")
    reportWsRegistered(stub, true)
    expect(_currentVisibleState()).toBe("healthy")
    reportWsState(stub, "disconnected")
    // With ws down and registration implicitly cleared, native still down → disconnected.
    expect(_currentVisibleState()).toBe("disconnected")
  })

  test("falls back to browserAction for MV2 bundle", () => {
    const calls: Call[] = []
    const mv2 = { browserAction: actionApi(calls) }
    reportNativeState(mv2, "connected")
    expect(lastBadgeText(calls)).toBe("")
    expect(lastTitle(calls)).toContain("connected")
  })

  test("no chrome action api available → no throw", () => {
    expect(() => reportNativeState({}, "connected")).not.toThrow()
    expect(_currentVisibleState()).toBe("healthy")
  })
})
