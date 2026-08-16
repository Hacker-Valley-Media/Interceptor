/**
 * cli/format.ts — output formatting helpers
 */

// Replace CSP-blocked-eval errors with an actionable structured message and
// strip the leaked chrome-extension://<id> URL. Sites with strict CSPs that
// block unsafe-eval (LinkedIn, github.com, banking portals, most SaaS
// dashboards) hit this path routinely; the raw Chrome error is verbose and
// gives no guidance.
export function rewriteCspEvalError(raw: string | undefined): string | undefined {
  if (!raw) return raw
  const cspPatterns = [
    /content security policy.*(?:script-src|unsafe-eval|eval)/i,
    /(?:'unsafe-eval'|unsafe-eval).*not.*allowed.*source.*script/i,
    /refused to (?:create|evaluate).*string.*javascript/i,
    /(?:eval|evaluating a string).*(?:not.*allowed|content security)/i,
  ]
  if (!cspPatterns.some(re => re.test(raw))) return raw
  return [
    "page CSP blocks eval.",
    "Use 'interceptor html <ref>', 'interceptor read', 'interceptor text <ref>',",
    "or 'interceptor find \"<query>\"' for structured-tree access instead.",
  ].join("\n  ")
}

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

export function formatFind(data: {
  text?: { total: number; returned: number; truncated?: boolean; matches: Array<{ frameId?: number; start: number; matchedText: string; snippet: string }> }
  elements?: { total: number; returned: number; truncated?: boolean; matches: Array<{ frameId?: number; refId: string; role: string; name: string; score: number }> }
  frames?: Array<{ frameId: number; opaque?: true; error?: string }>
}): string {
  const lines: string[] = []
  if (data.text) {
    lines.push(`TEXT (${data.text.returned}/${data.text.total}${data.text.truncated ? ", truncated" : ""})`)
    for (const match of data.text.matches) {
      const frame = match.frameId !== undefined ? ` frame=${match.frameId}` : ""
      lines.push(`- [${match.start}]${frame} ${match.snippet}`)
    }
    if (data.text.returned === 0) lines.push("- no matches")
  }
  if (data.elements) {
    if (lines.length) lines.push("")
    lines.push(`ELEMENTS (${data.elements.returned}/${data.elements.total}${data.elements.truncated ? ", truncated" : ""})`)
    for (const match of data.elements.matches) {
      const frame = match.frameId !== undefined ? ` frame=${match.frameId}` : ""
      lines.push(`- [${match.refId}] ${match.role} \"${match.name}\" score=${match.score}${frame}`)
    }
    if (data.elements.returned === 0) lines.push("- no matches")
  }
  const opaque = data.frames?.filter(frame => frame.opaque) || []
  if (opaque.length) {
    if (lines.length) lines.push("")
    lines.push("UNREACHABLE FRAMES")
    for (const frame of opaque) lines.push(`- frame=${frame.frameId}: ${frame.error || "unreachable"}`)
  }
  return lines.join("\n") || "no matches"
}

export function formatResult(result: { success: boolean; error?: string; data?: unknown; warning?: string }, jsonMode: boolean): string {
  if (jsonMode) return JSON.stringify(result, null, 2)

  if (!result.success) {
    const cleaned = rewriteCspEvalError(result.error)
    return `error: ${cleaned}`
  }
  let body: string
  if (result.data === undefined || result.data === null) body = "ok"
  else if (typeof result.data === "string") body = result.data
  else if (typeof result.data === "number" || typeof result.data === "boolean") body = String(result.data)
  else body = JSON.stringify(result.data, null, 2)
  // Handlers put actionable hints (trusted-retry suggestions, side-effect
  // disclosures) in `warning`; dropping it in text mode hid them from every
  // non-JSON caller.
  return result.warning ? `${body}\nwarning: ${result.warning}` : body
}
