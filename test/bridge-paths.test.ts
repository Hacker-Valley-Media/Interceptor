// Per-user bridge runtime paths (shared/bridge-paths.ts) must agree with the
// Swift side (Platform.runtimeDir = NSTemporaryDirectory()) and never create
// anything under /tmp. The legacy /tmp paths are detection-only fallbacks.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { bridgePidPath, bridgeSocketPath, bridgeSocketPathForDetection, LEGACY_BRIDGE_SOCKET_PATH, userRuntimeDir } from "../shared/bridge-paths"

describe("bridge runtime paths", () => {
  test("the explicit override wins and trailing slashes are stripped", () => {
    expect(userRuntimeDir({ INTERCEPTOR_BRIDGE_RUNTIME_DIR: "/x/y/", TMPDIR: "/z/" })).toBe("/x/y")
    expect(bridgeSocketPath({ INTERCEPTOR_BRIDGE_RUNTIME_DIR: "/x/y" })).toBe("/x/y/interceptor-bridge.sock")
    expect(bridgePidPath({ INTERCEPTOR_BRIDGE_RUNTIME_DIR: "/x/y" })).toBe("/x/y/interceptor-bridge.pid")
  })

  test("$TMPDIR is the per-user default", () => {
    expect(userRuntimeDir({ TMPDIR: "/var/folders/ab/cd/T/" })).toBe("/var/folders/ab/cd/T")
  })

  test("on macOS a bare environment resolves through getconf, never to /tmp", () => {
    const dir = userRuntimeDir({})
    if (process.platform === "darwin") {
      expect(dir).not.toBe("/tmp")
      expect(dir.startsWith("/var/folders/") || dir.startsWith("/private/var/folders/")).toBe(true)
    } else {
      expect(dir).toBe("/tmp")
    }
  })

  test("detection prefers the per-user socket and falls back to the legacy path only when the new one is absent", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bridge-paths-"))
    try {
      const env = { INTERCEPTOR_BRIDGE_RUNTIME_DIR: scratch }
      const current = bridgeSocketPath(env)
      // Neither exists: the per-user path is reported (nothing under /tmp is created).
      const legacyExists = existsSync(LEGACY_BRIDGE_SOCKET_PATH)
      expect(bridgeSocketPathForDetection(env)).toBe(legacyExists ? LEGACY_BRIDGE_SOCKET_PATH : current)
      writeFileSync(current, "")
      expect(bridgeSocketPathForDetection(env)).toBe(current)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
