import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { DEFAULT_TAB_LIFECYCLE } from "../extension/src/background/tab-lifecycle"
import { VALID_COLORS } from "../extension/src/background/brand-tab-group"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

// chrome.storage.managed publishes nothing unless the manifest names a schema,
// and Chrome refuses to load an extension whose schema breaks its rules. These
// pin the schema to the fields the resolvers read and to the build that ships it.

const read = (rel: string) => Bun.file(new URL(`../${rel}`, import.meta.url))
type Schema = { type?: unknown; $ref?: unknown; properties?: Record<string, Schema>; items?: Schema; additionalProperties?: unknown; enum?: unknown[] }

describe("managed storage schema", () => {
  test("the manifest names a schema file that exists", async () => {
    const manifest = await read("extension/manifest.json").json()
    expect(manifest.storage).toEqual({ managed_schema: "managed-schema.json" })
    expect(await read("extension/managed-schema.json").exists()).toBe(true)
  })

  test("follows Chrome's schema rules", async () => {
    const schema = (await read("extension/managed-schema.json").json()) as Schema
    expect(schema.type).toBe("object")
    expect(schema.additionalProperties).toBeUndefined()
    const walk = (node: Schema): void => {
      expect(typeof node.type === "string" || typeof node.$ref === "string").toBe(true)
      for (const child of Object.values(node.properties ?? {})) walk(child)
      if (node.items) walk(node.items)
    }
    walk(schema)
  })

  test("declares exactly the keys and fields the resolvers read", async () => {
    const schema = (await read("extension/managed-schema.json").json()) as Schema
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["brandTabGroup", "tabLifecycle"])
    expect(Object.keys(schema.properties?.tabLifecycle?.properties ?? {}).sort()).toEqual(Object.keys(DEFAULT_TAB_LIFECYCLE).sort())
    expect(Object.keys(schema.properties?.brandTabGroup?.properties ?? {}).sort()).toEqual(["color", "title"])
    expect(schema.properties?.brandTabGroup?.properties?.color?.enum).toEqual([...VALID_COLORS])
  })

  test("the build ships the schema next to the manifest, and only the Chrome manifest names it", async () => {
    const build = await read("scripts/build.sh").text()
    expect(build).toContain("cp extension/managed-schema.json extension/dist/")
    const mv2 = await read("extension/dist-mv2/manifest.json").json()
    expect(mv2.storage).toBeUndefined()
  })
})

describe("popup under a managed policy", () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome
  afterEach(() => {
    if (originalChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = originalChrome
  })

  async function openPopup(managed: Record<string, unknown>, tag: string) {
    document.body.innerHTML = '<label for="contextId">Context ID</label><input id="contextId"><button id="save"></button><button id="reset"></button><div id="status"></div>'
    ;(globalThis as { chrome: unknown }).chrome = {
      tabGroups: {},
      runtime: { id: "x", getManifest: () => ({ version: "0" }), sendMessage: async () => ({ state: "connected", transport: "native" }) },
      storage: {
        managed: { get: async (key: string) => (key in managed ? { [key]: managed[key] } : {}) },
        local: {
          get: async (key: string) => (key === "tabLifecycle" ? { tabLifecycle: { reuse: true, idleCloseMinutes: 10, closeGroupWhenDone: false } } : {}),
          set: async () => {},
          remove: async () => {},
        },
      },
    }
    await import(`../extension/src/popup?${tag}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
    return {
      reuse: el<HTMLInputElement>("lcReuse"), idle: el<HTMLInputElement>("lcIdle"), purge: el<HTMLInputElement>("lcPurge"),
      save: el<HTMLButtonElement>("lcSave"), brandSave: el<HTMLButtonElement>("brandSave"),
      notes: document.querySelectorAll(".managedNote").length,
    }
  }

  test("shows the managed lifecycle values, locks those controls, and leaves the label editable", async () => {
    const p = await openPopup({ tabLifecycle: { reuse: false, idleCloseMinutes: 3, closeGroupWhenDone: true } }, "managed")
    expect([p.reuse.checked, p.idle.value, p.purge.checked]).toEqual([false, "3", true])
    expect([p.reuse.disabled, p.idle.disabled, p.purge.disabled, p.save.disabled]).toEqual([true, true, true, true])
    expect(p.brandSave.disabled).toBe(false)
    expect(p.notes).toBe(1)
  })

  test("with no policy the stored values load and nothing is locked", async () => {
    const p = await openPopup({}, "unmanaged")
    expect([p.reuse.checked, p.idle.value, p.purge.checked]).toEqual([true, "10", false])
    expect([p.reuse.disabled, p.save.disabled, p.brandSave.disabled]).toEqual([false, false, false])
    expect(p.notes).toBe(0)
  })
})
