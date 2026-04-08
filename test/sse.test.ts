import { describe, it, expect } from "bun:test"

describe("SSE chunk parsing", () => {
  it("parses SSE data lines", () => {
    const raw = 'data: {"message":{"content":{"parts":["Hello"]}}}\n\ndata: {"message":{"content":{"parts":["Hello world"]}}}\n\ndata: [DONE]\n\n'
    const lines = raw.split("\n")
    const parts: string[] = []
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const payload = line.slice(6).trim()
      if (payload === "[DONE]") break
      try {
        const obj = JSON.parse(payload)
        const content = obj?.message?.content?.parts
        if (Array.isArray(content)) {
          for (const p of content) {
            if (typeof p === "string") parts.push(p)
          }
        }
      } catch {}
    }
    expect(parts.length).toBe(2)
    expect(parts[0]).toBe("Hello")
    expect(parts[1]).toBe("Hello world")
  })

  it("handles empty data lines", () => {
    const raw = "data: \n\ndata: [DONE]\n\n"
    const lines = raw.split("\n")
    let doneFound = false
    for (const line of lines) {
      if (line === "data: [DONE]") doneFound = true
    }
    expect(doneFound).toBe(true)
  })

  it("detects SSE content type", () => {
    const types = [
      "text/event-stream",
      "text/event-stream; charset=utf-8",
      "TEXT/EVENT-STREAM",
    ]
    for (const t of types) {
      expect(t.toLowerCase().includes("text/event-stream")).toBe(true)
    }
    expect("application/json".toLowerCase().includes("text/event-stream")).toBe(false)
  })

  it("handles chunked UTF-8 correctly", () => {
    const decoder = new TextDecoder("utf-8")
    const encoder = new TextEncoder()
    const full = "data: hello world\n\n"
    const bytes = encoder.encode(full)

    // Split in the middle
    const chunk1 = bytes.slice(0, 10)
    const chunk2 = bytes.slice(10)

    const part1 = decoder.decode(chunk1, { stream: true })
    const part2 = decoder.decode(chunk2, { stream: true })
    const result = part1 + part2
    expect(result).toBe(full)
  })

  it("accumulates chunks into full body", () => {
    const chunks = ["data: {\"a\":1}\n\n", "data: {\"b\":2}\n\n", "data: [DONE]\n\n"]
    const fullBody = chunks.join("")
    expect(fullBody).toContain("data: [DONE]")
    expect(fullBody.split("data: ").length - 1).toBe(3)
  })
})
