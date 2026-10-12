// Small helpers shared by the case files.
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"
import type { Ctx, Res } from "../types"

/** The fixture's last written state (input text, clicks, menu, checkbox, combo, scroll, drag, keys). */
export function state(ctx: Ctx): Record<string, any> {
  const path = join(ctx.dir, "state.json")
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) } catch { return {} }
}

/** Waits up to `ms` for the fixture state to satisfy `test`; returns a failure message or nothing. */
export async function waitState(ctx: Ctx, test: (s: Record<string, any>) => boolean, what: string, ms = 3000): Promise<string | void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (test(state(ctx))) return; await ctx.sleep(150) }
  return `fixture state never showed ${what}: ${JSON.stringify(state(ctx)).slice(0, 300)}`
}

export const pid = (ctx: Ctx) => String(ctx.fixture.pid)

/** Native window id of the fixture's main window. */
export async function windowId(ctx: Ctx): Promise<string> {
  if (ctx.vars.windowId) return ctx.vars.windowId
  const r = await ctx.run(["windows", "--pid", pid(ctx)])
  const list: any[] = Array.isArray(r.json) ? r.json : r.json?.windows ?? []
  const w = list.find(x => String(x.title ?? "").includes(ctx.fixture.title) && !String(x.title).includes("Observer"))
  const id = w?.windowId ?? w?.id ?? w?.window
  if (id === undefined) throw new Error(`fixture window id not found: ${r.stdout.slice(0, 200)}`)
  return (ctx.vars.windowId = String(id))
}

/** JSON text of a result, for loose "contains" checks. */
export const text = (r: Res) => JSON.stringify(r.json ?? r.stdout)
export const contains = (needle: string) => (r: Res) => text(r).includes(needle) ? undefined : `result lacks ${JSON.stringify(needle)}: ${text(r).slice(0, 200)}`
export const lacks = (needle: string) => (r: Res) => text(r).includes(needle) ? `result exposes ${JSON.stringify(needle)}` : undefined
export const list = (r: Res): any[] => Array.isArray(r.json) ? r.json : (r.json && typeof r.json === "object" ? (Object.values(r.json).find(Array.isArray) as any[] ?? []) : [])
export const nonEmpty = (r: Res) => list(r).length || (r.json && Object.keys(r.json).length) ? undefined : "empty result"

/** Windows that hold the foreground and block the activate verbs: the share picker (OpenWith/olk) and the Settings
 *  privacy page that `location request` opens (SystemSettings, a UWP app in ApplicationFrameHost that ignores a window
 *  close, so it is ended by image name). Console windows are never touched: the runner itself lives in one, and the
 *  host-side install tasks now start their PowerShell hidden. */
export async function closeLeftovers(ctx: Ctx) {
  if (ctx.host !== "win32") return
  for (const app of ["OpenWith", "olk"]) { try { await ctx.run(["app", "quit", "--app", app]) } catch {} }
  Bun.spawnSync(["taskkill", "/IM", "SystemSettings.exe", "/F"], { stdout: "ignore", stderr: "ignore", timeout: 15_000 })
  await ctx.sleep(400)
}
