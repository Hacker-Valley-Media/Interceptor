import { afterEach, describe, expect, test } from "bun:test"

// `interceptor reload` on a store copy asks the Chrome Web Store for
// an update before reloading; an unpacked copy reloads from disk as before.
// `contexts rename` writes the context name the popup would.

const hadOriginalChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome")
const originalChrome = (globalThis as { chrome?: unknown }).chrome

type Fake = {
  reloaded: number
  stored: Record<string, unknown>
  updateListeners: Array<(d: { version: string }) => void>
}

function installFakeChrome(opts: {
  installType?: string
  updateStatus?: string
  updateVersion?: string
  fireUpdateAvailable?: string
}): Fake {
  const fake: Fake = { reloaded: 0, stored: {}, updateListeners: [] }
  const addListener = () => {}
  const chrome: Record<string, any> = {
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    runtime: {
      id: "gomcpnagjjlhehnkoobkjgnkbleiooed",
      getManifest: () => ({ version: "0.25.0", permissions: [] }),
      onMessage: { addListener },
      reload: () => { fake.reloaded += 1 },
      requestUpdateCheck: async () => {
        const result = { status: opts.updateStatus ?? "no_update", ...(opts.updateVersion ? { version: opts.updateVersion } : {}) }
        if (opts.fireUpdateAvailable) {
          setTimeout(() => { for (const cb of [...fake.updateListeners]) cb({ version: opts.fireUpdateAvailable! }) }, 5)
        }
        return result
      },
      onUpdateAvailable: {
        addListener: (cb: (d: { version: string }) => void) => { fake.updateListeners.push(cb) },
        removeListener: (cb: (d: { version: string }) => void) => { fake.updateListeners = fake.updateListeners.filter(x => x !== cb) },
      },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async (obj: Record<string, unknown>) => { Object.assign(fake.stored, obj) },
      },
      onChanged: { addListener },
    },
    scripting: { unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
    tabs: { onActivated: { addListener }, onCreated: { addListener }, onRemoved: { addListener } },
    webNavigation: { getFrame: async () => undefined, onCommitted: { addListener }, onCompleted: { addListener } },
  }
  if (opts.installType) chrome.management = { getSelf: async () => ({ installType: opts.installType }) }
  ;(globalThis as { chrome: unknown }).chrome = chrome
  return fake
}

async function meta() {
  const { resetTransportForTesting } = await import("../extension/src/background/transport")
  resetTransportForTesting()
  return import("../extension/src/background/capabilities/meta")
}

afterEach(async () => {
  const { resetTransportForTesting } = await import("../extension/src/background/transport")
  resetTransportForTesting()
  if (hadOriginalChrome) (globalThis as { chrome?: unknown }).chrome = originalChrome
  else delete (globalThis as { chrome?: unknown }).chrome
})

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("reload_extension follows the copy", () => {
  test("unpacked copy: plain reload, unchanged result shape", async () => {
    const fake = installFakeChrome({ installType: "development" })
    const { handleMetaActions } = await meta()
    const result = await handleMetaActions({ type: "reload_extension" }, 0)
    expect(result).toEqual({ success: true, data: "reloading in 100ms" })
    await wait(150)
    expect(fake.reloaded).toBe(1)
  })

  test("host without chrome.management (unknown copy): plain reload", async () => {
    const fake = installFakeChrome({})
    const { handleMetaActions } = await meta()
    const result = await handleMetaActions({ type: "reload_extension" }, 0)
    expect(result.data).toBe("reloading in 100ms")
    await wait(150)
    expect(fake.reloaded).toBe(1)
  })

  test("store copy with an update: waits for onUpdateAvailable, reports the version, then reloads", async () => {
    const fake = installFakeChrome({ installType: "normal", updateStatus: "update_available", fireUpdateAvailable: "0.25.1" })
    const { handleMetaActions } = await meta()
    const result = await handleMetaActions({ type: "reload_extension" }, 0)
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ installType: "normal", updateCheck: "update_available", updateVersion: "0.25.1", reloading: true })
    expect(fake.updateListeners).toHaveLength(0)
    await wait(150)
    expect(fake.reloaded).toBe(1)
  })

  test("store copy with nothing new: reports no_update and still reloads", async () => {
    const fake = installFakeChrome({ installType: "normal", updateStatus: "no_update" })
    const { handleMetaActions } = await meta()
    const result = await handleMetaActions({ type: "reload_extension" }, 0)
    expect(result.data).toEqual({ installType: "normal", updateCheck: "no_update", reloading: true })
    await wait(150)
    expect(fake.reloaded).toBe(1)
  })

  test("context_set stores the name and rejects an empty one", async () => {
    const fake = installFakeChrome({ installType: "development" })
    const { handleMetaActions } = await meta()
    expect(await handleMetaActions({ type: "context_set", name: "  main " }, 0)).toEqual({ success: true, data: { contextId: "main" } })
    // The write is deferred past the reply so the re-registration cannot
    // outrun the response.
    expect(fake.stored.contextId).toBeUndefined()
    await wait(150)
    expect(fake.stored.contextId).toBe("main")
    expect((await handleMetaActions({ type: "context_set", name: "" }, 0)).success).toBe(false)
  })
})
