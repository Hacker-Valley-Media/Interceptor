// Chrome's real wording (extensions/renderer): "The message port closed before
// a response was received." and "A listener indicated an asynchronous response
// by returning true, but the message channel closed before a response was
// received". The old check matched only "message channel is closed", a string
// Chrome never emits, so the reply-loss guard never fired for a real
// navigating click and the raw text reached agents 276 times (2026-09-10).
const REPLY_CHANNEL_CLOSED = /message (?:port|channel) (?:is )?closed/i

export function shouldRetryContentScript(error?: string): boolean {
  if (!error) return false
  return (
    error.includes("Receiving end does not exist") ||
    error.includes("Could not establish connection") ||
    error.includes("disconnected port") ||
    REPLY_CHANNEL_CLOSED.test(error) ||
    error.includes("no response from content script")
  )
}

// Input-like actions: re-executing one after a dead reply channel risks
// firing it twice — a click that navigates tears the channel down as a side
// effect of SUCCEEDING. Same-payload data writes (storage_write, attr_set,
// clipboard_write) are idempotent and stay on the retry path.
export const INPUT_ACTIONS = new Set([
  "click", "click_selector", "click_at", "dblclick", "rightclick", "drag",
  "input_text", "send_keys", "select_option", "check",
  "file_upload", "file_upload_chunk",
  "find_and_click", "find_and_type", "find_and_check",
  "scene_click", "scene_dblclick", "scene_select", "scene_insert",
])

// The message reached the page but the reply never made it back — the action
// may well have executed. Distinct from delivery failure ("Receiving end
// does not exist" / "Could not establish connection"), where no receiver
// existed and re-sending is safe for any action type.
export function isResponseLoss(error?: string): boolean {
  if (!error) return false
  return (
    REPLY_CHANNEL_CLOSED.test(error) ||
    error.includes("disconnected port") ||
    error.includes("no response from content script")
  )
}

