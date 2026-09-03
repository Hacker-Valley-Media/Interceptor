// Minimal stand-in for the browser extension's WebSocket leg, used by
// test/cli-exit-code.test.ts. Runs in its own Bun process so the test file's
// DOM shims never touch the socket. Registers as an extension context and
// answers each forwarded action with a canned result:
//   go_back / go_forward → Chrome's real rejection text (issue #237 repro)
//   navigate             → success
//   tab_create           → failure (drives the compound `open --json` path)
//   anything else        → the stale-snapshot "unknown action type" failure
const port = process.env.FAKE_EXT_WS_PORT
const contextId = process.env.FAKE_EXT_CONTEXT ?? "exit-code-test"
const version = process.env.FAKE_EXT_VERSION ?? "0.0.0-fake"
if (!port) throw new Error("FAKE_EXT_WS_PORT is required")

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "extension", contextId, version }))
}
ws.onmessage = (event) => {
  let msg: { id?: string; type?: string; action?: { type?: string } }
  try { msg = JSON.parse(String(event.data)) } catch { return }
  if (msg.type === "context_registered") { console.log("registered"); return }
  if (!msg.id || !msg.action) return
  const t = msg.action.type
  const result = t === "go_back" || t === "go_forward"
    ? { success: false, error: "Cannot find a next page in history." }
    : t === "navigate"
      ? { success: true }
    : t === "tab_list"
      ? { success: true, data: [{ id: 1, url: "https://example.com/", title: "Example Domain", active: true }] }
    : t === "get_a11y_tree"
      ? { success: true, data: "e1 link\ne2 button" }
      : t === "tab_create"
        ? { success: false, error: "fake: tab_create refused" }
        : { success: false, error: `unknown action type: ${t}` }
  ws.send(JSON.stringify({ id: msg.id, result }))
}
ws.onclose = () => process.exit(0)
setInterval(() => {}, 60_000)
