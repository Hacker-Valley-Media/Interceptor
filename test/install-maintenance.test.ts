import { describe, expect, test } from "bun:test"
import {
  INSTALL_MAINTENANCE_MESSAGE,
  assertNoInstallMaintenance,
  inspectInstallMaintenanceGuard,
  parseInstallMaintenanceGuard,
} from "../shared/install-maintenance"

const GUARD = {
  schemaVersion: 1 as const,
  transactionId: "2b558210-3fb7-4d78-9e79-8d658b62df44",
  userSid: "S-1-5-21-100-200-300-1001",
  setupPid: 1234,
  priorRoot: "C:\\Users\\User\\AppData\\Local\\Programs\\Interceptor",
  targetRoot: "C:\\Users\\User\\AppData\\Local\\Programs\\Interceptor",
  createdAt: "2026-08-01T12:00:00.000Z",
}

describe("Windows install maintenance guard", () => {
  test("parses the exact schema", () => {
    expect(parseInstallMaintenanceGuard(GUARD)).toEqual(GUARD)
  })

  test("rejects missing, extra, traversal-like, and malformed fields", () => {
    expect(() => parseInstallMaintenanceGuard({ ...GUARD, extra: true })).toThrow("unexpected or missing")
    expect(() => parseInstallMaintenanceGuard({ ...GUARD, setupPid: 0 })).toThrow("setupPid")
    expect(() => parseInstallMaintenanceGuard({ ...GUARD, targetRoot: "..\\foreign" })).toThrow("targetRoot")
    expect(() => parseInstallMaintenanceGuard({ ...GUARD, userSid: "root" })).toThrow("userSid")
  })

  test("distinguishes missing, active, and malformed files", () => {
    expect(inspectInstallMaintenanceGuard("guard", { exists: () => false, read: () => "" })).toEqual({ status: "missing", guard: null })
    expect(inspectInstallMaintenanceGuard("guard", { exists: () => true, read: () => JSON.stringify(GUARD) })).toEqual({ status: "active", guard: GUARD })
    expect(inspectInstallMaintenanceGuard("guard", { exists: () => true, read: () => "{" }).status).toBe("malformed")
  })

  test("non-Windows ignores the Windows guard", () => {
    expect(() => assertNoInstallMaintenance({ platform: "darwin", path: "/definitely/missing" })).not.toThrow()
  })

  test("Windows fails closed for a present malformed guard", () => {
    expect(() => assertNoInstallMaintenance({ platform: "win32", path: import.meta.path })).toThrow(INSTALL_MAINTENANCE_MESSAGE)
  })
})
