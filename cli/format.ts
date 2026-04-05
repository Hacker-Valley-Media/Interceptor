/**
 * cli/format.ts — output formatting helpers
 */

export function formatState(data: {
  url: string
  title: string
  elementTree: string
  focused?: string
  staticText?: string
  scrollPosition: { y: number; height: number; viewportHeight: number }
  tabId: number
}) {
  const scroll = data.scrollPosition
  let out = `url: ${data.url}\ntitle: ${data.title}\nscroll: ${scroll.y}/${scroll.height} (vh:${scroll.viewportHeight})\ntab: ${data.tabId}\nfocused: ${data.focused || "none"}\n\n${data.elementTree}`
  if (data.staticText) {
    out += `\n---\n${data.staticText}`
  }
  return out
}

export function formatTabs(tabs: { id: number; url: string; title: string; active: boolean }[]) {
  return tabs.map(t => `${t.active ? "*" : " "} ${t.id}  ${t.url}  ${t.title}`).join("\n")
}

export function formatCookies(cookies: { name: string; value: string; domain: string; path: string }[]) {
  return cookies.map(c => `${c.domain}${c.path}  ${c.name}=${c.value}`).join("\n")
}

export function formatResult(result: { success: boolean; error?: string; data?: unknown }, jsonMode: boolean): string {
  if (jsonMode) return JSON.stringify(result, null, 2)

  if (!result.success) return `error: ${result.error}`
  if (result.data === undefined || result.data === null) return "ok"
  if (typeof result.data === "string") return result.data
  if (typeof result.data === "number" || typeof result.data === "boolean") return String(result.data)
  return JSON.stringify(result.data, null, 2)
}
