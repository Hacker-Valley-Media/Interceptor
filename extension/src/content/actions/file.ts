import { resolveElement } from "../input-simulation"
import { markDocumentEdited } from "../document-edits"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Widen the search so `upload <ref>` is forgiving of which sub-node of a
// dropzone the agent named: the element itself, its descendants,
// then up to a few ancestors' subtrees (react-dropzone renders the hidden
// <input type=file> as a child of the root, but the agent may point at the
// "Click to upload" text, an icon, or the "Record" button), and finally — only
// when it is unambiguous — the page's single file input.
export function findFileInput(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === "file") return el
  const inner = el.querySelector?.('input[type="file"]') as HTMLInputElement | null
  if (inner) return inner
  let anc: Element | null = el.parentElement
  let hops = 0
  while (anc && hops < 5) {
    if (anc instanceof HTMLInputElement && anc.type === "file") return anc
    const found = anc.querySelector?.('input[type="file"]') as HTMLInputElement | null
    if (found) return found
    anc = anc.parentElement
    hops++
  }
  const all = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[]
  if (all.length === 1) return all[0]
  return null
}

// ISOLATED-world synthetic drop. Carries dataTransfer.files (verified), but the
// events are isTrusted:false — fine for dropzones that don't gate on isTrusted.
function isolatedDrop(target: HTMLElement, file: File): void {
  const rect = target.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }
  for (const type of ["dragenter", "dragover", "drop"]) {
    const dt = new DataTransfer()
    dt.items.add(file)
    target.dispatchEvent(new DragEvent(type, { ...base, dataTransfer: dt }))
  }
}

// Escalate to the MAIN-world trusted-drop bridge in inject-net.js. Bytes cross
// the realm as a blob: URL (a string) — inject-net.js fetches it, builds the
// File in its own realm, and fires a trusted drop (isTrusted:true). Resolves
// true if the bridge acked, false if it never responded (bridge absent).
function bridgedDrop(target: HTMLElement, bytes: Uint8Array, name: string, type: string): Promise<boolean> {
  return new Promise(resolve => {
    const rect = target.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: type || "application/octet-stream" })
    const blobUrl = URL.createObjectURL(blob)
    const id = "fd_" + Math.random().toString(36).slice(2) + Date.now().toString(36)
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      target.removeEventListener("__interceptor_file_drop_ack", onAck as EventListener, true)
      clearTimeout(timer)
      try { URL.revokeObjectURL(blobUrl) } catch {}
      resolve(ok)
    }
    const onAck = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id?: string; ok?: boolean } | undefined
      if (!detail || detail.id !== id) return
      finish(detail.ok === true)
    }
    target.addEventListener("__interceptor_file_drop_ack", onAck as EventListener, true)
    const timer = setTimeout(() => finish(false), 3000)
    target.dispatchEvent(new CustomEvent("__interceptor_file_drop", {
      bubbles: true,
      detail: { id, blobUrl, name, type, x, y }
    }))
  })
}

// Bounded post-drop verification. A synthetic drop is
// fire-and-forget — the site may silently ignore it — so poll briefly for
// evidence the page accepted the file: any file input now carrying files, or
// the file name surfacing near the target where it wasn't before (preview chip
// / list item). Returns false on timeout rather than falsely claiming success.
function anyInputHasFiles(): boolean {
  for (const inp of Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[]) {
    if (inp.files && inp.files.length > 0) return true
  }
  return false
}

function nameVisibleIn(scope: Element, needle: string): boolean {
  return (scope.textContent || "").toLowerCase().includes(needle)
}

function verifyUploaded(target: HTMLElement, fileName: string, nameAlreadyPresent: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const started = Date.now()
    const needle = fileName.toLowerCase()
    const scope = (target.closest("form") as Element | null) || document.body
    const check = (): boolean => {
      if (anyInputHasFiles()) return true
      if (!nameAlreadyPresent && needle && nameVisibleIn(scope, needle)) return true
      return false
    }
    const tick = () => {
      if (check()) return resolve(true)
      if (Date.now() - started > 1500) return resolve(false)
      setTimeout(tick, 150)
    }
    tick()
  })
}

// Stage bytes for the MAIN-world showOpenFilePicker() shim in inject-net.js.
// The next window.showOpenFilePicker() call the page makes will
// resolve to this file instead of opening a native OS panel the browser surface
// can't drive.
function stageForPicker(bytes: Uint8Array, name: string, type: string): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: type || "application/octet-stream" })
  const blobUrl = URL.createObjectURL(blob)
  document.dispatchEvent(new CustomEvent("__interceptor_stage_file", {
    detail: { blobUrl, name, type }
  }))
}

// Chunk reassembly buffer, keyed by uploadId. Large files arrive
// as a sequence of file_upload_chunk actions — each kept under Chrome's 1 MiB
// native-messaging limit so every daemon<->extension transport carries it — then
// a final file_upload with {uploadId} assembles and attaches.
const chunkBuffers = new Map<string, { parts: (string | null)[]; total: number }>()

