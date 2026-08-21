import { describe, expect, test } from "bun:test"
import {
  failPendingBridgeRequests,
  formatBridgeDisconnectedError,
  formatBridgeUnavailableError,
  getBridgeRecoveryActions,
  getBridgeRecoveryLayout,
} from "../daemon/bridge-recovery"

const home = "/Users/tester"
const uid = 501
const daemonImportMetaUrl = new URL("../daemon/index.ts", import.meta.url).href
const repoBundlePath = new URL("../dist/interceptor-bridge.app", daemonImportMetaUrl).pathname
const repoDistBinaryPath = new URL("../dist/interceptor-bridge", daemonImportMetaUrl).pathname

function existsFor(paths: string[]) {
  const set = new Set(paths)
  return (path: string) => set.has(path)
}

describe("bridge recovery layout", () => {
  test("browser-only mode produces upgrade guidance and no recovery actions", () => {
    const layout = getBridgeRecoveryLayout({
      exists: existsFor([]),
      home,
      importMetaUrl: daemonImportMetaUrl,
      uid,
    })

    expect(layout.mode).toBe("browser-only")
    expect(layout.launchAgentInstalled).toBe(false)
    expect(layout.availableBundlePath).toBeNull()
    expect(getBridgeRecoveryActions(layout, existsFor([]))).toEqual([])
    expect(formatBridgeUnavailableError(layout)).toContain("interceptor upgrade --full")
  })

  test("user-local full install only kickstarts the LaunchAgent (no unsupervised open)", () => {
    const userLaunchAgent = `${home}/Library/LaunchAgents/com.interceptor.bridge.plist`
    const userBundle = `${home}/.local/share/interceptor/interceptor-bridge.app`
    const exists = existsFor([userLaunchAgent, userBundle])
    const layout = getBridgeRecoveryLayout({
      exists,
      home,
      importMetaUrl: daemonImportMetaUrl,
      uid,
    })

    expect(layout.mode).toBe("full-install")
    expect(layout.launchAgentDomain).toBe("gui/501/com.interceptor.bridge")
    expect(layout.availableBundlePath).toBe(userBundle)

    const actions = getBridgeRecoveryActions(layout, exists)
    expect(actions.map((action) => action.kind)).toEqual(["kickstart_launchagent"])
    // Plain kickstart: `-k` would kill a start launchd already has in flight.
    expect(actions[0].args).toEqual(["kickstart", "gui/501/com.interceptor.bridge"])
  })

  test("pkg full install only kickstarts the LaunchAgent (no /Applications open)", () => {
    const systemLaunchAgent = "/Library/LaunchAgents/com.interceptor.bridge.plist"
    const applicationsBundle = "/Applications/interceptor-bridge.app"
    const exists = existsFor([systemLaunchAgent, applicationsBundle])
    const layout = getBridgeRecoveryLayout({
      exists,
      home,
      importMetaUrl: daemonImportMetaUrl,
      uid,
    })

    expect(layout.mode).toBe("full-install")
    expect(layout.availableBundlePath).toBe(applicationsBundle)

    const actions = getBridgeRecoveryActions(layout, exists)
    expect(actions.map((action) => action.kind)).toEqual(["kickstart_launchagent"])
    expect(actions.some((action) => action.command === "/usr/bin/open")).toBe(false)
    expect(actions.some((action) => action.args.includes("-k"))).toBe(false)
    expect(formatBridgeUnavailableError(layout)).not.toContain("build-bridge.sh")
    expect(formatBridgeUnavailableError(layout)).toContain("interceptor status")
  })

  test("pkg full install with plist NOT bootstrapped recovers via bootstrap then kickstart, never open", () => {
    const systemLaunchAgent = "/Library/LaunchAgents/com.interceptor.bridge.plist"
    const applicationsBundle = "/Applications/interceptor-bridge.app"
    const exists = existsFor([systemLaunchAgent, applicationsBundle])
    const layout = getBridgeRecoveryLayout({
      exists,
      home,
      importMetaUrl: daemonImportMetaUrl,
      uid,
    })

    const actions = getBridgeRecoveryActions(layout, exists, { launchAgentLoaded: false })
    expect(actions.map((action) => action.kind)).toEqual([
      "bootstrap_launchagent",
      "kickstart_launchagent",
    ])
    expect(actions[0].args).toEqual(["bootstrap", "gui/501", systemLaunchAgent])
    expect(actions[1].args).toEqual(["kickstart", "gui/501/com.interceptor.bridge"])
    expect(actions.some((action) => action.command === "/usr/bin/open")).toBe(false)
  })

  test("pkg full install with plist NOT bootstrapped tells the user to bootstrap, not kickstart", () => {
    const systemLaunchAgent = "/Library/LaunchAgents/com.interceptor.bridge.plist"
    const applicationsBundle = "/Applications/interceptor-bridge.app"
    const exists = existsFor([systemLaunchAgent, applicationsBundle])
    const layout = getBridgeRecoveryLayout({
      exists,
      home,
      importMetaUrl: daemonImportMetaUrl,
      uid,
    })

    const error = formatBridgeUnavailableError(layout, { launchAgentLoaded: false })
    expect(error).toContain("launchctl bootstrap")
    expect(error).toContain(systemLaunchAgent)
    expect(error).toContain("log out and back in")
  })

  test("pkg full install with plist already bootstrapped falls back to kickstart guidance", () => {
    const systemLaunchAgent = "/Library/LaunchAgents/com.interceptor.bridge.plist"
    const applicationsBundle = "/Applications/interceptor-bridge.app"
    const exists = existsFor([systemLaunchAgent, applicationsBundle])
    const layout = getBridgeRecoveryLayout({
      exists,
      home,
      importMetaUrl: daemonImportMetaUrl,
      uid,
    })

    const error = formatBridgeUnavailableError(layout, { launchAgentLoaded: true })
    expect(error).not.toContain("launchctl bootstrap")
    expect(error).toContain("kickstart")
  })

  test("repo fallback uses the repo bundle before the bare binary", () => {
    const exists = existsFor([repoBundlePath, repoDistBinaryPath])
    const layout = getBridgeRecoveryLayout({
      exists,
      home,
      importMetaUrl: daemonImportMetaUrl,
      uid,
    })

    expect(layout.mode).toBe("dev-checkout")
    expect(layout.availableBundlePath).toBe(repoBundlePath)
    expect(layout.availableBareBinaryPath).toBe(repoDistBinaryPath)

    const actions = getBridgeRecoveryActions(layout, exists)
    expect(actions.map((action) => action.kind)).toEqual([
      "open_repo_bundle",
      "spawn_bare_binary",
    ])
    expect(formatBridgeUnavailableError(layout)).toContain("build-bridge.sh")
  })
})

