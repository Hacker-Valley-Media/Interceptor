import { setDomDirty } from "./dom-observer"
import { getInteractiveElements } from "./element-discovery"
import { buildElementTree } from "./element-tree"
import { getOrAssignRef } from "./ref-registry"
import { getEffectiveRole, getAccessibleName } from "./a11y-tree"
import { cacheSnapshot } from "./snapshot-diff"

export function getPageState(full = false) {
  setDomDirty(false)
  const elements = getInteractiveElements()
  const tree = buildElementTree(elements)
  const scrollY = window.scrollY
  const scrollHeight = document.documentElement.scrollHeight
  const viewportHeight = window.innerHeight

  const active = document.activeElement as HTMLElement | null
  let focusedStr = "none"
  if (active && active !== document.body && active !== document.documentElement) {
    const fRef = getOrAssignRef(active)
    const fRole = getEffectiveRole(active)
    const fName = getAccessibleName(active)
    focusedStr = `${fRef} ${fRole || active.tagName.toLowerCase()} "${fName}"`
  }

  const state: Record<string, unknown> = {
    url: location.href,
    title: document.title,
    elementTree: tree,
    focused: focusedStr,
    scrollPosition: { y: scrollY, height: scrollHeight, viewportHeight },
    timestamp: Date.now()
  }

  if (full) {
    state.staticText = document.body.innerText.slice(0, 5000)
  }

  cacheSnapshot()
  return { success: true, data: state }
}
