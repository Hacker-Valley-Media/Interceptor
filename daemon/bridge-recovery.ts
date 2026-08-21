const BRIDGE_LABEL = "com.interceptor.bridge"
const APPLICATIONS_BRIDGE_BUNDLE = "/Applications/interceptor-bridge.app"
const SYSTEM_LAUNCH_AGENT_PATH = `/Library/LaunchAgents/${BRIDGE_LABEL}.plist`

type ExistsFn = (path: string) => boolean

export type BridgeInstallMode = "browser-only" | "dev-checkout" | "full-install"

export type BridgeRecoveryActionKind =
  | "bootstrap_launchagent"
  | "kickstart_launchagent"
  | "open_applications_bundle"
  | "open_user_bundle"
  | "open_repo_bundle"
  | "spawn_bare_binary"

export interface BridgeRecoveryLayout {
  mode: BridgeInstallMode
  launchAgentInstalled: boolean
  launchAgentPath: string | null
  launchAgentDomain: string | null
  applicationsBundlePath: string
  userBundlePath: string
  repoBundlePath: string
  bundleCandidates: string[]
  availableBundlePath: string | null
  repoDistBinaryPath: string
  repoReleaseBinaryPath: string
  repoDebugBinaryPath: string
  bareBinaryCandidates: string[]
  availableBareBinaryPath: string | null
}

export interface BridgeRecoveryAction {
  kind: BridgeRecoveryActionKind
  command: string
  args: string[]
}

function userLaunchAgentPath(home: string): string {
  return `${home}/Library/LaunchAgents/${BRIDGE_LABEL}.plist`
}

function userBridgeBundlePath(home: string): string {
  return `${home}/.local/share/interceptor/interceptor-bridge.app`
}

function repoBridgeBundlePath(importMetaUrl: string): string {
  return new URL("../dist/interceptor-bridge.app", importMetaUrl).pathname
}

function repoDistBridgeBinaryPath(importMetaUrl: string): string {
  return new URL("../dist/interceptor-bridge", importMetaUrl).pathname
}

function repoReleaseBridgeBinaryPath(importMetaUrl: string): string {
  return new URL("../interceptor-bridge/.build/release/interceptor-bridge", importMetaUrl).pathname
}

function repoDebugBridgeBinaryPath(importMetaUrl: string): string {
  return new URL("../interceptor-bridge/.build/debug/interceptor-bridge", importMetaUrl).pathname
}

export function getBridgeRecoveryLayout(opts: {
  exists: ExistsFn
  home: string
  importMetaUrl: string
  uid: number | null
}): BridgeRecoveryLayout {
  const { exists, home, importMetaUrl, uid } = opts
  const launchAgentUser = userLaunchAgentPath(home)
  const launchAgentInstalled = exists(launchAgentUser) || exists(SYSTEM_LAUNCH_AGENT_PATH)
  const launchAgentPath = exists(SYSTEM_LAUNCH_AGENT_PATH)
    ? SYSTEM_LAUNCH_AGENT_PATH
    : (exists(launchAgentUser) ? launchAgentUser : null)

  const applicationsBundlePath = APPLICATIONS_BRIDGE_BUNDLE
  const userBundlePath = userBridgeBundlePath(home)
  const repoBundlePath = repoBridgeBundlePath(importMetaUrl)
  const bundleCandidates = [applicationsBundlePath, userBundlePath, repoBundlePath]
  const availableBundlePath = bundleCandidates.find(exists) ?? null

  const repoDistBinaryPath = repoDistBridgeBinaryPath(importMetaUrl)
  const repoReleaseBinaryPath = repoReleaseBridgeBinaryPath(importMetaUrl)
  const repoDebugBinaryPath = repoDebugBridgeBinaryPath(importMetaUrl)
  const bareBinaryCandidates = [repoDistBinaryPath, repoReleaseBinaryPath, repoDebugBinaryPath]
  const availableBareBinaryPath = bareBinaryCandidates.find(exists) ?? null

  const hasInstalledFullArtifact =
    launchAgentInstalled || exists(applicationsBundlePath) || exists(userBundlePath)

  return {
    mode: hasInstalledFullArtifact
      ? "full-install"
      : (availableBundlePath || availableBareBinaryPath ? "dev-checkout" : "browser-only"),
    launchAgentInstalled,
    launchAgentPath,
    launchAgentDomain: launchAgentInstalled && uid !== null ? `gui/${uid}/${BRIDGE_LABEL}` : null,
    applicationsBundlePath,
    userBundlePath,
    repoBundlePath,
    bundleCandidates,
    availableBundlePath,
    repoDistBinaryPath,
    repoReleaseBinaryPath,
    repoDebugBinaryPath,
    bareBinaryCandidates,
    availableBareBinaryPath,
  }
}

