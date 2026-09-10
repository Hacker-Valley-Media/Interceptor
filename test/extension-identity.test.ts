import { describe, expect, test } from "bun:test"
import { extensionIdFromOrigin, installTypeLabel, isPreStoreVersion, isStoreManaged, STORE_EXTENSION_ID } from "../shared/extension-identity"

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
