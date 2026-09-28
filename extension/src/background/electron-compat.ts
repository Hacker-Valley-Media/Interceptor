/**
 * Electron's extension host gives an MV2 background page a callback-only subset
 * of chrome.* (verified live on Electron 18.3 and 27.3): promise-style calls
 * throw "No matching signature", Electron 18 has no tabs.query, neither has
 * chrome.scripting or chrome.windows, and no tab is ever `active`. The shared
 * background code assumes MV3 Chrome, so this shims just enough of it.
 * Import it before anything else in background-electron.ts.
 */

type AnyFn = (...args: any[]) => any
type Tab = { id: number; url?: string; active?: boolean; groupId?: number; [k: string]: unknown }

export function installElectronCompat(c: any): void {
  const lastError = (): string | undefined => c.runtime?.lastError?.message

  const call = (fn: AnyFn, self: unknown, args: unknown[]): Promise<any> =>
    new Promise((resolve, reject) => {
      fn.apply(self, [...args, (value: unknown) => {
        const err = lastError()
        if (err) reject(new Error(err))
        else resolve(value)
      }])
    })

  // Promise form when the caller passes no callback; the callback form is untouched.
  const promisable = (ns: any, name: string): void => {
    const fn = ns?.[name]
    if (typeof fn !== "function") return
    ns[name] = function (...args: unknown[]) {
      if (typeof args[args.length - 1] === "function") return fn.apply(ns, args)
      return call(fn, ns, args)
    }
  }

  for (const name of ["get", "set", "remove", "clear"]) promisable(c.storage?.local, name)

  const pathA = (what: string) => new Error(
    `${what} is not available on Electron Path 0: the app's extension host runs isolated, synchronous MV2 content scripts only. ` +
    "Use Path A: interceptor macos cdp launch <app> --port <N> --confirm, then interceptor macos cdp connect <N> --app <app>")

  const tabs = c.tabs
  const nativeQuery: AnyFn | undefined = typeof tabs.query === "function" ? tabs.query : undefined
  const nativeGet: AnyFn = tabs.get
  const nativeExecute: AnyFn = tabs.executeScript
  const ownPages = c.runtime.getURL("")

  // Tab ids are webContents ids counted from 1. Electron 18 has no tabs.query,
  // so ids are probed in batches of 128 and the scan grows while its top batch
  // holds a live id. ponytail: a run of 128 dead ids ends the scan; tabs.get
  // takes any id directly, so an explicit --tab still reaches a tab past it.
  const BATCH = 128
  let ceiling = BATCH
  async function probeTabs(): Promise<Tab[]> {
    const found: Tab[] = []
    for (let from = 1; from <= ceiling; from += BATCH) {
      const hits = (await Promise.all(Array.from({ length: BATCH }, (_, i) =>
        call(nativeGet, tabs, [from + i]).catch(() => null)))).filter(Boolean)
      found.push(...hits)
      if (hits.length && from + BATCH > ceiling) ceiling += BATCH
    }
    return found
  }

  const isOwnPage = (t: Tab) => String(t.url ?? "").startsWith(ownPages)

  async function listTabs(): Promise<Tab[]> {
    const found: Tab[] = nativeQuery ? await call(nativeQuery, tabs, [{}]) : await probeTabs()
    // The extension's own background page is a "tab" in Electron; hide it.
    // Electron has no tab groups but reports groupId 0; Chrome's "none" is -1.
    const pages = found.filter((t) => !isOwnPage(t)).sort((a, b) => a.id - b.id).map((t) => ({ ...t, groupId: -1 }))
    // No tab is ever active in Electron; the app's first window stands in.
    if (pages.length && !pages.some((t) => t.active)) pages[0].active = true
    return pages
  }

  // The shared background code only uses the promise form of these two, and
  // only these filters; anything else fails instead of answering wrongly.
  const promiseOnly = (name: string, args: unknown[]) => {
    if (args.some((a) => typeof a === "function")) throw new TypeError(`tabs.${name}: the Electron compatibility layer takes no callback; await the result`)
  }
  const FILTERS = new Set(["active", "groupId", "currentWindow", "lastFocusedWindow", "windowId", "windowType"])

  tabs.query = async (info: Record<string, unknown> = {}, ...rest: unknown[]) => {
    promiseOnly("query", [info, ...rest])
    const unknown = Object.keys(info).filter((k) => !FILTERS.has(k))
    if (unknown.length) throw pathA(`tabs.query filter '${unknown.join("', '")}'`)
    return (await listTabs()).filter((t) =>
      (info.active === undefined || t.active === info.active) &&
      (info.groupId === undefined || info.groupId === -1))
  }

  tabs.get = async (tabId: number, ...rest: unknown[]) => {
    promiseOnly("get", rest)
    const tab: Tab = await call(nativeGet, tabs, [tabId])
    if (!tab || isOwnPage(tab)) throw new Error(`No tab with id: ${tabId}.`)
    const first = (await listTabs())[0]
    return { ...tab, groupId: -1, active: tab.active === true || first?.id === tab.id }
  }

  for (const name of ["sendMessage", "update", "reload", "executeScript", "insertCSS"]) promisable(tabs, name)

  // Passive capture needs the MAIN-world fetch/XHR wrapper, which an MV2 bundle
  // cannot install; answer for the net buffer instead of timing out on it.
  const NET_BUFFER = /^(get|clear|set)_(net|page_comm|captured_headers|sse)/
  const sendMessage: AnyFn = tabs.sendMessage
  tabs.sendMessage = (tabId: number, msg: { type?: string }, ...rest: unknown[]) => {
    if (!NET_BUFFER.test(String(msg?.type ?? ""))) return sendMessage(tabId, msg, ...rest)
    const reply = { success: false, error: pathA("Passive network capture (net, sse, override)").message }
    const cb = rest[rest.length - 1]
    return typeof cb === "function" ? cb(reply) : Promise.resolve(reply)
  }

  for (const name of ["create", "remove", "duplicate", "move", "group", "ungroup", "discard", "goBack", "goForward", "captureVisibleTab"]) {
    if (typeof tabs[name] !== "function") tabs[name] = async () => { throw pathA(`tabs.${name} (tab and window management)`) }
  }

  const noopEvent = { addListener() {}, removeListener() {}, hasListener: () => false }
  for (const name of ["onUpdated", "onRemoved", "onActivated", "onCreated", "onReplaced"]) {
    if (!tabs[name]) tabs[name] = noopEvent
  }

  if (!c.declarativeNetRequest) {
    const refuse = async () => { throw pathA("declarativeNetRequest (screenshot, eval CSP bypass)") }
    c.declarativeNetRequest = { updateSessionRules: refuse, getSessionRules: refuse }
  }

  if (!c.scripting && typeof nativeExecute === "function") {
    c.scripting = {
      async executeScript(opts: {
        target: { tabId: number; allFrames?: boolean; frameIds?: number[] }
        files?: string[]
        func?: AnyFn
        args?: unknown[]
        world?: string
      }) {
        if (opts.world === "MAIN" || opts.func?.constructor?.name === "AsyncFunction") {
          throw pathA("A MAIN-world or async script (eval, screenshot)")
        }
        const { target } = opts
        const what = opts.files?.length ? opts.files.map((file) => ({ file }))
          : opts.func ? [{ code: `(${opts.func.toString()})(...${JSON.stringify(opts.args ?? [])})` }] : []
        const run = async (where: object): Promise<unknown[]> => {
          let results: unknown[] = []
          for (const script of what) results = (await call(nativeExecute, tabs, [target.tabId, { ...where, ...script }])) ?? []
          return results
        }
        if (target.frameIds?.length) {
          const out: { frameId: number; result: unknown }[] = []
          for (const frameId of target.frameIds) out.push({ frameId, result: (await run({ frameId }))[0] })
          return out
        }
        // MV2 returns all-frame results top frame first and without ids: -1 marks an unknown frame.
        const results = await run(target.allFrames ? { allFrames: true } : {})
        return results.map((result, i) => ({ frameId: i === 0 ? 0 : -1, result }))
      },
    }
  }

  if (!c.windows) {
    const win = { id: 0, focused: true, type: "normal", state: "normal", incognito: false, alwaysOnTop: false }
    const one = async () => win
    c.windows = { getAll: async () => [win], get: one, getCurrent: one, getLastFocused: one, WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1 }
  }
}

if (typeof chrome !== "undefined") installElectronCompat(chrome)
