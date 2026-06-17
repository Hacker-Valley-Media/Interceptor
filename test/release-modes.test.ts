/**
 * test/release-modes.test.ts
 *
 * Asserts the two release-pkg modes produce the right step lists under
 * INTERCEPTOR_DRY_RUN=1 (or --dry-run). These tests do NOT modify any
 * system state — they shell out to scripts/release.sh with the dry-run
 * flag and inspect its stdout. No keychain credentials, no notarytool,
 * no actual pkg files are produced.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const RELEASE_SCRIPT = resolve(REPO_ROOT, "scripts/release.sh")
const TEST_VERSION = "0.0.0-test"

/**
 * True on macOS. The whole describe block below is gated behind this.
 *
 * scripts/release.sh exercises the macOS-only release pipeline: codesign,
 * productbuild, xcrun notarytool/stapler, disk-image volumes, .pkg signing.
 * None of this is meaningful on Linux. The dry-run still emits the script
 * commands, but the assertions are written against macOS-specific paths and
 * would be misleading if they ran on Linux.
 */
const IS_DARWIN = process.platform === "darwin"

/**
 * Run scripts/release.sh in dry-run mode at a fixed test version and capture
 * stdout/stderr/exit status. Sets `INTERCEPTOR_DRY_RUN=1` so the script never
 * shells out to codesign/notarytool or produces real .pkg artifacts.
 */
function runReleaseDryRun(args: string[], envOverrides: Record<string, string> = {}): {
  stdout: string
  stderr: string
  status: number
} {
  const proc = spawnSync(
    "bash",
    [RELEASE_SCRIPT, "--dry-run", `--version=${TEST_VERSION}`, ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, INTERCEPTOR_DRY_RUN: "1", ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    },
  )
  return {
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
    status: proc.status ?? -1,
  }
}

