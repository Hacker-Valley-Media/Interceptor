import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import manifest from "../extension/manifest.json"
import electronManifest from "../extension/dist-mv2/manifest.json"

describe("version sync", () => {
  test("extension/manifest.json#version matches package.json#version", () => {
    expect(manifest.version).toBe(pkg.version)
  })

  test("Electron/MV2 manifest version matches package.json#version", () => {
    expect(electronManifest.version).toBe(pkg.version)
  })
})
