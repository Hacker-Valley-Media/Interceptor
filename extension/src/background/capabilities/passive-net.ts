import { sendNetDirect } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }
const PAGE_COMM_CONFIG_KEY = "interceptor_page_comm_capture"
const PAGE_COMM_SCRIPT_ID = "interceptor-page-comm-capture"

type PageCommConfig = {
  enabled: boolean
  patterns: string[]
  persistAcrossSessions: boolean
  updatedAt: number
}

async function savePageCommConfig(config: PageCommConfig): Promise<void> {
  await chrome.storage.local.set({ [PAGE_COMM_CONFIG_KEY]: config })
}

async function readPageCommConfig(): Promise<PageCommConfig> {
  const stored = await chrome.storage.local.get(PAGE_COMM_CONFIG_KEY)
  const config = stored[PAGE_COMM_CONFIG_KEY] as Partial<PageCommConfig> | undefined
  return {
    enabled: config?.enabled === true,
    patterns: Array.isArray(config?.patterns) && config.patterns.length > 0 ? config.patterns : ["<all_urls>"],
    persistAcrossSessions: config?.persistAcrossSessions === true,
    updatedAt: typeof config?.updatedAt === "number" ? config.updatedAt : 0
  }
}

async function registerPageCommScript(config: PageCommConfig): Promise<void> {
  try { await chrome.scripting.unregisterContentScripts({ ids: [PAGE_COMM_SCRIPT_ID] }) } catch {}
  if (!config.enabled) return
  await chrome.scripting.registerContentScripts([{
    id: PAGE_COMM_SCRIPT_ID,
    js: ["inject-net.js"],
    matches: config.patterns.length > 0 ? config.patterns : ["<all_urls>"],
    runAt: "document_start",
    world: "MAIN" as chrome.scripting.ExecutionWorld,
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: config.persistAcrossSessions
  }])
}

async function injectPageCommNow(tabId: number): Promise<{ success: boolean; error?: string }> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["inject-net.js"],
      world: "MAIN" as chrome.scripting.ExecutionWorld,
      injectImmediately: true
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export function restorePageCommCaptureConfig(): void {
  readPageCommConfig()
    .then((config) => config.enabled ? registerPageCommScript(config) : undefined)
    .catch((err) => console.warn("failed to restore page communication capture config:", (err as Error).message))
}

// A net_log reply travels extension→daemon→CLI; every hop caps its frame at
// 64 MiB (native messaging, daemon WS maxPayloadLength, CLI frame guard) and
// an over-cap reply dies SILENTLY as a generic transport timeout (issue #161).
// Budget the serialized UTF-8 bytes well under those caps: newest entries
// keep their bodies, older ones past the budget are blanked with an honest
// per-entry `truncated` marker (url/status/headers/meta stay intact, so counts
// and shapes are stable). `--since` remains the way to page full bodies.
export const NET_LOG_BODY_BUDGET_BYTES = 8 * 1024 * 1024
// The caps are byte caps; String.length counts UTF-16 code units, which
// undercounts multibyte bodies by up to 3x.
const utf8 = new TextEncoder()

export function budgetNetLogEntries(entries: unknown[], budgetBytes = NET_LOG_BODY_BUDGET_BYTES): unknown[] {
  const out = new Array<unknown>(entries.length)
  let used = 0
  let over = false
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Record<string, unknown>
    if (!over) {
      let size = 0
      try { size = utf8.encode(JSON.stringify(entry)).byteLength } catch { size = 0 }
      used += size
      if (used <= budgetBytes) { out[i] = entry; continue }
      over = true
    }
    out[i] = typeof entry.body === "string" && entry.body.length > 0
      ? { ...entry, body: "", truncated: true }
      : entry
  }
  return out
}

