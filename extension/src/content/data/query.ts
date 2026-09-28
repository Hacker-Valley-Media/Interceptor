import { isSensitive, safeHtml, safeText, SECURE_MASK } from "../sensitive"
import { resolveElement, resolveElementOrSelector } from "../input-simulation"
import { getOrAssignRef } from "../ref-registry"
import { queryAllDeep, queryOneDeep } from "../deep-query"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleQuery(action: Action): Promise<ActionResult> {
  const selector = action.selector as string
  const els = queryAllDeep(selector)
  const elements = els.slice(0, 20).map((el, i) => ({
    index: i,
    ref: getOrAssignRef(el),
    tag: el.tagName.toLowerCase(),
    text: safeText(el).trim().slice(0, 80),
    id: el.id || undefined,
    classes: el.className || undefined
  }))
  return {
    success: true, data: {
      count: els.length,
      returned: elements.length,
      truncated: elements.length < els.length,
      // ref bridges DOM discovery to the ref-side verbs: an element found by
      // selector is directly actionable (click e<N>, type e<N>, …) even on
      // pages whose a11y tree comes back empty and never minted refs.
      elements
    }
  }
}

export async function handleQueryOne(action: Action): Promise<ActionResult> {
  const el = queryOneDeep(action.selector as string)
  if (!el) return { success: false, error: `no element matching: ${action.selector}` }
  return {
    success: true, data: {
      tag: el.tagName.toLowerCase(),
      text: safeText(el).trim().slice(0, 200),
      html: safeHtml(el).slice(0, 500),
      id: el.id || undefined,
      rect: el.getBoundingClientRect()
    }
  }
}

export async function handleExists(action: Action): Promise<ActionResult> {
  const el = queryOneDeep(action.selector as string)
  return { success: true, data: !!el }
}

export async function handleCount(action: Action): Promise<ActionResult> {
  const els = queryAllDeep(action.selector as string)
  return { success: true, data: els.length }
}

export async function handleTableData(action: Action): Promise<ActionResult> {
  const table = (action.index !== undefined
    ? resolveElement(action.index as number | undefined, action.ref as string | undefined)
    : queryOneDeep(String(action.selector || "table"))) as HTMLTableElement | null
  if (!table) return { success: false, error: "table not found" }
  const rows: string[][] = []
  table.querySelectorAll("tr").forEach(tr => {
    const cells: string[] = []
    tr.querySelectorAll("td, th").forEach(cell => cells.push(safeText(cell).trim()))
    rows.push(cells)
  })
  return { success: true, data: rows }
}

export async function handleAttrGet(action: Action): Promise<ActionResult> {
  const el = resolveElementOrSelector(action)
  if (!el) return { success: false, error: "element not found" }
  const name = action.name as string
  const value = el.getAttribute(name)
  return { success: true, data: name.toLowerCase() === "value" && value && isSensitive(el) ? SECURE_MASK : value }
}

export async function handleAttrSet(action: Action): Promise<ActionResult> {
  const el = resolveElementOrSelector(action)
  if (!el) return { success: false, error: "element not found" }
  el.setAttribute(action.name as string, action.value as string)
  return { success: true }
}

export async function handleStyleGet(action: Action): Promise<ActionResult> {
  const el = resolveElementOrSelector(action)
  if (!el) return { success: false, error: "element not found" }
  const computed = getComputedStyle(el)
  if (action.property) {
    return { success: true, data: computed.getPropertyValue(action.property as string) }
  }
  const props = ["display", "visibility", "color", "backgroundColor", "fontSize", "position", "width", "height", "margin", "padding"]
  const styles: Record<string, string> = {}
  for (const p of props) styles[p] = computed.getPropertyValue(p)
  return { success: true, data: styles }
}
