import { describe, expect, test } from "bun:test"
import manifest from "../extension/manifest.json"
import identitiesJson from "../extension/store-identities.json"
import {
  deriveChromiumExtensionId,
  edgeDeclared,
  makeNativeHostManifest,
  parseStoreIdentities,
  validateStoreIdentities,
} from "../scripts/installer/generate-native-host"

describe("Windows store identity source", () => {
  const identities = parseStoreIdentities(identitiesJson)

  test("derives the Chrome Web Store ID from the public key pinned in the manifest", () => {
    expect(deriveChromiumExtensionId(identities.chrome.publicKey)).toBe("gomcpnagjjlhehnkoobkjgnkbleiooed")
    expect(identities.chrome.publicKey).toBe(manifest.key)
    expect(identities.chrome.approvalStatus).toBe("approved")
    expect(identities.chrome.listingUrl).toBe("https://chromewebstore.google.com/detail/interceptor/gomcpnagjjlhehnkoobkjgnkbleiooed")
  })

  test("production passes with the Chrome identity approved and Edge untouched", () => {
    expect(() => validateStoreIdentities(identities, { production: true, extensionManifestKey: manifest.key })).not.toThrow()
    expect(edgeDeclared(identities.edge)).toBe(false)
  })

  test("production output carries the store identity only and a relative daemon path", () => {
    for (const production of [true, false]) {
      const nativeHost = makeNativeHostManifest(identities, production)
      expect(nativeHost.path).toBe("interceptor-daemon.exe")
      expect(nativeHost.allowed_origins).toEqual(["chrome-extension://gomcpnagjjlhehnkoobkjgnkbleiooed/"])
    }
  })

  test("a half-filled Edge record blocks production until it is approved", () => {
    const pending = structuredClone(identities)
    pending.edge.storeId = "b".repeat(32)
    expect(edgeDeclared(pending.edge)).toBe(true)
    expect(() => validateStoreIdentities(pending, { production: true })).toThrow("edge store identity is not approved")
    expect(makeNativeHostManifest(pending, false).allowed_origins).toEqual([
      "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
      "chrome-extension://gomcpnagjjlhehnkoobkjgnkbleiooed/",
    ])
  })

  test("rejects unknown fields and mismatched IDs", () => {
    expect(() => parseStoreIdentities({ ...identitiesJson, surprise: true })).toThrow("keys must be exactly")
    const changed = structuredClone(identities)
    changed.chrome.storeId = "a".repeat(32)
    expect(() => validateStoreIdentities(changed, { production: false })).toThrow("does not match")
  })
})
