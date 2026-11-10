import { unavailableOsInput, type OsInputSupport } from "../shared/browser-os-input"

export function needsBrowserOsInput(action: Record<string, unknown>): boolean {
  return ["capabilities", "os_click", "os_key", "os_type", "os_move"].includes(String(action.type)) || action.type === "scene_click" && action.os === true
}

/** Capability reads and explicit native requests can wait up to one second. */
export function createBrowserOsInputCache(qualify: () => Promise<OsInputSupport>, ttlMs = 5000, timeoutMs = 1000) {
  let cached: OsInputSupport | undefined
  let expires = 0
  let pending: Promise<OsInputSupport> | undefined
  let generation = 0
  const refresh = () => {
    if (pending) return pending
    const current = generation
    pending = new Promise<OsInputSupport>(resolve => {
      let finished = false
      const finish = (value: OsInputSupport) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (current === generation) { cached = value; expires = Date.now() + ttlMs; pending = undefined }
        resolve(value)
      }
      const timer = setTimeout(() => finish(unavailableOsInput("OS input qualification timed out before delivery")), timeoutMs)
      Promise.resolve().then(qualify).then(finish, error => finish(unavailableOsInput(`OS input qualification failed before delivery: ${String(error)}`)))
    })
    return pending
  }
  return {
    get() { return cached && Date.now() < expires ? Promise.resolve(cached) : refresh() },
    invalidate() { generation++; cached = undefined; expires = 0; pending = undefined },
  }
}
