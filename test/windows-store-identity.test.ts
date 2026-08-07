import { describe, expect, test } from "bun:test"
import manifest from "../extension/manifest.json"
import identitiesJson from "../extension/store-identities.json"
import {
  deriveChromiumExtensionId,
  makeNativeHostManifest,
  parseStoreIdentities,
  validateStoreIdentities,
} from "../scripts/installer/generate-native-host"

describe("Windows store identity source", () => {
  const identities = parseStoreIdentities(identitiesJson)

  test("derives the checked development ID from the public key", () => {
    expect(deriveChromiumExtensionId(identities.chrome.publicKey)).toBe("hkjbaciefhhgekldhncknbjkofbpenng")
    expect(identities.chrome.publicKey).toBe(manifest.key)
  })

  test("fails the production gate while store approvals are pending", () => {
    expect(() => validateStoreIdentities(identities, { production: true, extensionManifestKey: manifest.key }))
      .toThrow("not approved")
  })

  test("development output contains only the proven identity and a relative daemon path", () => {
    const nativeHost = makeNativeHostManifest(identities, false)
    expect(nativeHost.path).toBe("interceptor-daemon.exe")
    expect(nativeHost.allowed_origins).toEqual(["chrome-extension://hkjbaciefhhgekldhncknbjkofbpenng/"])
  })

  test("rejects unknown fields and mismatched IDs", () => {
    expect(() => parseStoreIdentities({ ...identitiesJson, surprise: true })).toThrow("keys must be exactly")
    const changed = structuredClone(identities)
    changed.chrome.storeId = "a".repeat(32)
    expect(() => validateStoreIdentities(changed, { production: false })).toThrow("does not match")
  })
})
