const input = document.getElementById("contextId") as HTMLInputElement
const saveBtn = document.getElementById("save") as HTMLButtonElement
const resetBtn = document.getElementById("reset") as HTMLButtonElement
const statusEl = document.getElementById("status") as HTMLDivElement

function showStatus(msg: string, ms = 1800) {
  statusEl.textContent = msg
  setTimeout(() => { statusEl.textContent = "" }, ms)
}

chrome.storage.local.get("contextId").then((stored) => {
  const contextId = (stored as { contextId?: unknown }).contextId
  if (typeof contextId === "string") input.value = contextId
})

saveBtn.addEventListener("click", async () => {
  const value = input.value.trim()
  if (!value) { showStatus("Context ID cannot be empty."); return }
  await chrome.storage.local.set({ contextId: value })
  showStatus("Saved.")
})

resetBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("contextId")
  input.value = ""
  showStatus("Reset — new ID assigned on next connect.")
})

// --- runtime tab-group label/color (white-label) ---
// This field is INJECTED dynamically and gated on `chrome.tabGroups`. It is NOT static
// `popup.html` markup, because `popup.js` is not copied to `dist-mv2/` — a static field would render
// as an ungated dead control in the shared MV2 Electron-bridge popup. Injecting from here means the
// field simply does not exist where `popup.js` does not run (MV2) or where tab groups are unavailable.
const hasTabGroups = !!(chrome as typeof chrome & { tabGroups?: unknown }).tabGroups
if (hasTabGroups) {
  const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]

  const wrap = document.createElement("div")
  wrap.style.marginTop = "14px"

  const brandLabel = document.createElement("label")
  brandLabel.textContent = "Tab group label"
  brandLabel.htmlFor = "brandTitle"
  wrap.appendChild(brandLabel)

  const titleInput = document.createElement("input")
  titleInput.id = "brandTitle"
  titleInput.type = "text"
  titleInput.placeholder = "e.g. interceptor"
  titleInput.spellcheck = false
  wrap.appendChild(titleInput)

  const colorSelect = document.createElement("select")
  colorSelect.id = "brandColor"
  colorSelect.style.cssText =
    "width:100%;margin-top:6px;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;"
  for (const c of COLORS) {
    const opt = document.createElement("option")
    opt.value = c
    opt.textContent = c
    colorSelect.appendChild(opt)
  }
  colorSelect.value = "cyan"
  wrap.appendChild(colorSelect)

  const brandRow = document.createElement("div")
  brandRow.className = "row"
  const brandSave = document.createElement("button")
  brandSave.id = "brandSave"
  brandSave.textContent = "Save label"
  brandSave.style.cssText = "background:#0071e3;color:#fff;"
  brandRow.appendChild(brandSave)
  wrap.appendChild(brandRow)

  statusEl.parentElement?.insertBefore(wrap, statusEl)

  void chrome.storage.local.get("brandTabGroup").then((stored) => {
    const b = (stored as { brandTabGroup?: { title?: unknown; color?: unknown } }).brandTabGroup
    if (b && typeof b.title === "string") titleInput.value = b.title
    if (b && typeof b.color === "string" && COLORS.includes(b.color)) colorSelect.value = b.color
  })

  brandSave.addEventListener("click", async () => {
    const title = titleInput.value.trim()
    if (!title) { showStatus("Tab group label cannot be empty."); return }
    await chrome.storage.local.set({ brandTabGroup: { title, color: colorSelect.value } })
    showStatus("Tab group label saved.")
  })

  // --- tab lifecycle policy ---
  // This popup is the ONLY writer for the `tabLifecycle` key. Same dynamic-injection
  // gating as the brand block above: no tabGroups API (MV2 Electron) → no controls.
  const DEFAULT_LIFECYCLE = { reuse: true, idleCloseMinutes: 10 }

  const lcWrap = document.createElement("div")
  lcWrap.style.marginTop = "14px"

  const lcLabel = document.createElement("label")
  lcLabel.textContent = "Tab lifecycle"
  lcWrap.appendChild(lcLabel)

  const reuseRow = document.createElement("label")
  reuseRow.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:6px;"
  const reuseCheck = document.createElement("input")
  reuseCheck.id = "lcReuse"
  reuseCheck.type = "checkbox"
  reuseCheck.style.cssText = "width:auto;"
  reuseCheck.checked = DEFAULT_LIFECYCLE.reuse
  reuseRow.appendChild(reuseCheck)
  reuseRow.appendChild(document.createTextNode("Reuse tabs (named groups)"))
  lcWrap.appendChild(reuseRow)

  const idleRow = document.createElement("label")
  idleRow.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:400;"
  idleRow.appendChild(document.createTextNode("Close idle groups after"))
  const idleInput = document.createElement("input")
  idleInput.id = "lcIdle"
  idleInput.type = "number"
  idleInput.min = "0"
  idleInput.step = "1"
  idleInput.style.cssText = "width:64px;"
  idleInput.value = String(DEFAULT_LIFECYCLE.idleCloseMinutes)
  idleRow.appendChild(idleInput)
  idleRow.appendChild(document.createTextNode("min (0 = never)"))
  lcWrap.appendChild(idleRow)

  const lcRow = document.createElement("div")
  lcRow.className = "row"
  const lcSave = document.createElement("button")
  lcSave.id = "lcSave"
  lcSave.textContent = "Save lifecycle"
  lcSave.style.cssText = "background:#0071e3;color:#fff;"
  lcRow.appendChild(lcSave)
  lcWrap.appendChild(lcRow)

  statusEl.parentElement?.insertBefore(lcWrap, statusEl)

  void chrome.storage.local.get("tabLifecycle").then((stored) => {
    const lc = (stored as { tabLifecycle?: { reuse?: unknown; idleCloseMinutes?: unknown } }).tabLifecycle
    if (lc && typeof lc.reuse === "boolean") reuseCheck.checked = lc.reuse
    if (lc && typeof lc.idleCloseMinutes === "number" && Number.isFinite(lc.idleCloseMinutes)) {
      idleInput.value = String(Math.max(0, Math.round(lc.idleCloseMinutes)))
    }
  })

  lcSave.addEventListener("click", async () => {
    const idle = Math.max(0, Math.round(Number(idleInput.value)))
    if (!Number.isFinite(idle)) { showStatus("Idle minutes must be a number."); return }
    await chrome.storage.local.set({ tabLifecycle: { reuse: reuseCheck.checked, idleCloseMinutes: idle } })
    showStatus("Tab lifecycle saved.")
  })
}
