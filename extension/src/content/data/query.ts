import { resolveElement } from "../input-simulation"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleQuery(action: Action): Promise<ActionResult> {
  const selector = action.selector as string
  const els = document.querySelectorAll(selector)
  return {
    success: true, data: {
      count: els.length,
      elements: Array.from(els).slice(0, 20).map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 80),
        id: el.id || undefined,
        classes: el.className || undefined
      }))
    }
  }
}

export async function handleQueryOne(action: Action): Promise<ActionResult> {
  const el = document.querySelector(action.selector as string)
  if (!el) return { success: false, error: `no element matching: ${action.selector}` }
  return {
    success: true, data: {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 200),
      html: el.outerHTML.slice(0, 500),
      id: el.id || undefined,
      rect: el.getBoundingClientRect()
    }
  }
}

export async function handleExists(action: Action): Promise<ActionResult> {
  const el = document.querySelector(action.selector as string)
  return { success: true, data: !!el }
}

export async function handleCount(action: Action): Promise<ActionResult> {
  const els = document.querySelectorAll(action.selector as string)
  return { success: true, data: els.length }
}

export async function handleTableData(action: Action): Promise<ActionResult> {
  const table = (action.index !== undefined
    ? resolveElement(action.index as number | undefined, action.ref as string | undefined)
    : document.querySelector(action.selector as string || "table")) as HTMLTableElement | null
  if (!table) return { success: false, error: "table not found" }
  const rows: string[][] = []
  table.querySelectorAll("tr").forEach(tr => {
    const cells: string[] = []
    tr.querySelectorAll("td, th").forEach(cell => cells.push((cell.textContent || "").trim()))
    rows.push(cells)
  })
  return { success: true, data: rows }
}

export async function handleAttrGet(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) || document.querySelector(action.selector as string)
  if (!el) return { success: false, error: "element not found" }
  const name = action.name as string
  return { success: true, data: el.getAttribute(name) }
}

export async function handleAttrSet(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) || document.querySelector(action.selector as string)
  if (!el) return { success: false, error: "element not found" }
  el.setAttribute(action.name as string, action.value as string)
  return { success: true }
}

export async function handleStyleGet(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) || document.querySelector(action.selector as string)
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
