let domDirty = false
// When this document last added or removed nodes, on the performance.now()
// clock. Starts at content-script load, so a page that has not changed since
// is quiet for as long as the script has been here. `dom_quiet` seeds its
// clock from this instead of "now".
let lastChildListMutation = performance.now()

export function getDomDirty(): boolean { return domDirty }
export function setDomDirty(v: boolean) { domDirty = v }
export function getLastChildListMutation(): number { return lastChildListMutation }

const domObserver = new MutationObserver(() => {
  domDirty = true
  lastChildListMutation = performance.now()
})

if (document.body) {
  domObserver.observe(document.body, { childList: true, subtree: true })
}

window.addEventListener("beforeunload", () => {
  domObserver.disconnect()
})
