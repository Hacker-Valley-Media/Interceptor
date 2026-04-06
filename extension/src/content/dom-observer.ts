let domDirty = false

export function getDomDirty(): boolean { return domDirty }
export function setDomDirty(v: boolean) { domDirty = v }

const domObserver = new MutationObserver(() => {
  domDirty = true
})

if (document.body) {
  domObserver.observe(document.body, { childList: true, subtree: true })
}

window.addEventListener("beforeunload", () => {
  domObserver.disconnect()
})
