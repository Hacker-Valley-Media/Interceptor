import { afterEach, describe, expect, mock, test } from "bun:test"
import { handleFrameActions } from "../extension/src/background/capabilities/frames"

const sendToContentScript = mock(async (_tabId: number, _action: Record<string, unknown>, frameId?: number) => {
  if (frameId === 3) throw new Error("opaque frame")
  if (frameId === 0) {
    await Bun.sleep(10)
    return {
      success: true,
      data: {
        text: { total: 1, returned: 1, truncated: false, scannedCharacters: 100, scanTruncated: false, matches: [{ start: 10, end: 15, matchedText: "Query", snippet: "top Query" }] },
        elements: { total: 1, returned: 1, truncated: false, matches: [{ refId: "e1", role: "button", name: "Query", score: 100 }] }
      }
    }
  }
  return {
    success: true,
    data: {
      text: { total: 2, returned: 1, truncated: true, scannedCharacters: 200, scanTruncated: false, matches: [{ start: 20, end: 25, matchedText: "query", snippet: "child query" }] },
      elements: { total: 1, returned: 1, truncated: false, matches: [{ refId: "e4", role: "link", name: "Query docs", score: 60 }] }
    }
  }
})

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
  sendToContentScript.mockClear()
})

describe("find --include-frames", () => {
  test("returns stable mode-selected sections when the frame list is empty", async () => {
    globalThis.chrome = {
      webNavigation: { getAllFrames: mock(async () => []) }
    } as unknown as typeof chrome

    const result = await handleFrameActions(
      { type: "frames_find", query: "query", mode: "hybrid", limit: 10 },
      99,
      sendToContentScript as unknown as Parameters<typeof handleFrameActions>[2]
    )

    expect(result.data).toEqual({
      query: "query",
      mode: "hybrid",
      frames: [],
      text: {
        total: 0,
        returned: 0,
        truncated: false,
        scannedCharacters: 0,
        scanTruncated: false,
        matches: []
      },
      elements: { total: 0, returned: 0, truncated: false, matches: [] }
    })
  })

  test("aggregates totals, frame IDs, framed refs, and opaque-frame errors", async () => {
    globalThis.chrome = {
      webNavigation: {
        getAllFrames: mock(async () => [
          { frameId: 0, parentFrameId: -1, url: "https://top.example" },
          { frameId: 2, parentFrameId: 0, url: "https://child.example" },
          { frameId: 3, parentFrameId: 0, url: "https://opaque.example" }
        ])
      }
    } as unknown as typeof chrome

    const result = await handleFrameActions(
      { type: "frames_find", query: "query", mode: "hybrid", limit: 10 },
      99,
      sendToContentScript as unknown as Parameters<typeof handleFrameActions>[2]
    )
    const data = result.data as any

    expect(result.success).toBe(true)
    expect(data.text).toMatchObject({ total: 3, returned: 2, scannedCharacters: 300 })
    expect(data.text.matches.map((match: any) => match.frameId)).toEqual([0, 2])
    expect(data.elements).toMatchObject({ total: 2, returned: 2 })
    expect(data.elements.matches.map((match: any) => match.refId)).toEqual(["e1", "e2_4"])
    expect(data.frames.find((frame: any) => frame.frameId === 3)).toMatchObject({ opaque: true, error: "opaque frame" })
  })
})
