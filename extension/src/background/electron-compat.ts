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

  async function listTabs(): Promise<Tab[]> {
    let found: Tab[]
    if (nativeQuery) {
      found = await call(nativeQuery, tabs, [{}])
    } else {
      // ponytail: Electron 18 has no tabs.query; tab ids are webContents ids
      // counted from 1, so probe 1..128. Raise the ceiling if an app churns windows.
      const probes = await Promise.all(Array.from({ length: 128 }, (_, i) =>
        call(nativeGet, tabs, [i + 1]).catch(() => null)))
      found = probes.filter(Boolean)
    }
    // The extension's own background page is a "tab" in Electron; hide it.
    // Electron has no tab groups but reports groupId 0; Chrome's "none" is -1.
    const pages = found
      .filter((t) => !String(t.url ?? "").startsWith(ownPages))
      .sort((a, b) => a.id - b.id)
      .map((t) => ({ ...t, groupId: -1 }))
    // No tab is ever active in Electron; the app's first window stands in.
    if (pages.length && !pages.some((t) => t.active)) pages[0].active = true
    return pages
  }

  const withCallback = <T>(p: Promise<T>, cb?: AnyFn): Promise<T> | void => {
    if (typeof cb !== "function") return p
    p.then((v) => cb(v), () => cb(undefined))
  }

  tabs.query = (info: { active?: boolean; groupId?: number } = {}, cb?: AnyFn) =>
    withCallback(listTabs().then((all) => all.filter((t) =>
      (info.active === undefined || t.active === info.active) &&
      (info.groupId === undefined || info.groupId === -1))), cb)

  tabs.get = (tabId: number, cb?: AnyFn) =>
    withCallback(listTabs().then((all) => {
      const tab = all.find((t) => t.id === tabId)
      if (!tab) throw new Error(`No tab with id: ${tabId}.`)
      return tab
    }), cb)

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
        const where = target.allFrames ? { allFrames: true }
          : target.frameIds?.length ? { frameId: target.frameIds[0] } : {}
        let results: unknown[] = []
        if (opts.files?.length) {
          for (const file of opts.files) results = await call(nativeExecute, tabs, [target.tabId, { ...where, file }])
        } else if (opts.func) {
          const code = `(${opts.func.toString()})(...${JSON.stringify(opts.args ?? [])})`
          results = await call(nativeExecute, tabs, [target.tabId, { ...where, code }])
        }
        return (results ?? []).map((result, i) => ({ frameId: i === 0 ? (target.frameIds?.[0] ?? 0) : i, result }))
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
