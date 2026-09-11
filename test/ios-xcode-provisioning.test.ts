import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chooseXcodeTeam, parseXcodeTeams, preferNoXcodeIosPath, prepareXctestrunWithEnv, runnerProductBundleId } from "../daemon/ios/tools"
import { getInstalled, markInstalled } from "../daemon/ios/state"

describe("ios Xcode provisioning helpers", () => {
  test("uses Xcode launch by default and keeps the userspace launcher opt-in", () => {
    const useXcode = process.env.INTERCEPTOR_IOS_USE_XCODE
    const noXcode = process.env.INTERCEPTOR_NO_XCODE
    try {
      delete process.env.INTERCEPTOR_IOS_USE_XCODE
      delete process.env.INTERCEPTOR_NO_XCODE
      expect(preferNoXcodeIosPath()).toBe(false)
      process.env.INTERCEPTOR_NO_XCODE = "1"
      expect(preferNoXcodeIosPath()).toBe(true)
      delete process.env.INTERCEPTOR_NO_XCODE
      process.env.INTERCEPTOR_IOS_USE_XCODE = "0"
      expect(preferNoXcodeIosPath()).toBe(true)
    } finally {
      if (useXcode === undefined) delete process.env.INTERCEPTOR_IOS_USE_XCODE
      else process.env.INTERCEPTOR_IOS_USE_XCODE = useXcode
      if (noXcode === undefined) delete process.env.INTERCEPTOR_NO_XCODE
      else process.env.INTERCEPTOR_NO_XCODE = noXcode
    }
  })

  test("parseXcodeTeams extracts teams from Xcode defaults output", () => {
    const teams = parseXcodeTeams(`{
    "A" =     (
                {
            isFreeProvisioningTeam = 1;
            teamID = AW72CLPK5T;
            teamName = "Jane Appleseed (Personal Team)";
            teamType = "Personal Team";
        }
    );
    "B" =     (
                {
            isFreeProvisioningTeam = 0;
            teamID = TPWBZD35WW;
            teamName = "HACKER VALLEY MEDIA, LLC";
            teamType = Company;
        }
    );
}`)
    expect(teams).toEqual([
      {
        teamId: "AW72CLPK5T",
        teamName: "Jane Appleseed (Personal Team)",
        teamType: "Personal Team",
        isFreeProvisioningTeam: true,
      },
      {
        teamId: "TPWBZD35WW",
        teamName: "HACKER VALLEY MEDIA, LLC",
        teamType: "Company",
        isFreeProvisioningTeam: false,
      },
    ])
  })

  test("chooseXcodeTeam honors an explicit override", () => {
    expect(chooseXcodeTeam([], "ABCDE12345")).toEqual({ teamId: "ABCDE12345" })
  })

  test("chooseXcodeTeam picks the single configured team", () => {
    expect(chooseXcodeTeam([{ teamId: "AW72CLPK5T", isFreeProvisioningTeam: true }])).toEqual({ teamId: "AW72CLPK5T" })
  })

  test("chooseXcodeTeam picks the single paid team when personal teams also exist", () => {
    const selected = chooseXcodeTeam([
      { teamId: "FREE111111", isFreeProvisioningTeam: true },
      { teamId: "PAID222222", isFreeProvisioningTeam: false },
    ])
    expect(selected).toEqual({ teamId: "PAID222222" })
  })

  test("chooseXcodeTeam requires an explicit team when ambiguous", () => {
    const selected = chooseXcodeTeam([
      { teamId: "FREE111111", isFreeProvisioningTeam: true },
      { teamId: "FREE222222", isFreeProvisioningTeam: true },
    ])
    expect(selected.teamId).toBeUndefined()
    expect(selected.error).toContain("multiple Xcode teams")
  })

  test("derives a stable non-Interceptor product id from an arbitrary team", () => {
    expect(runnerProductBundleId("OTHER12345")).toBe("com.interceptor.runner.other12345")
    expect(`${runnerProductBundleId("OTHER12345")}.xctrunner`).not.toBe("com.interceptor.InterceptorRunner.xctrunner")
  })

  test("persists the actual bundle id while preserving legacy state", () => {
    const root = mkdtempSync(join(tmpdir(), "interceptor-ios-state-"))
    const prior = process.env.INTERCEPTOR_IOS_STATE_PATH
    process.env.INTERCEPTOR_IOS_STATE_PATH = join(root, "state.json")
    try {
      markInstalled("device-one", 123, "com.interceptor.runner.other12345.xctrunner")
      expect(getInstalled("DEVICE-ONE")).toMatchObject({ expiresAt: 123, bundleId: "com.interceptor.runner.other12345.xctrunner" })
      writeFileSync(process.env.INTERCEPTOR_IOS_STATE_PATH, JSON.stringify({ aliases: {}, installed: { LEGACY: { installedAt: 1 } } }))
      expect(getInstalled("legacy")).toEqual({ installedAt: 1 })
    } finally {
      if (prior === undefined) delete process.env.INTERCEPTOR_IOS_STATE_PATH
      else process.env.INTERCEPTOR_IOS_STATE_PATH = prior
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("writes the persisted host identity into Xcode launch metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "interceptor-xctestrun-"))
    const input = join(root, "Fixture.xctestrun")
    writeFileSync(input, JSON.stringify({ Fixture: {
      TestHostBundleIdentifier: "com.interceptor.InterceptorRunner.xctrunner",
      BundleIdentifiersForCrashReportEmphasis: ["com.interceptor.InterceptorRunner"],
    } }))
    try {
      const out = prepareXctestrunWithEnv(input, { INTERCEPTOR_WS_TOKEN: "token" }, "com.interceptor.runner.other12345.xctrunner")
      expect(out).toBeTruthy()
      const parsed = JSON.parse(Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", out!]).stdout.toString())
      expect(parsed.Fixture.TestHostBundleIdentifier).toBe("com.interceptor.runner.other12345.xctrunner")
      expect(parsed.Fixture.BundleIdentifiersForCrashReportEmphasis).toEqual(["com.interceptor.runner.other12345"])
      expect(parsed.Fixture.EnvironmentVariables.INTERCEPTOR_WS_TOKEN).toBe("token")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("routes the persisted identity through install, detection, and both launch paths", () => {
    const manager = readFileSync(resolve(import.meta.dir, "../daemon/ios/manager.ts"), "utf8")
    expect(manager).toContain("installRunnerApp(udid, getInstalled(udid)?.bundleId, true)")
    expect(manager).toContain("isRunnerInstalled(d.udid, this.runnerBundleId(d.udid))")
    expect(manager).toContain("testmanagerd.launchRunner(udid, { bundleId: this.runnerBundleId(udid), env })")
    expect(manager).toContain("}, this.runnerBundleId(udid))")
    expect(manager).toContain('const team = typeof action.team === "string" ? action.team : getAppleAccount()?.teamId')
    expect(manager).toContain("this.setup({ udid, team })")
    expect(manager).toContain("this.setup({ ...action, team })")
  })
})
