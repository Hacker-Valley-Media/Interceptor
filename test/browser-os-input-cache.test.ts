import { expect, test } from "bun:test"
import { createBrowserOsInputCache } from "../daemon/browser-os-input-cache"
import { claimOsInputPlan } from "../daemon/os-input-plan"
import { darwinOsInputSupport } from "../shared/browser-os-input"

test("synthetic click does not wait for qualification and a second click uses the cache", async () => {
  let finish!: (support: ReturnType<typeof darwinOsInputSupport>) => void
  let calls = 0
  const cache = createBrowserOsInputCache(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  expect(cache.peek().click.available).toBe(false)
  await Promise.resolve()
  const waiting = cache.get()
  finish(darwinOsInputSupport(true, true))
  await waiting
  expect(cache.peek().click.available).toBe(true)
  expect(calls).toBe(1)
  cache.invalidate()
  expect(cache.peek().click.available).toBe(false)
})

for (const failure of ["timeout", "rejection"]) test(`${failure} leaves synthetic input usable and refuses native qualification`, async () => {
  const cache = createBrowserOsInputCache(() => failure === "timeout" ? new Promise(() => {}) : Promise.reject(Error("provider down")), 5000, 10)
  const clicks: unknown[] = []
  clicks.push({ type: "click", osInput: cache.peek() })
  expect(clicks).toHaveLength(1)
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
  expect(cache.peek().click.available).toBe(false)
})

for (const actionType of ["click", "click_selector", "scene_click", "os_click"]) test(`${actionType} claims exactly one OS delivery even with duplicate extension replies`, () => {
  const pending = { actionType }
  const data = { method: "os_event", escalated: { to: "os_click" } }
  const delivered: string[] = []
  for (let n = 0; n < 2; n++) {
    const type = claimOsInputPlan(pending, data)
    if (type) delivered.push(type)
  }
  expect(delivered).toEqual(["os_click"])
  expect(claimOsInputPlan({ actionType: "click" }, { method: "synthetic" })).toBeUndefined()
})
