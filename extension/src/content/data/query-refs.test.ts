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

type QueryData = { count: number; elements: Array<{ index: number; ref: string; tag: string }> }

describe("handleQuery ref bridge", () => {
  test("every returned element carries a resolvable e<ref>", async () => {
    const { handleQuery } = await import("./query")
    const { resolveRef } = await import("../ref-registry")
    for (let i = 0; i < 3; i++) {
      const b = document.createElement("button")
      b.textContent = `b${i}`
      document.body.appendChild(b)
    }
    const res = await handleQuery({ type: "query", selector: "button" })
    expect(res.success).toBe(true)
    const data = res.data as QueryData
    expect(data.count).toBe(3)
    for (const el of data.elements) {
      expect(el.ref).toMatch(/^e\d+$/)
      expect(resolveRef(el.ref)?.textContent).toBe(`b${el.index}`)
    }
  })

  test("re-querying the same elements returns the same refs", async () => {
    const { handleQuery } = await import("./query")
    const b = document.createElement("button")
    b.textContent = "stable"
    document.body.appendChild(b)
    const first = (await handleQuery({ type: "query", selector: "button" })).data as QueryData
    const second = (await handleQuery({ type: "query", selector: "button" })).data as QueryData
    expect(second.elements[0].ref).toBe(first.elements[0].ref)
  })

  test("count reflects all matches while refs cover the first 20", async () => {
    const { handleQuery } = await import("./query")
    for (let i = 0; i < 25; i++) {
      const a = document.createElement("a")
      a.textContent = `a${i}`
      document.body.appendChild(a)
    }
    const data = (await handleQuery({ type: "query", selector: "a" })).data as QueryData
    expect(data.count).toBe(25)
    expect(data.elements).toHaveLength(20)
    expect(new Set(data.elements.map(e => e.ref)).size).toBe(20)
  })
})
