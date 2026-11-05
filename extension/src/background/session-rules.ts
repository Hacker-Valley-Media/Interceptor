// Session-scoped declarativeNetRequest rules (the CSP bypass, the screenshot
// CORS rule) target tabs by `condition.tabIds`. Session rules live until the
// browser quits, and an unpacked reload, even one that changes the version,
// keeps them (issue #317). So the extension removes closed tabs from them
// itself: when a tab closes, and at every service-worker start for anything a
// dropped event or an older version left behind.

type Rule = chrome.declarativeNetRequest.Rule

let queue: Promise<unknown> = Promise.resolve()

/** Run session-rule read-modify-write steps one at a time, so two of them never write from the same stale read. */
export function withSessionRules<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn)
  queue = run.catch(() => undefined)
  return run
}

/** Drop tab ids that fail `isOpen` from every rule that lists tabs; a rule left with none is removed. */
export function planSessionRulePrune(rules: Rule[], isOpen: (tabId: number) => boolean): { removeRuleIds: number[]; addRules: Rule[] } {
  const removeRuleIds: number[] = []
  const addRules: Rule[] = []
  for (const rule of rules) {
    const tabIds = rule.condition?.tabIds
    if (!tabIds?.length) continue
    // Negative ids (tabs.TAB_ID_NONE) are not tabs and never close.
    const keep = tabIds.filter(id => id < 0 || isOpen(id))
    if (keep.length === tabIds.length) continue
    removeRuleIds.push(rule.id)
    if (keep.length) addRules.push({ ...rule, condition: { ...rule.condition, tabIds: keep } })
  }
  return { removeRuleIds, addRules }
}

async function prune(isOpen: (tabId: number) => boolean): Promise<void> {
  const plan = planSessionRulePrune(await chrome.declarativeNetRequest.getSessionRules(), isOpen)
  if (plan.removeRuleIds.length) await chrome.declarativeNetRequest.updateSessionRules(plan)
}

export function pruneClosedTab(tabId: number): Promise<void> {
  return withSessionRules(() => prune(id => id !== tabId))
}

/** The open-tab read happens inside the queue, so a tab that gets a rule meanwhile is already open when it is checked. */
export function pruneSessionRulesForClosedTabs(): Promise<void> {
  return withSessionRules(async () => {
    const open = new Set((await chrome.tabs.query({})).map(tab => tab.id))
    await prune(id => open.has(id))
  })
}

/** Best effort in every runtime: Electron's shim throws for declarativeNetRequest, and none of this may break startup. */
export function registerSessionRuleCleanup(): void {
  try {
    chrome.tabs?.onRemoved?.addListener((tabId) => {
      void pruneClosedTab(tabId).catch(() => undefined)
    })
    void pruneSessionRulesForClosedTabs().catch(() => undefined)
  } catch {}
}
