/**
 * Pure helper (no chrome API dependency): attempt port.postMessage, trap
 * synchronous throws.
 *
 * Chrome runtime docs (CHROME-RUNTIME-PORT) state Port.postMessage() throws
 * synchronously if the port is already disconnected. onDisconnect is async,
 * so there's a window where a port reference is truthy but calls on it throw.
 * This helper isolates that call + trap so sendToHost (and any future port
 * caller) never propagates the exception to its callers.
 */
export function safePortPost(
  port: { postMessage(msg: unknown): void; disconnect?: () => void } | null | undefined,
  msg: unknown
): { posted: boolean; error?: string } {
  if (!port) return { posted: false, error: "no port" }
  try {
    port.postMessage(msg)
    return { posted: true }
  } catch (err) {
    try { port.disconnect?.() } catch {}
    return { posted: false, error: (err as Error).message }
  }
}