describe.skipIf(!IS_DARWIN)("release modes — dry-run", () => {
  test("--browser-only emits Browser pkg and zero bridge artifacts", () => {
    const { stdout, status } = runReleaseDryRun(["--browser-only"])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode(s): browser-only")
    expect(stdout).toContain("DRY RUN")
    expect(stdout).toContain("distribution-browser.xml")
    expect(stdout).toContain(`Interceptor-Browser-${TEST_VERSION}.pkg`)
    expect(stdout).toContain("Step 6: Skipped (browser-only mode")

    // The Browser pkg branch must NOT emit any bridge-related step. This is
    // the structural enforcement: a browser-only
    // build never references the bridge .app, the LaunchAgent plist, or
    // bridge-component.plist.
    expect(stdout).not.toContain("interceptor-bridge.app")
    expect(stdout).not.toContain("com.interceptor.bridge.plist")
    expect(stdout).not.toContain("Interceptor-Bridge.pkg")
    expect(stdout).not.toContain("bridge-component.plist")
    expect(stdout).not.toContain("Interceptor-Daemon-Full.pkg")
    expect(stdout).not.toContain(`Interceptor-Full-${TEST_VERSION}`)
    expect(stdout).not.toContain("daemon-full")

    // Productbuild for browser-only must reference distribution-browser.xml,
    // never the Full distribution.xml.
    const productbuildLines = stdout
      .split("\n")
      .filter((l) => l.includes("DRY: productbuild"))
    expect(productbuildLines.length).toBe(1)
    expect(productbuildLines[0]).toContain("distribution-browser.xml")
    expect(productbuildLines[0]).not.toMatch(/distribution\.xml(?!\w)/)
  })

  test("--full emits Full pkg with bridge + LaunchAgent + bridge-component artifacts", () => {
    const { stdout, status } = runReleaseDryRun(["--full"])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode(s): full")
    expect(stdout).toContain("DRY RUN")
    expect(stdout).toContain(`Interceptor-Full-${TEST_VERSION}.pkg`)

    // Every full-only step must be present.
    expect(stdout).toContain("interceptor-bridge.app")
    expect(stdout).toContain("com.interceptor.bridge.plist")
    expect(stdout).toContain("Interceptor-Bridge.pkg")
    expect(stdout).toContain("bridge-component.plist")
    expect(stdout).toContain("Interceptor-Daemon-Full.pkg")
    expect(stdout).toContain("daemon-full")
    expect(stdout).toContain("Step 6: Stapling bridge .app")
    expect(stdout).toContain("Runtime agent dylibs: BYO (not bundled)")
    expect(stdout).toContain("Skipped InterceptorAgent dylib build")
    expect(stdout).toContain("Skipped agent dylib signing")
    expect(stdout).toContain("Runtime Agent dylibs: BYO")
    expect(stdout).not.toContain("InterceptorAgent-arm64.dylib")

    // No Browser pkg should be produced.
    expect(stdout).not.toContain(`Interceptor-Browser-${TEST_VERSION}`)
    expect(stdout).not.toContain("distribution-browser.xml")
    expect(stdout).not.toContain("Interceptor-Daemon-Browser.pkg")

    // Productbuild for full mode must reference the full distribution.xml.
    const productbuildLines = stdout
      .split("\n")
      .filter((l) => l.includes("DRY: productbuild"))
    expect(productbuildLines.length).toBe(1)
    expect(productbuildLines[0]).toMatch(/distribution\.xml(?!\w)/)
  })

  test("default (no mode flag) builds both pkgs", () => {
    const { stdout, status } = runReleaseDryRun([])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode(s): browser-only full")
    expect(stdout).toContain(`Interceptor-Browser-${TEST_VERSION}.pkg`)
    expect(stdout).toContain(`Interceptor-Full-${TEST_VERSION}.pkg`)

    // Both productbuilds must execute exactly once each, with the right
    // distribution xml.
    const productbuildLines = stdout
      .split("\n")
      .filter((l) => l.includes("DRY: productbuild"))
    expect(productbuildLines.length).toBe(2)
    const browserPb = productbuildLines.find((l) =>
      l.includes("distribution-browser.xml"),
    )
    const fullPb = productbuildLines.find(
      (l) =>
        l.includes("distribution.xml") &&
        !l.includes("distribution-browser.xml"),
    )
    expect(browserPb).toBeDefined()
    expect(fullPb).toBeDefined()

    // Both per-mode daemon component pkgs must be built.
    expect(stdout).toContain("Interceptor-Daemon-Browser.pkg")
    expect(stdout).toContain("Interceptor-Daemon-Full.pkg")

    // Step 13 must defer to the standalone publish script and surface the
    // command in the operator-facing output. release.sh stops at notarization
    // + stapling so the maintainer can test the .pkg before pushing to Sparkle.
    expect(stdout).toContain("Sparkle publish — SKIPPED")
    expect(stdout).toContain("bash scripts/publish-sparkle.sh")
  })

  test("--browser-only and --full are mutually exclusive", () => {
    const { status, stderr } = runReleaseDryRun(["--browser-only", "--full"])
    expect(status).not.toBe(0)
    expect(stderr).toContain("mutually exclusive")
  })

  test("unknown flags exit non-zero with usage hint", () => {
    const { status, stderr } = runReleaseDryRun(["--bogus-flag"])
    expect(status).not.toBe(0)
    expect(stderr).toContain("Unknown flag")
  })

  test("Browser branch payload includes daemon + extension but not bridge", () => {
    const { stdout, status } = runReleaseDryRun(["--browser-only"])
    expect(status).toBe(0)

    // The round-1 binary payload zip must include daemon + cli but not
    // the bridge .app — a structural promise that the unsigned binary
    // submission for browser-only is leaner than full.
    const payloadLines = stdout
      .split("\n")
      .filter((l) => l.includes("DRY: ditto") && l.includes("_payload"))
    expect(payloadLines.some((l) => l.includes("interceptor-daemon"))).toBe(
      true,
    )
    expect(
      payloadLines.some((l) => l.endsWith("_payload/interceptor")),
    ).toBe(true)
    expect(
      payloadLines.some((l) => l.includes("interceptor-bridge.app")),
    ).toBe(false)
  })

  test("Browser pkg uses postinstall-browser, Full pkg uses postinstall-full", () => {
    const browserOut = runReleaseDryRun(["--browser-only"]).stdout
    expect(browserOut).toContain(
      `scripts/release/postinstall-browser ${REPO_ROOT}`,
    )
    expect(browserOut).not.toContain("scripts/release/postinstall-full ")

    const fullOut = runReleaseDryRun(["--full"]).stdout
    expect(fullOut).toContain(`scripts/release/postinstall-full ${REPO_ROOT}`)
    expect(fullOut).not.toContain("scripts/release/postinstall-browser ")
  })

  test("Sparkle publish is decoupled — release.sh skips Step 13 and points at the standalone script", () => {
    const both = runReleaseDryRun([]).stdout
    // release.sh no longer auto-publishes to Sparkle; that step lives in
    // scripts/publish-sparkle.sh so the maintainer can test the .pkg
    // locally before broadcasting an auto-update.
    expect(both).toContain("Sparkle publish — SKIPPED")
    expect(both).toContain("bash scripts/publish-sparkle.sh")
    expect(both).not.toMatch(/append appcast item/)
  })

  test("Browser pkg stages the browser-surface skill only", () => {
    const { stdout, status } = runReleaseDryRun(["--browser-only"])
    expect(status).toBe(0)

    // Browser daemon staging must include the browser-surface skill.
    expect(stdout).toContain(
      `.agents/skills/interceptor-browser ${REPO_ROOT}`,
    )
    // It must NOT include the macOS skill — that ships only in Full.
    expect(stdout).not.toContain(".agents/skills/interceptor-macos")
  })

  test("Full pkg stages both the browser-surface and macOS skills", () => {
    const { stdout, status } = runReleaseDryRun(["--full"])
    expect(status).toBe(0)

    expect(stdout).toContain(
      `.agents/skills/interceptor-browser ${REPO_ROOT}`,
    )
    expect(stdout).toContain(
      `.agents/skills/interceptor-macos ${REPO_ROOT}`,
    )

    // The macOS skill stages into the daemon-full subtree, not the shared
    // daemon subtree — so an "expanded" Browser pkg never accidentally ships
    // it even from the same staging root.
    const macosLines = stdout
      .split("\n")
      .filter((l) => l.includes("interceptor-macos"))
    expect(
      macosLines.some((l) => l.includes("/staging/daemon-full/")),
    ).toBe(true)
  })

  test("research Full profile explicitly bundles runtime agent dylibs and enables platform targets", () => {
    const { stdout, status } = runReleaseDryRun(["--full"], {
      INTERCEPTOR_ENABLE_PLATFORM_TARGETS: "1",
      INTERCEPTOR_INCLUDE_AGENT_DYLIBS: "1",
    })
    expect(status).toBe(0)
    expect(stdout).toContain("Platform targets:  research enabled")
    expect(stdout).toContain("Runtime agent dylibs: bundled research payload")
    expect(stdout).toContain("Step 2b: build InterceptorAgent dylib")
    expect(stdout).toContain("InterceptorAgent-arm64.dylib")
    expect(stdout).toContain("InterceptorAgent-arm64e.dylib")
  })
})
