import { describe, expect, test } from "bun:test"
import { extensionIdFromOrigin, installTypeLabel, isAllowedWsOrigin, isPreStoreVersion, isStoreManaged, STORE_EXTENSION_ID } from "../shared/extension-identity"

describe("shared/extension-identity", () => {
  test("store id comes from store-identities.json", () => {
    expect(STORE_EXTENSION_ID).toBe("gomcpnagjjlhehnkoobkjgnkbleiooed")
  })
  test("origin → id", () => {
    expect(extensionIdFromOrigin("chrome-extension://gomcpnagjjlhehnkoobkjgnkbleiooed/")).toBe("gomcpnagjjlhehnkoobkjgnkbleiooed")
    expect(extensionIdFromOrigin("chrome-extension://gomcpnagjjlhehnkoobkjgnkbleiooed")).toBe("gomcpnagjjlhehnkoobkjgnkbleiooed")
    expect(extensionIdFromOrigin("https://example.com/")).toBeUndefined()
    expect(extensionIdFromOrigin(undefined)).toBeUndefined()
  })
  test("labels and store-managed", () => {
    expect(installTypeLabel("development")).toBe("unpacked")
    expect(installTypeLabel("normal")).toBe("store")
    expect(installTypeLabel(undefined)).toBe("unknown copy")
    expect(isStoreManaged("normal")).toBe(true)
    expect(isStoreManaged("sideload")).toBe(true)
    expect(isStoreManaged("development")).toBe(false)
    expect(isStoreManaged(undefined)).toBe(false)
  })
  // Issue #274: a page's WebSocket handshake carries the page's origin.
  test("the daemon's WebSocket port serves the extension and local programs, not web pages", () => {
    for (const origin of [null, undefined, ""]) expect(isAllowedWsOrigin(origin)).toBe(true)
    expect(isAllowedWsOrigin("chrome-extension://gomcpnagjjlhehnkoobkjgnkbleiooed")).toBe(true)
    expect(isAllowedWsOrigin("moz-extension://0b1f3c4e-9f6a-4d1b-8a52-3c2d1e0f9a8b")).toBe(true)
    expect(isAllowedWsOrigin("safari-web-extension://A1B2C3D4-0000-1111-2222-333344445555")).toBe(true)
    for (const origin of ["https://evil.example", "http://localhost:3000", "http://127.0.0.1:8080", "file://", "null", "not a url", "chrome://newtab", "data:text/html,x"]) {
      expect(isAllowedWsOrigin(origin)).toBe(false)
    }
  })
  test("pre-store version detection", () => {
    expect(isPreStoreVersion("0.24.13")).toBe(true)
    expect(isPreStoreVersion("0.24.2")).toBe(true)
    expect(isPreStoreVersion("0.25.0")).toBe(false)
    expect(isPreStoreVersion("0.25.1")).toBe(false)
    expect(isPreStoreVersion("1.0.0")).toBe(false)
    expect(isPreStoreVersion("0.0.0-fake")).toBe(true)
    expect(isPreStoreVersion("dev")).toBe(false)
    expect(isPreStoreVersion(undefined)).toBe(false)
  })
})
