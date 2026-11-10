import { expect, test } from "bun:test"
import { createBrowserOsInputCache, needsBrowserOsInput } from "../daemon/browser-os-input-cache"
import { darwinOsInputWithTrust } from "../daemon/browser-os-input"
import { claimOsInputPlan } from "../daemon/os-input-plan"
import { darwinOsInputSupport } from "../shared/browser-os-input"

test("native capability requests share qualification and reuse the cache", async () => {
  let finish!: (support: ReturnType<typeof darwinOsInputSupport>) => void
  let calls = 0
  const cache = createBrowserOsInputCache(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  const waiting = cache.get()
  const shared = cache.get()
  await Promise.resolve()
  finish(darwinOsInputSupport(true, true))
  await waiting
  expect((await shared).click.available).toBe(true)
  expect((await cache.get()).click.available).toBe(true)
  expect(calls).toBe(1)
  cache.invalidate()
  const refreshed = cache.get()
  await Promise.resolve()
  finish(darwinOsInputSupport(false, false))
  expect((await refreshed).click.available).toBe(false)
  expect(calls).toBe(2)
})

for (const failure of ["timeout", "rejection"]) test(`${failure} refuses native qualification before input`, async () => {
  const cache = createBrowserOsInputCache(() => failure === "timeout" ? new Promise(() => {}) : Promise.reject(Error("provider down")), 5000, 10)
  const support = await cache.get()
  expect(support.click.available).toBe(false)
  expect(support.click.reason).toContain(failure === "timeout" ? "timed out" : "provider down")
})

test("invalidation during qualification cannot repopulate the new cache", async () => {
  let complete!: (support: ReturnType<typeof darwinOsInputSupport>) => void
  const cache = createBrowserOsInputCache(() => new Promise(resolve => { complete = resolve }))
  const old = cache.get()
  await Promise.resolve()
  cache.invalidate()
  complete(darwinOsInputSupport(true, true))
  await old
  const current = cache.get()
  await Promise.resolve()
  complete(darwinOsInputSupport(false, false))
  expect((await current).click.available).toBe(false)
})

for (const actionType of ["scene_click", "os_click", "os_type", "os_key"]) test(`explicit ${actionType} claims exactly one OS delivery even with duplicate extension replies`, () => {
  const pending = { actionType, osRequested: actionType === "scene_click" }
  const data = { method: "os_event", escalated: { to: "os_click" } }
  const delivered: string[] = []
  for (let n = 0; n < 2; n++) {
    const type = claimOsInputPlan(pending, data)
    if (type) delivered.push(type)
  }
  expect(delivered).toEqual([actionType === "scene_click" ? "os_click" : actionType])
  expect(claimOsInputPlan({ actionType: "click" }, { method: "synthetic" })).toBeUndefined()
})

for (const host of ["darwin", "win32", "linux"]) for (const type of ["click", "click_selector", "scene_click"]) test(`${host} implicit ${type} neither qualifies nor posts native input`, () => {
  expect(needsBrowserOsInput({ type })).toBe(false)
  const posted: string[] = []
  const result = claimOsInputPlan({ actionType: type }, { method: "os_event", escalated: { to: "os_click", from: "synthetic" } })
  if (result) posted.push(result)
  expect(posted).toEqual([])
})

test("a slow bridge keeps known foreground access before the cache deadline", async () => {
  const cache = createBrowserOsInputCache(() => darwinOsInputWithTrust(true, new Promise(() => {})))
  const support = await cache.get()
  expect(support.click).toMatchObject({ available: true, foreground: true, background: false })
  expect(needsBrowserOsInput({ type: "scene_click", os: true })).toBe(true)
})
