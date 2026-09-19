import { describe, expect, test } from "bun:test"
import { shouldPreserveNativeFetch } from "./preserve-native-fetch"

describe("shouldPreserveNativeFetch", () => {
  test("keeps native fetch on exact Upwork hosts", () => {
    expect(shouldPreserveNativeFetch("upwork.com")).toBe(true)
    expect(shouldPreserveNativeFetch("www.upwork.com")).toBe(true)
  })

  test("does not match lookalikes or other sites", () => {
    expect(shouldPreserveNativeFetch("example.com")).toBe(false)
    expect(shouldPreserveNativeFetch("upwork.com.example.org")).toBe(false)
    expect(shouldPreserveNativeFetch("www.upwork.com.evil")).toBe(false)
    expect(shouldPreserveNativeFetch("app.upwork.com")).toBe(false)
    expect(shouldPreserveNativeFetch("")).toBe(false)
  })
})