export function handleFileUploadChunk(action: Action): ActionResult {
  const uploadId = String(action.uploadId || "")
  const seq = Number(action.seq)
  const total = Number(action.total)
  const chunk = typeof action.chunk === "string" ? action.chunk : ""
  if (!uploadId || !Number.isInteger(seq) || !Number.isInteger(total) || total <= 0) {
    return { success: false, error: "file_upload_chunk: malformed chunk header" }
  }
  let buf = chunkBuffers.get(uploadId)
  if (!buf) {
    buf = { parts: new Array(total).fill(null), total }
    chunkBuffers.set(uploadId, buf)
  }
  if (seq < 0 || seq >= buf.total) {
    return { success: false, error: `file_upload_chunk: seq ${seq} out of range 0..${buf.total - 1}` }
  }
  buf.parts[seq] = chunk
  const received = buf.parts.reduce((n, p) => n + (p !== null ? 1 : 0), 0)
  return { success: true, data: { buffered: received, of: buf.total } }
}

/**
 * Attach a file to the page — no CDP.
 *  - `<input type=file>` target: set `input.files` from a DataTransfer + dispatch
 *    input/change (ISOLATED). Frameworks read `.files`, not `.isTrusted`.
 *  - dropzone target (or `dropzone:true`): MAIN-world trusted-drop bridge first
 *    (works on sites that gate isTrusted), ISOLATED synthetic drop fallback, then
 *    a bounded verification so success isn't reported blindly.
 *  - `picker:true`: stage the bytes for the showOpenFilePicker() shim.
 * Bytes arrive base64 in `dataBase64`, or reassembled from chunks via `uploadId`.
 */
export async function handleFileUpload(action: Action): Promise<ActionResult> {
  // Resolve the file bytes: single-shot (dataBase64) or assembled from chunks.
  let dataBase64: string
  if (typeof action.dataBase64 === "string") {
    dataBase64 = action.dataBase64
  } else if (typeof action.uploadId === "string") {
    const buf = chunkBuffers.get(action.uploadId)
    if (!buf) return { success: false, error: `file_upload: no buffered chunks for uploadId ${action.uploadId} — the tab may have reloaded mid-upload; retry` }
    if (buf.parts.some(p => p === null)) return { success: false, error: `file_upload: missing chunks for uploadId ${action.uploadId}` }
    dataBase64 = buf.parts.join("")
    chunkBuffers.delete(action.uploadId)
  } else {
    return { success: false, error: "file_upload: missing dataBase64" }
  }

  const el = resolveElement(action.index as number | undefined, action.ref as string | undefined)
  if (!el) {
    return { success: false, error: `stale element [${String(action.ref ?? action.index)}] — run interceptor state to refresh` }
  }

  const fileName = String(action.fileName || "file")
  const mimeType = String(action.mimeType || "application/octet-stream")

  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(dataBase64)
  } catch (e) {
    return { success: false, error: `file_upload: invalid base64 (${(e as Error).message})` }
  }
  const file = new File([bytes.buffer as ArrayBuffer], fileName, { type: mimeType })

  // Picker path (explicit): stage for the File System Access API shim.
  if (action.picker === true) {
    stageForPicker(bytes, fileName, mimeType)
    return {
      success: true,
      data: { method: "picker-staged", fileName, size: bytes.byteLength, verified: false,
        note: "file staged for the next window.showOpenFilePicker() — now click the element that opens the file picker" }
    }
  }

  const forceDropzone = action.dropzone === true
  const fileInput = forceDropzone ? null : findFileInput(el)

  // Input path (primary, isTrusted-independent): set input.files + input/change.
  if (fileInput) {
    if (fileInput.disabled) return { success: false, error: "file_upload: <input type=file> is disabled" }
    const dt = new DataTransfer()
    dt.items.add(file)
    fileInput.files = dt.files
    if (fileInput.files.length > 0) markDocumentEdited()
    fileInput.dispatchEvent(new Event("input", { bubbles: true }))
    fileInput.dispatchEvent(new Event("change", { bubbles: true }))
    const verified = fileInput.files.length > 0
    return {
      success: true,
      data: { method: "input", fileName, size: bytes.byteLength, verified, multiple: fileInput.multiple, accept: fileInput.accept || null }
    }
  }

  // Dropzone path: MAIN-world trusted bridge first, ISOLATED fallback, then verify.
  const target = el as HTMLElement
  const scope = (target.closest("form") as Element | null) || document.body
  const nameAlreadyPresent = nameVisibleIn(scope, fileName.toLowerCase())
  const bridged = await bridgedDrop(target, bytes, fileName, mimeType)
  if (!bridged) isolatedDrop(target, file)
  const method = bridged ? "dropzone-trusted" : "dropzone-isolated"
  const verified = await verifyUploaded(target, fileName, nameAlreadyPresent)
  if (verified) markDocumentEdited()
  return {
    success: true,
    data: { method, fileName, size: bytes.byteLength, verified,
      ...(verified ? {} : { hint: "the page showed no sign of accepting the drop — the target may not be the dropzone, or it opens a native file picker (retry with --picker)" }) }
  }
}
