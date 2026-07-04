// Single source of truth for the extension's user-visible health state.
//
// Three independent transport signals (native port, WS channel, WS registration)
// reduce to one of four visible states, surfaced as a toolbar-action badge +
// tooltip. The default manifest icon is the orange reticle; the badge is the
// only thing that changes per-state, so no icon variants are needed for v1.
//
// State table:
//   native        | ws         | registered | visible
//   --------------+------------+------------+-------------
//   connected     | *          | *          | healthy
//   *             | connected  | yes        | healthy
//   connecting    | *          | *          | connecting
//   *             | connecting | *          | connecting
//   disconnected  | open       | no         | degraded
//   disconnected  | disconnected | *        | disconnected
//
// Either transport being up is enough for "healthy" (the daemon serves both).
// Both down is the failure mode that produced the "Native host has exited"
// console loop without any visible UI signal.

type TransportState = "connecting" | "connected" | "disconnected"

type ActionApi = {
  setBadgeText?: (details: { text: string }) => unknown
  setBadgeBackgroundColor?: (details: { color: string }) => unknown
  setTitle?: (details: { title: string }) => unknown
}

type ChromeLike = {
  action?: ActionApi
  browserAction?: ActionApi
}

type VisibleState = "healthy" | "connecting" | "degraded" | "disconnected" | "conflict"

type BadgeDescriptor = {
  text: string
  color: string
  title: string
}

const BADGE_BY_STATE: Record<VisibleState, BadgeDescriptor> = {
  healthy:      { text: "",    color: "#22c55e", title: "Interceptor — connected" },
  connecting:   { text: "…",   color: "#a16207", title: "Interceptor — connecting…" },
  degraded:     { text: "!",   color: "#f59e0b", title: "Interceptor — degraded (one transport down)" },
  disconnected: { text: "✕",   color: "#dc2626", title: "Interceptor — disconnected (native host + ws both down)" },
  conflict:     { text: "!",   color: "#e53e3e", title: "Interceptor — context name conflict; change the context ID in the popup" },
}

let nativeState: TransportState = "disconnected"
let wsState: TransportState = "disconnected"
let wsRegistered = false
let conflictLatched = false

function getActionApi(chromeApi: ChromeLike): ActionApi | null {
  return chromeApi.action ?? chromeApi.browserAction ?? null
}

function ignoreAsync(result: unknown): void {
  if (result && typeof (result as Promise<unknown>).catch === "function") {
    (result as Promise<unknown>).catch((err) => console.error("health-indicator: action update failed:", err))
  }
}

function computeVisible(): VisibleState {
  if (conflictLatched) return "conflict"
  const nativeUp = nativeState === "connected"
  const wsUp = wsState === "connected" && wsRegistered
  if (nativeUp || wsUp) return "healthy"
  if (nativeState === "connecting" || wsState === "connecting") return "connecting"
  if (wsState === "connected" && !wsRegistered) return "degraded"
  return "disconnected"
}

function paint(chromeApi: ChromeLike): void {
  const api = getActionApi(chromeApi)
  if (!api) return
  const desc = BADGE_BY_STATE[computeVisible()]
  if (api.setBadgeText) ignoreAsync(api.setBadgeText({ text: desc.text }))
  if (api.setBadgeBackgroundColor) ignoreAsync(api.setBadgeBackgroundColor({ color: desc.color }))
  if (api.setTitle) ignoreAsync(api.setTitle({ title: desc.title }))
}

export function reportNativeState(chromeApi: ChromeLike, state: TransportState): void {
  nativeState = state
  paint(chromeApi)
}

export function reportWsState(chromeApi: ChromeLike, state: TransportState): void {
  wsState = state
  if (state !== "connected") wsRegistered = false
  paint(chromeApi)
}

export function reportWsRegistered(chromeApi: ChromeLike, registered: boolean): void {
  wsRegistered = registered
  if (registered) conflictLatched = false
  paint(chromeApi)
}

export function reportContextConflict(chromeApi: ChromeLike): void {
  conflictLatched = true
  paint(chromeApi)
}

export function clearContextConflict(chromeApi: ChromeLike): void {
  conflictLatched = false
  paint(chromeApi)
}

// Test-only: reset module state between specs.
export function _resetForTests(): void {
  nativeState = "disconnected"
  wsState = "disconnected"
  wsRegistered = false
  conflictLatched = false
}

export function _currentVisibleState(): VisibleState {
  return computeVisible()
}
