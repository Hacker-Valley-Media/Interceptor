/**
 * shared/extension-identity.ts — which extension copy is talking to the daemon.
 *
 * The Chrome Web Store install and the unpacked copy the installers leave on
 * disk share one extension ID (the store's key is pinned in the manifest).
 * `installType` from chrome.management.getSelf() is what tells them apart, and
 * it decides the fix diagnostics offer: an unpacked copy reloads from disk, a
 * store copy can only move to whatever version the store has published.
 *
 * The pre-store development ID stays in the native-host allowlist through
 * 0.25.x so unreloaded unpacked copies keep working; diagnostics name it so
 * the user can retire it.
 */
import identities from "../extension/store-identities.json"

export const STORE_EXTENSION_ID: string = identities.chrome.storeId
export const STORE_LISTING_URL: string = identities.chrome.listingUrl
export const LEGACY_DEVELOPMENT_EXTENSION_ID = "hkjbaciefhhgekldhncknbjkofbpenng"
/** The manifest key the unpacked copy carried through 0.24.13 (it derives the ID
 *  above). The installers stamp it into extension-legacy/, the copy
 *  `interceptor diagnose extension --fix` moves a leftover old-ID entry to. */
export const LEGACY_DEVELOPMENT_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr8I3MwCNVrLcP0OCP8fRpiGWHIpbu2iMsyweU4YcX/CWdmO2fnZAJ6UP+IKkM5Zw9mt9kY4CFW4tZt096ChuMKiVBg4HM47ffWHTlo6rXOzdLuXMQ6MtFDuqbQuq6x0tLgYlOr7UxSiPVFgPRuczOz+kPkTO/h8nJNDaouNY1WnG4/ESruv10gwLwxgNKEvisnjxDU6lw9zDm/+pF8aAB8RMJbJQpRRBKDVL8rTRb4yCp6qi8E9VkJRK3sTD9sX0fgZoYd4pkvbK+7kPh9oxiuzPKNCKm9v8XTCVBh+sWBJBdke7PAoERkdXOs2MEijjO2A0X4/tzqygr3oARSghkQIDAQAB"

export type ExtensionInstallType = "development" | "normal" | "sideload" | "admin" | "other"

const INSTALL_TYPES = new Set(["development", "normal", "sideload", "admin", "other"])

export function isExtensionInstallType(value: unknown): value is ExtensionInstallType {
  return typeof value === "string" && INSTALL_TYPES.has(value)
}

/** Human label for chrome.management.ExtensionInstallType. */
export function installTypeLabel(installType: string | undefined): string {
  switch (installType) {
    case "development": return "unpacked"
    case "normal": return "store"
    case "sideload": return "store (sideloaded)"
    case "admin": return "store (policy)"
    case "other": return "other"
    default: return "unknown copy"
  }
}

/** Store-managed copies get new code from the Chrome Web Store, never from a reload. */
export function isStoreManaged(installType: string | undefined): boolean {
  return installType === "normal" || installType === "sideload" || installType === "admin"
}

/** First extension version whose manifest carries the store key. Copies older
 *  than this register with a version only (no extensionId/installType) and, if
 *  unpacked, come back from a reload under the store ID with empty storage. */
export const STORE_IDENTITY_SINCE = "0.25.0"

/** True when `version` (x.y.z) is older than `STORE_IDENTITY_SINCE`. Non-numeric input → false. */
export function isPreStoreVersion(version: string | undefined): boolean {
  if (!version) return false
  const parse = (v: string) => v.split("-")[0].split(".").map(n => Number.parseInt(n, 10))
  const a = parse(version), b = parse(STORE_IDENTITY_SINCE)
  if (a.length < 3 || a.some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] }
  return false
}

const WS_ORIGIN_SCHEMES = new Set(["chrome-extension:", "moz-extension:", "safari-web-extension:"])

/**
 * Whether the daemon's loopback WebSocket port serves a request with this
 * Origin header. A browser sends Origin on every WebSocket handshake, and the
 * same-origin policy does not apply to one, so without this rule any page open
 * on the computer could connect and drive the browser (issue #274). The
 * extension sends its own scheme. The CLI, the Safari handler, the runtime
 * agent and the iOS runner are not browsers and send no Origin.
 */
export function isAllowedWsOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true
  try { return WS_ORIGIN_SCHEMES.has(new URL(origin).protocol) } catch { return false }
}

/** `chrome-extension://<id>/` (the native host's first argument) → `<id>`. */
export function extensionIdFromOrigin(origin: string | undefined): string | undefined {
  const match = origin?.match(/^chrome-extension:\/\/([a-p]{32})\/?$/)
  return match?.[1]
}
