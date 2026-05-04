import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import manifest from "../extension/manifest.json"

describe("version sync", () => {
  test("extension/manifest.json#version matches package.json#version", () => {
    expect(manifest.version).toBe(pkg.version)
  })
})
