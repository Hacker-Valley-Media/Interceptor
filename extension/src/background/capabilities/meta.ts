import { activeTransport, detectInstallType } from "../transport"
import { debuggerAttached, cdpAttachActDetach } from "../cdp"
import { resolveTabLifecycle } from "../tab-lifecycle"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

type UpdateCheck = { updateCheck: string; updateVersion?: string }

/** chrome.runtime.requestUpdateCheck, then wait briefly for onUpdateAvailable
 *  so the reload that follows installs the downloaded version. */
export async function requestStoreUpdate(waitMs = 8_000): Promise<UpdateCheck> {
  const runtime = chrome.runtime as unknown as {
    requestUpdateCheck?: () => Promise<{ status: string; version?: string }>
    onUpdateAvailable?: { addListener: (cb: (d: { version: string }) => void) => void; removeListener: (cb: (d: { version: string }) => void) => void }
  }
  if (typeof runtime.requestUpdateCheck !== "function") return { updateCheck: "unavailable" }
  let result: { status: string; version?: string }
  try {
    result = await runtime.requestUpdateCheck()
  } catch (err) {
    return { updateCheck: `error: ${(err as Error).message || String(err)}` }
  }
  const onUpdateAvailable = runtime.onUpdateAvailable
  if (result.status !== "update_available" || !onUpdateAvailable) {
    return { updateCheck: result.status, ...(result.version ? { updateVersion: result.version } : {}) }
  }
  const version = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => { onUpdateAvailable.removeListener(cb); resolve(result.version) }, waitMs)
    const cb = (d: { version: string }) => { clearTimeout(timer); onUpdateAvailable.removeListener(cb); resolve(d.version) }
    onUpdateAvailable.addListener(cb)
  })
  return { updateCheck: "update_available", ...(version ? { updateVersion: version } : {}) }
}

export async function handleMetaActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "status": {
      // tabLifecycle: the resolved policy + which tier supplied it,
      // so agents can observe the reuse/idle-close behavior instead of fighting it.
      let tabLifecycle: Record<string, unknown> | undefined
      try {
        const resolved = await resolveTabLifecycle()
        tabLifecycle = { ...resolved.policy, source: resolved.source }
      } catch {}
      return {
        success: true,
        data: {
          connected: true,
          version: chrome.runtime.getManifest().version,
          ...(tabLifecycle ? { tabLifecycle } : {})
        }
      }
    }

    case "reload_extension": {
      // An unpacked copy picks up new code from disk on reload. A store copy
      // only has what the Chrome Web Store published, so ask the store first
      // and give a downloaded update a moment to become installable.
      const installType = await detectInstallType()
      if (installType && installType !== "development") {
        const check = await requestStoreUpdate()
        setTimeout(() => chrome.runtime.reload(), 100)
        return { success: true, data: { installType, ...check, reloading: true } }
      }
      setTimeout(() => chrome.runtime.reload(), 100)
      return { success: true, data: "reloading in 100ms" }
    }

    case "context_set": {
      // Store the context name the popup would set, so a copy whose ID changed
      // (and whose storage therefore started over) gets its name back from the
      // CLI. The storage listener re-registers with the daemon on change.
      const name = typeof action.name === "string" ? action.name.trim() : ""
      if (!name) return { success: false, error: "context_set requires a nonempty name" }
      // Write after replying: the storage listener re-registers this socket
      // under the new name the moment the value lands, and a reply sent after
      // that arrives under a context the daemon no longer expects it from
      // (the CLI saw a 15 s timeout although the rename had worked).
      setTimeout(() => { void chrome.storage.local.set({ contextId: name }).catch((err) => console.error("context_set failed:", err)) }, 100)
      return { success: true, data: { contextId: name } }
    }

    case "capabilities": {
      const daemonConnected = activeTransport !== "none"
      const hasDebugger = chrome.runtime.getManifest().permissions?.includes("debugger") ?? false
      const hasUserScriptsPermission = chrome.runtime.getManifest().permissions?.includes("userScripts") ?? false
      const debuggerActive = debuggerAttached.size > 0
      let userScriptsApi = false
      let userScriptsEnabled = false
      let userScriptsError: string | undefined
      try {
        userScriptsApi = !!chrome.userScripts
        if (chrome.userScripts) {
          await chrome.userScripts.getScripts()
          userScriptsEnabled = true
        }
      } catch (err) {
        userScriptsError = (err as Error).message || String(err)
      }
      return {
        success: true,
        data: {
          layers: {
            os_input: daemonConnected,
            tabCapture: true,
            cdp_debugger: hasDebugger,
            debugger_active: debuggerActive
          },
          userScripts: {
            manifest_permission: hasUserScriptsPermission,
            api_present: userScriptsApi,
            enabled: userScriptsEnabled,
            ...(userScriptsError ? { error: userScriptsError } : {})
          },
          daemon: daemonConnected,
          infoBannerHeight: debuggerActive ? 35 : 0
        }
      }
    }

    case "cdp_tree": {
      const depth = (action.depth as number) || undefined
      const result = await cdpAttachActDetach<{ nodes: unknown[] }>(
        tabId, "Accessibility.getFullAXTree", depth ? { depth } : undefined
      )
      if (!result.success) return { success: false, error: result.error }
      const nodes = result.data?.nodes || []
      const formatted = nodes.map((n: any) => {
        const role = n.role?.value || ""
        const name = n.name?.value || ""
        const nodeId = n.nodeId || ""
        return `[${nodeId}] ${role} "${name}"`
      }).join("\n")
      return { success: true, data: formatted || "empty tree" }
    }

    case "brand_set_tab_group": {
      // No-tab storage write that drives the runtime tab-group identity. The background
      // brand-tab-group `onChanged` listener picks this up and live-retitles the group.
      const title = typeof action.title === "string" ? action.title.trim() : ""
      if (!title) return { success: false, error: "brand_set_tab_group requires a non-empty title" }
      const color = typeof action.color === "string" ? action.color : "cyan"
      await chrome.storage.local.set({ brandTabGroup: { title, color } })
      return { success: true, data: { brandTabGroup: { title, color } } }
    }
  }
  return { success: false, error: `unknown meta action: ${action.type}` }
}
