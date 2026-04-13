import { resolveElement } from "../input-simulation"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleClipboardRead(_action: Action): Promise<ActionResult> {
  const text = await navigator.clipboard.readText()
  return { success: true, data: text }
}

export async function handleClipboardWrite(action: Action): Promise<ActionResult> {
  await navigator.clipboard.writeText(action.text as string)
  return { success: true }
}

export async function handleSelectionGet(_action: Action): Promise<ActionResult> {
  const sel = window.getSelection()
  return { success: true, data: sel?.toString() || "" }
}

export async function handleSelectionSet(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined) as HTMLInputElement | HTMLTextAreaElement | null
  if (!el) return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` }
  el.setSelectionRange(action.start as number, action.end as number)
  return { success: true }
}
