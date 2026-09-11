/**
 * cli/lib/surfaces.ts — which Interceptor surfaces exist on this install
 *
 *
 * Both pkgs ship the same CLI binary; the Full pkg additionally lays down the
 * bridge LaunchAgent. Surface presence is therefore detected, not compiled in:
 *   browser  — always (it IS the product)
 *   macos    — darwin + bridge LaunchAgent plist present (Full install),
 *              or a dev checkout running the bridge directly
 *   ios      — rides the Full daemon (same detection as macos)
 *
 * INTERCEPTOR_ALL_SURFACES=1 or --all-surfaces overrides detection — used by
 * docs tooling and by agents deciding whether to suggest `upgrade --full`.
 */

import { existsSync } from "node:fs"
import { bridgeSocketPathForDetection } from "../../shared/bridge-paths"

export type Surfaces = { browser: true; macos: boolean; ios: boolean }

const LAUNCH_AGENT_SYSTEM = "/Library/LaunchAgents/com.interceptor.bridge.plist"

function launchAgentUser(): string {
  return `${process.env.HOME || ""}/Library/LaunchAgents/com.interceptor.bridge.plist`
}

export function detectSurfaces(argv: string[] = [], env: Record<string, string | undefined> = process.env): Surfaces {
  if (argv.includes("--all-surfaces") || env.INTERCEPTOR_ALL_SURFACES) {
    return { browser: true, macos: true, ios: true }
  }
  const full = process.platform === "darwin" &&
    (existsSync(LAUNCH_AGENT_SYSTEM) || existsSync(launchAgentUser()) ||
     existsSync(bridgeSocketPathForDetection()))
  return { browser: true, macos: full, ios: full }
}

export const SURFACE_UPGRADE_HINT =
  "macos/ios: not available in this install — 'interceptor upgrade --full' adds computer-use mode (macOS only)."