export async function handlePassiveNetActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "net_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_net_log",
        filter: action.filter as string | undefined,
        since: action.since as number | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get passive net log" }
      let entries = result.data || []
      const limit = (action.limit as number) || 100
      entries = budgetNetLogEntries(entries.slice(-limit))
      return { success: true, data: entries }
    }

    case "page_comm_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_page_comm_log",
        filter: action.filter as string | undefined,
        entryType: action.entryType as string | undefined,
        since: action.since as number | undefined,
        limit: action.limit as number | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get page communication log" }
      return { success: true, data: result.data || [] }
    }

    case "page_comm_clear": {
      const result = await sendNetDirect(tabId, { type: "clear_page_comm_log" }) as {
        success: boolean; error?: string
      }
      return result.success
        ? { success: true, data: "page communication log cleared" }
        : { success: false, error: result.error || "failed to clear page communication log" }
    }

    case "page_comm_enable": {
      const patterns = Array.isArray(action.patterns) && (action.patterns as unknown[]).length > 0
        ? (action.patterns as string[])
        : ["<all_urls>"]
      const config: PageCommConfig = {
        enabled: true,
        patterns,
        persistAcrossSessions: action.persistAcrossSessions === true,
        updatedAt: Date.now()
      }
      await savePageCommConfig(config)
      await registerPageCommScript(config)
      const injected = await injectPageCommNow(tabId)
      if (!injected.success) {
        return { success: false, error: injected.error || "failed to inject page communication capture script" }
      }
      if (action.reload === true) {
        await chrome.tabs.reload(tabId)
      }
      return {
        success: true,
        data: {
          enabled: true,
          tabId,
          patterns,
          reload: action.reload === true,
          mode: action.reload === true ? "from-start" : "attach-now",
          note: action.reload === true
            ? "capture is armed before reload; startup WebSockets are covered after navigation starts"
            : "attach-now captures future WebSocket, Beacon, and BroadcastChannel activity; existing WebSocket instances are not retroactively captured"
        }
      }
    }

    case "page_comm_disable": {
      const current = await readPageCommConfig()
      const config: PageCommConfig = {
        ...current,
        enabled: false,
        updatedAt: Date.now()
      }
      await savePageCommConfig(config)
      try { await chrome.scripting.unregisterContentScripts({ ids: [PAGE_COMM_SCRIPT_ID] }) } catch {}
      return { success: true, data: { enabled: false } }
    }

    case "page_comm_status": {
      return { success: true, data: await readPageCommConfig() }
    }

    case "net_clear": {
      const result = await sendNetDirect(tabId, { type: "clear_net_log" }) as {
        success: boolean; error?: string
      }
      return result.success
        ? { success: true, data: "passive net log cleared" }
        : { success: false, error: result.error }
    }

    case "net_headers": {
      const result = await sendNetDirect(tabId, {
        type: "get_captured_headers",
        filter: action.filter as string | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get captured headers" }
      return { success: true, data: result.data }
    }

    case "sse_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_log",
        filter: action.filter as string | undefined,
        limit: action.limit as number | undefined
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get SSE log" }
      return { success: true, data: result.data || [] }
    }
    case "sse_streams": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_streams"
      }) as { success: boolean; data?: unknown[]; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get SSE streams" }
      return { success: true, data: result.data || [] }
    }
    case "sse_chunk": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_chunk",
        filter: action.filter as string | undefined,
        since: action.since as number | undefined
      }) as { success: boolean; data?: unknown; error?: string }
      if (!result.success) return { success: false, error: result.error || "failed to get SSE chunk" }
      return { success: true, data: result.data }
    }

    case "set_net_overrides": {
      const result = await sendNetDirect(tabId, {
        type: "set_net_overrides",
        rules: action.rules as unknown[]
      }) as { success: boolean; error?: string }
      return result.success
        ? { success: true, data: { overrides: "set", ruleCount: Array.isArray(action.rules) ? (action.rules as unknown[]).length : 0 } }
        : { success: false, error: result.error || "failed to set net overrides" }
    }

    case "clear_net_overrides": {
      const result = await sendNetDirect(tabId, {
        type: "clear_net_overrides"
      }) as { success: boolean; error?: string }
      return result.success
        ? { success: true, data: "net overrides cleared" }
        : { success: false, error: result.error || "failed to clear net overrides" }
    }
  }
  return { success: false, error: `unknown passive-net action: ${action.type}` }
}
