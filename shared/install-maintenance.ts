import { existsSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { IS_WIN, MAINTENANCE_GUARD_PATH } from "./platform"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WINDOWS_SID = /^S-1-(?:\d+-)+\d+$/i

export const INSTALL_MAINTENANCE_MESSAGE = "Interceptor install/upgrade is in progress; retry after Setup exits."

export type InstallMaintenanceGuard = {
  schemaVersion: 1
  transactionId: string
  userSid: string
  setupPid: number
  priorRoot: string
  targetRoot: string
  createdAt: string
}

export type GuardInspection =
  | { status: "missing"; guard: null }
  | { status: "active"; guard: InstallMaintenanceGuard }
  | { status: "malformed"; guard: null; error: string }

function isWindowsAbsolute(path: string): boolean {
  return /^[a-z]:\\/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)
}

export function parseInstallMaintenanceGuard(value: unknown): InstallMaintenanceGuard {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("guard must be an object")
  const input = value as Record<string, unknown>
  const expected = ["schemaVersion", "transactionId", "userSid", "setupPid", "priorRoot", "targetRoot", "createdAt"].sort()
  if (Object.keys(input).sort().join("\0") !== expected.join("\0")) throw new Error("guard has unexpected or missing fields")
  if (input.schemaVersion !== 1) throw new Error("guard schemaVersion must be 1")
  if (typeof input.transactionId !== "string" || !UUID.test(input.transactionId)) throw new Error("guard transactionId is invalid")
  if (typeof input.userSid !== "string" || !WINDOWS_SID.test(input.userSid)) throw new Error("guard userSid is invalid")
  if (!Number.isSafeInteger(input.setupPid) || (input.setupPid as number) <= 0) throw new Error("guard setupPid is invalid")
  if (typeof input.priorRoot !== "string" || (input.priorRoot && !isWindowsAbsolute(input.priorRoot))) throw new Error("guard priorRoot is invalid")
  if (typeof input.targetRoot !== "string" || !isWindowsAbsolute(input.targetRoot)) throw new Error("guard targetRoot is invalid")
  if (typeof input.createdAt !== "string" || Number.isNaN(Date.parse(input.createdAt))) throw new Error("guard createdAt is invalid")
  return input as InstallMaintenanceGuard
}

export function inspectInstallMaintenanceGuard(
  path = MAINTENANCE_GUARD_PATH,
  deps: { exists: (path: string) => boolean; read: (path: string) => string } = {
    exists: existsSync,
    read: path => readFileSync(path, "utf-8"),
  },
): GuardInspection {
  if (!deps.exists(path)) return { status: "missing", guard: null }
  try {
    return { status: "active", guard: parseInstallMaintenanceGuard(JSON.parse(deps.read(path))) }
  } catch (error) {
    return { status: "malformed", guard: null, error: (error as Error).message }
  }
}

export function assertNoInstallMaintenance(options: { platform?: string; path?: string } = {}): void {
  const platform = options.platform ?? process.platform
  if (platform !== "win32") return
  const inspection = inspectInstallMaintenanceGuard(options.path)
  if (inspection.status !== "missing") throw new Error(INSTALL_MAINTENANCE_MESSAGE)
}

export function isAbsoluteOwnedRoot(path: string, platform = process.platform): boolean {
  return platform === "win32" ? isWindowsAbsolute(path) : isAbsolute(path)
}
