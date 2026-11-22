let domDirty = false
// When this document last changed (nodes, attributes or text), on the
// performance.now() clock. Starts at content-script load, so a page that has
// not changed since is quiet for as long as the script has been here.
// `dom_quiet` seeds its clock from this instead of "now", so it must see every
// kind of change its own observer sees.
let lastMutation = performance.now()

export function getDomDirty(): boolean { attach(); return domDirty }
export function setDomDirty(v: boolean) { domDirty = v }
export function getLastMutation(): number { attach(); return lastMutation }

const domObserver = new MutationObserver((records) => {
  lastMutation = performance.now()
  // Refs go stale only when nodes are added or removed.
  if (!domDirty && records.some(r => r.type === "childList")) domDirty = true
})

// The body being watched. A page that swaps in a new body (or had none when
// this script loaded) is reattached on the next read of the clock, and the
// swap itself counts as a change.
let observedBody: HTMLElement | null = null
let loading = true
function attach(): void {
  const body = document.body
  if (!body || body === observedBody) return
  domObserver.disconnect()
  domObserver.observe(body, { childList: true, subtree: true, attributes: true, characterData: true })
  if (!loading) { lastMutation = performance.now(); domDirty = true }
  observedBody = body
}
attach()
loading = false

window.addEventListener("beforeunload", () => {
  domObserver.disconnect()
})