describe("bridge disconnect fails in-flight requests (issue #222)", () => {
  test("every pending entry is resolved with a failure envelope, timers cleared, map emptied", async () => {
    const cliWrites: string[] = []
    const agentSends: string[] = []
    let timerFired = 0
    const pending = new Map<string, {
      resolve: (response: string) => void
      timer: ReturnType<typeof setTimeout>
      cliSocket: { write: (data: Buffer | string) => number }
      startTime: number
      actionType: string
    }>()
    pending.set("req-cli", {
      resolve: (response) => { cliWrites.push(response) },
      timer: setTimeout(() => { timerFired++ }, 20),
      cliSocket: { write: () => 0 },
      startTime: Date.now(),
      actionType: "macos_compound",
    })
    pending.set("req-agent", {
      resolve: (response) => { agentSends.push(response) },
      timer: setTimeout(() => { timerFired++ }, 20),
      cliSocket: { write: () => 0 },
      startTime: Date.now(),
      actionType: "macos_tree",
    })

    expect(failPendingBridgeRequests(pending)).toBe(2)
    expect(pending.size).toBe(0)

    const cli = JSON.parse(cliWrites[0]) as { id: string; result: { success: boolean; error: string } }
    expect(cli.id).toBe("req-cli")
    expect(cli.result.success).toBe(false)
    expect(cli.result.error).toContain("macos_compound")
    expect(cli.result.error).toContain("bridge disconnected")

    const agent = JSON.parse(agentSends[0]) as { id: string; result: { success: boolean; error: string } }
    expect(agent.id).toBe("req-agent")
    expect(agent.result.success).toBe(false)
    expect(agent.result.error).toContain("macos_tree")

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(timerFired).toBe(0)
  })

  test("empty map is a no-op", () => {
    expect(failPendingBridgeRequests(new Map())).toBe(0)
  })

  test("disconnect error names the action, interceptor status, and the crash-report path", () => {
    const msg = formatBridgeDisconnectedError("macos_compound")
    expect(msg).toContain("'macos_compound'")
    expect(msg).toContain("interceptor status")
    expect(msg).toContain("~/Library/Logs/DiagnosticReports/interceptor-bridge-*.ips")
    expect(msg).not.toContain("TCC")
  })
})
