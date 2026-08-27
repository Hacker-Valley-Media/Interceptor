import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { COMMAND_SPECS } from "../cli/manifest"

const root = resolve(import.meta.dir, "..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

describe("Sparkle update observability contract", () => {
  test("shares one callback state between the updater delegate and domain", () => {
    const main = read("interceptor-bridge/Sources/main.swift")
    expect(main).toContain("let sparkleUpdateState = SparkleUpdateState()")
    expect(main).toContain("SparkleUpdaterDelegate(updateState: sparkleUpdateState)")
    expect(main).toContain("UpdateDomain(updaterController: updaterController, updateState: sparkleUpdateState)")
  })

  test("waits for a real conclusion and reports existing sessions truthfully", () => {
    const domain = read("interceptor-bridge/Sources/Domains/UpdateDomain.swift")
    expect(domain).toContain("updateState.beginCheck(timeout: 10)")
    expect(domain).toContain("if updater.sessionInProgress")
    expect(domain).toContain('payload["started"] = false')
    expect(domain).toContain("if updater.canCheckForUpdates")
    expect(domain).toContain("selectedDisplayVersion")
    expect(domain).toContain("use `interceptor update status` for the result")
    expect(domain).not.toContain("Sparkle will now show the alert")
    expect(domain.indexOf("if updater.sessionInProgress")).toBeLessThan(
      domain.indexOf("guard updater.canCheckForUpdates"),
    )
  })

  test("observes Sparkle results without changing channel or relaunch policy", () => {
    const delegate = read("interceptor-bridge/Sources/SparkleUserDriverDelegate.swift")
    for (const callback of [
      "didFindValidUpdate",
      "updaterDidNotFindUpdate",
      "userDidMake choice",
      "willDownloadUpdate",
      "didDownloadUpdate",
      "willExtractUpdate",
      "didExtractUpdate",
      "willInstallUpdate",
      "didAbortWithError",
      "didFinishUpdateCycleFor",
    ]) expect(delegate).toContain(callback)
    expect(delegate).toContain('return ["full"]')
    expect(delegate).toContain("func updaterShouldRelaunchApplication")
    expect(delegate).toContain("return false")
    expect(delegate).not.toContain("shouldProceedWithUpdate")
    expect(delegate).not.toContain("willInstallUpdateOnQuit")
  })

  test("publishes the observed outcome contract in command metadata", () => {
    const update = COMMAND_SPECS.find((spec) => spec.name === "update")
    expect(update?.summary).toContain("selected version")
    expect(update?.returns).toContain("outcome")
    expect(update?.returns).toContain("phase")
    expect(update?.returns).toContain("selected/latest version")
  })
})
