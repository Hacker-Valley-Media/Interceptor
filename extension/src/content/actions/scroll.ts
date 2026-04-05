import { resolveElement } from "../input-simulation"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleScroll(action: Action): Promise<ActionResult> {
  const dir = action.direction as string
  const amount = (action.amount as number) || window.innerHeight * 0.8
  switch (dir) {
    case "up": window.scrollBy(0, -amount); break
    case "down": window.scrollBy(0, amount); break
    case "top": window.scrollTo(0, 0); break
    case "bottom": window.scrollTo(0, document.documentElement.scrollHeight); break
  }
  return { success: true }
}

export async function handleScrollAbsolute(action: Action): Promise<ActionResult> {
  window.scrollTo(0, action.y as number)
  return { success: true }
}

export async function handleScrollTo(action: Action): Promise<ActionResult> {
  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) return { success: false, error: `stale element [${action.index}] — run slop state to refresh` }
  el.scrollIntoView({ block: "center", behavior: "instant" })
  return { success: true }
}

export async function handleGetPageDimensions(_action: Action): Promise<ActionResult> {
  return {
    success: true,
    data: {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      devicePixelRatio: window.devicePixelRatio
    }
  }
}
