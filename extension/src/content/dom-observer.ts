let domDirty = false
// When this document last changed (nodes, attributes or text), on the
// performance.now() clock. Starts at content-script load, so a page that has
// not changed since is quiet for as long as the script has been here.
// `dom_quiet` seeds its clock from this instead of "now", so it must see every
// kind of change its own observer sees.
let lastMutation = performance.now()

export function getDomDirty(): boolean { return domDirty }
export function setDomDirty(v: boolean) { domDirty = v }
export function getLastMutation(): number { return lastMutation }

const domObserver = new MutationObserver((records) => {
  lastMutation = performance.now()
  // Refs go stale only when nodes are added or removed.
  if (!domDirty && records.some(r => r.type === "childList")) domDirty = true
})

if (document.body) {
  domObserver.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
}

window.addEventListener("beforeunload", () => {
  domObserver.disconnect()
})