export function getBridgeRecoveryActions(
  layout: BridgeRecoveryLayout,
  exists: ExistsFn,
  opts: { launchAgentLoaded?: boolean } = {},
): BridgeRecoveryAction[] {
  const actions: BridgeRecoveryAction[] = []

  if (layout.launchAgentInstalled) {
    // Supervised starters only. An `open -gj <bundle>` here launches a bridge
    // that launchd does not own: it survives the next install/kickstart and the
    // Mac ends up with two bridges, one holding the daemon's connections and
    // one holding the socket path (observed after the 0.23.23
    // Sparkle update). launchd throttles respawns (~10 s) so the daemon's
    // reconnect/request path retries instead of escalating. Plain `kickstart`
    // (no -k) starts the job if it is down and never kills a start in progress;
    // `-k` stays with the pkg postinstall, which wants a fresh binary.
    if (layout.launchAgentDomain) {
      if (opts.launchAgentLoaded === false && layout.launchAgentPath) {
        const guiDomain = layout.launchAgentDomain.slice(0, layout.launchAgentDomain.lastIndexOf("/"))
        actions.push({
          kind: "bootstrap_launchagent",
          command: "/bin/launchctl",
          args: ["bootstrap", guiDomain, layout.launchAgentPath],
        })
      }
      actions.push({
        kind: "kickstart_launchagent",
        command: "/bin/launchctl",
        args: ["kickstart", layout.launchAgentDomain],
      })
    }
    return actions
  }
  if (exists(layout.applicationsBundlePath)) {
    actions.push({
      kind: "open_applications_bundle",
      command: "/usr/bin/open",
      args: ["-gj", layout.applicationsBundlePath],
    })
  }
  if (exists(layout.userBundlePath)) {
    actions.push({
      kind: "open_user_bundle",
      command: "/usr/bin/open",
      args: ["-gj", layout.userBundlePath],
    })
  }
  if (exists(layout.repoBundlePath)) {
    actions.push({
      kind: "open_repo_bundle",
      command: "/usr/bin/open",
      args: ["-gj", layout.repoBundlePath],
    })
  }
  if (layout.availableBareBinaryPath) {
    actions.push({
      kind: "spawn_bare_binary",
      command: layout.availableBareBinaryPath,
      args: [],
    })
  }

  return actions
}

export function formatBridgeUnavailableError(
  layout: BridgeRecoveryLayout,
  opts: { launchAgentLoaded?: boolean } = {},
): string {
  if (layout.mode === "browser-only") {
    return "Interceptor macOS control requires a full install. Run `interceptor upgrade --full`."
  }
  if (layout.mode === "full-install") {
    // Plist file on disk but never bootstrapped into launchd: kickstart will
    // fail with "Could not find service ... in domain". Tell the user to
    // bootstrap, not kickstart.
    if (layout.launchAgentInstalled && opts.launchAgentLoaded === false && layout.launchAgentPath) {
      return `Interceptor bridge is not reachable. The LaunchAgent plist at ${layout.launchAgentPath} is on disk but is NOT bootstrapped into your gui/$(id -u) domain (the pkg postinstall's bootstrap likely failed silently). Fix: \`launchctl bootstrap gui/$(id -u) ${layout.launchAgentPath} && launchctl kickstart -k gui/$(id -u)/com.interceptor.bridge\`, or log out and back in.`
    }
    return "Interceptor bridge is not reachable. Run `interceptor status` and restart `com.interceptor.bridge` with `launchctl kickstart -k gui/$(id -u)/com.interceptor.bridge`."
  }
  return "Interceptor bridge is not reachable from this source checkout. Run `bash scripts/build-bridge.sh && bash scripts/install-bridge.sh`."
}

// Issue #222. When the bridge socket closes (the bridge exited or crashed), the
// daemon must fail every in-flight bridge request immediately. Otherwise the
// CLI sits out its own 15 s timeout and prints the TCC-prompt hint, which
// points away from the real cause.
export function formatBridgeDisconnectedError(actionType: string): string {
  return `bridge disconnected while handling '${actionType}': the interceptor-bridge process exited or crashed mid-request. ` +
    `Check 'interceptor status'; if it crashed, the report is in ~/Library/Logs/DiagnosticReports/interceptor-bridge-*.ips. ` +
    `The LaunchAgent restarts it automatically; retry in a few seconds.`
}

export type PendingBridgeRequest = {
  resolve: (response: string) => void
  timer: ReturnType<typeof setTimeout>
  actionType: string
}

// Resolves each pending entry with a failure envelope through its own
// `resolve`, which is what makes this correct for both kinds of entries the
// daemon keeps: CLI requests (resolve = write to the CLI socket) and runtime
// agent delegations (resolve = send on the agent WebSocket). Returns the count.
export function failPendingBridgeRequests<T extends PendingBridgeRequest>(pending: Map<string, T>): number {
  let failed = 0
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve(JSON.stringify({ id, result: { success: false, error: formatBridgeDisconnectedError(entry.actionType) } }))
    failed++
  }
  pending.clear()
  return failed
}
