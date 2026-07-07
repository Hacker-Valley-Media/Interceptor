// csp.ts
//
// Browser-global toggle that disables (or restores) Content-Security-Policy so
// injected page-origin JS — string eval, an appended inline <script>, an
// XSS/PoC payload — runs even on strict-CSP sites.
//
// Scope: ALL tabs, current AND future. It installs ONE declarativeNetRequest
// session rule with no `tabIds` condition, so every main_frame / sub_frame
// response in every tab — including tabs opened later — has its
// `content-security-policy` (+ `-report-only`) response headers removed. New
// tabs and future navigations are covered automatically with no per-tab setup.
//
// Lifetime: session only. A session rule survives service-worker restarts but is
// cleared when the browser closes — so a global "CSP off" never silently
// persists across restarts.
//
// Reload: a modifyHeaders DNR rule only rewrites FUTURE responses, so an
// already-parsed document keeps its CSP until reloaded. csp_strip / csp_restore
// therefore reload every open web tab by default so the change is live now;
// pass `reload: false` (CLI --no-reload) to skip the reloads, in which case each
// open tab applies the change on its next navigation.
//
// Rule id: a single fixed id (900000), deliberately BELOW the per-tab bases used
// by the reactive eval strip (evaluate.ts, 910000 + tabId) and the screenshot
// CORS rule (screenshot-cors.ts, 920000 + tabId), so it can never collide with
// either for any tab id.

const CSP_GLOBAL_RULE_ID = 900_000

type ActionResult = { success: boolean; error?: string; data?: unknown }

function buildGlobalCspRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: CSP_GLOBAL_RULE_ID,
    priority: 10,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" }
      ]
    },
    condition: {
      // No tabIds → applies to every tab, current and future. No URL condition →
      // matches all URLs; resourceTypes limits it to the documents that actually
      // carry a page CSP.
      resourceTypes: ["main_frame", "sub_frame"]
    }
  }
}

async function isCspStripped(): Promise<boolean> {
  const rules = await chrome.declarativeNetRequest.getSessionRules()
  return rules.some((r) => r.id === CSP_GLOBAL_RULE_ID)
}

// Reload every open http/https tab so a header change is live on already-loaded
// documents. A tab mid-navigation exposes its target via `pendingUrl` (its
// `url` is still ""), so match either. Returns how many tabs actually reloaded:
// per-tab failures (a tab closing mid-flight, a discarded tab) are counted as
// misses, not successes, and never fail the toggle — the DNR change already
// succeeded.
async function reloadAllWebTabs(): Promise<number> {
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return 0
  }
  const targets = tabs.filter(
    (t) => typeof t.id === "number" && /^https?:/i.test(t.url || t.pendingUrl || "")
  )
  const results = await Promise.all(
    targets.map((t) =>
      chrome.tabs.reload(t.id as number, { bypassCache: true }).then(() => true, () => false)
    )
  )
  return results.filter(Boolean).length
}

export async function handleCspActions(
  action: { type: string; [key: string]: unknown }
): Promise<ActionResult> {
  switch (action.type) {
    case "csp_strip": {
      // reload defaults to true; only an explicit `reload === false` skips it.
      const reload = action.reload !== false
      let alreadyStripped: boolean
      try {
        alreadyStripped = await isCspStripped()
      } catch (err) {
        return { success: false, error: `failed to read CSP bypass state: ${(err as Error).message}` }
      }
      // Already active → no-op. Do NOT reinstall or reload: a reload storm across
      // every open tab for an already-live rule would needlessly discard page
      // state (mirrors the csp_restore no-op guard below).
      if (alreadyStripped) {
        return { success: true, data: { scope: "all-tabs", cspStripped: true, tabsReloaded: 0 } }
      }
      try {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [CSP_GLOBAL_RULE_ID],
          addRules: [buildGlobalCspRule()]
        })
      } catch (err) {
        return { success: false, error: `failed to install CSP bypass rule: ${(err as Error).message}` }
      }
      // Install the rule BEFORE reloading so the reloads fetch CSP-free responses.
      const tabsReloaded = reload ? await reloadAllWebTabs() : 0
      return { success: true, data: { scope: "all-tabs", cspStripped: true, tabsReloaded } }
    }

    case "csp_restore": {
      const reload = action.reload !== false
      let stripped: boolean
      try {
        stripped = await isCspStripped()
      } catch (err) {
        return { success: false, error: `failed to read CSP bypass state: ${(err as Error).message}` }
      }
      // Nothing installed → nothing to restore, and no reload (a reload storm
      // across every open tab for a no-op would needlessly discard page state).
      if (!stripped) {
        return { success: true, data: { scope: "all-tabs", cspStripped: false, tabsReloaded: 0 } }
      }
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [CSP_GLOBAL_RULE_ID] })
      } catch (err) {
        return { success: false, error: `failed to remove CSP bypass rule: ${(err as Error).message}` }
      }
      const tabsReloaded = reload ? await reloadAllWebTabs() : 0
      return { success: true, data: { scope: "all-tabs", cspStripped: false, tabsReloaded } }
    }

    case "csp_status": {
      try {
        const stripped = await isCspStripped()
        return { success: true, data: { scope: "all-tabs", cspStripped: stripped } }
      } catch (err) {
        return { success: false, error: `failed to read CSP bypass state: ${(err as Error).message}` }
      }
    }
  }

  return { success: false, error: `unknown csp action: ${action.type}` }
}
