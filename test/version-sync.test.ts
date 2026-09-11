import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import pkg from "../package.json"
import manifest from "../extension/manifest.json"
import electronManifest from "../extension/dist-mv2/manifest.json"

const runnerPlist = readFileSync(resolve(import.meta.dir, "../ios/InterceptorRunner/Generated/InterceptorRunner-Info.plist"), "utf8")
const runnerProject = readFileSync(resolve(import.meta.dir, "../ios/InterceptorRunner/project.yml"), "utf8")
const plistValue = (key: string): string | undefined =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(runnerPlist)?.[1]

describe("version sync", () => {
  test("extension/manifest.json#version matches package.json#version", () => {
    expect(manifest.version).toBe(pkg.version)
  })

  test("Electron/MV2 manifest version matches package.json#version", () => {
    expect(electronManifest.version).toBe(pkg.version)
  })

  test("iOS runner version matches package.json#version", () => {
    expect(plistValue("CFBundleShortVersionString")).toBe(pkg.version)
    expect(plistValue("CFBundleVersion")).toBe(pkg.version)
    expect(runnerProject).toContain(`CFBundleShortVersionString: "${pkg.version}"`)
    expect(runnerProject).toContain(`CFBundleVersion: "${pkg.version}"`)
  })
})
