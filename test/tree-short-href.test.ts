// Tree hrefs drop the origin on same-origin links, tracking parameters, and long queries.
import { describe, expect, test } from "bun:test"
import { shortHref, TREE_QUERY_CHARS } from "../extension/src/content/element-tree"

const O = "http://127.0.0.1:47202"

describe("shortHref", () => {
  test("same-origin absolute prints as its path and loses tracking params", () => {
    expect(shortHref(`${O}/docs/start?utm_source=n&utm_medium=e&fbclid=abc&page=2`, O)).toBe("/docs/start?page=2")
  })
  test("a query that was only tracking disappears with its ?", () => {
    expect(shortHref(`${O}/a?utm_source=x#section-2`, O)).toBe("/a#section-2")
  })
  test("cross-origin keeps the origin", () => {
    expect(shortHref("https://example.com/p?gclid=1&id=9", O)).toBe("https://example.com/p?id=9")
  })
  test("a long query is cut at 80 characters", () => {
    const out = shortHref(`https://example.com/x?${"x=1&".repeat(40)}y=2`, O)
    expect(out).toBe(`https://example.com/x?${"x=1&".repeat(40).slice(0, TREE_QUERY_CHARS)}…`)
  })
  test("relative hrefs keep their written form", () => {
    expect(shortHref("/watch?v=dQw4w9WgXcQ", O)).toBe("/watch?v=dQw4w9WgXcQ")
    expect(shortHref("page.html?utm_campaign=z", O)).toBe("page.html")
    expect(shortHref("#top", O)).toBe("#top")
  })
  test("non-http schemes are untouched", () => {
    expect(shortHref("mailto:a@b.c?subject=utm_x", O)).toBe("mailto:a@b.c?subject=utm_x")
    expect(shortHref("javascript:void(0)", O)).toBe("javascript:void(0)")
  })
  test("query values keep their original encoding", () => {
    expect(shortHref("/s?q=a%20b+c&utm_source=x", O)).toBe("/s?q=a%20b+c")
  })
})
