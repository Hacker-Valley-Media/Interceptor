export type OutboundTransport = "relay" | "ws" | "native" | "queue"
export type ContextRoutingValidation =
  | { ok: true }
  | { ok: false; error: string }

export function isControlMessage(msg: unknown): boolean {
  const candidate = msg as { type?: unknown }
  return candidate?.type === "ping" || candidate?.type === "pong"
}

export function chooseOutboundTransport(
  msg: unknown,
  state: {
    nativeRelayAvailable: boolean
    extensionWsAvailable: boolean
    stdinAlive: boolean
    standalone: boolean
  }
): OutboundTransport {
  if (isControlMessage(msg)) {
    if (state.nativeRelayAvailable) return "relay"
    if (!state.standalone && state.stdinAlive) return "native"
    return "queue"
  }

  if (state.extensionWsAvailable) return "ws"
  if (state.nativeRelayAvailable) return "relay"
  if (!state.standalone && state.stdinAlive) return "native"
  return "queue"
}

export function validateContextRouting(input: {
  contextId?: string
  connectedContexts: string[]
  nativeRelayAvailable: boolean
  /** CDP-app contexts. Verbs for these are routed before this check,
   *  but they participate in disambiguation messages so the operator is told to
   *  use --context when only a CDP context exists. */
  cdpContexts?: string[]
}): ContextRoutingValidation {
  const { contextId, connectedContexts, nativeRelayAvailable } = input
  const cdpContexts = input.cdpContexts ?? []

  if (contextId) {
    if (connectedContexts.includes(contextId)) return { ok: true }
    if (cdpContexts.includes(contextId)) return { ok: true }
    const all = [...connectedContexts, ...cdpContexts]
    const hint = all.length > 0
      ? ` (connected: ${all.join(", ")})`
      : " (no contexts connected)"
    return { ok: false, error: `context '${contextId}' not found${hint}` }
  }

  if (connectedContexts.length === 1) return { ok: true }
  if (connectedContexts.length === 0 && nativeRelayAvailable) return { ok: true }
  if (connectedContexts.length === 0) {
    if (cdpContexts.length > 0) {
      return { ok: false, error: `no extensions connected; a CDP app context exists — use --context ${cdpContexts.length === 1 ? cdpContexts[0] : "<id>"} (cdp: ${cdpContexts.join(", ")})` }
    }
    return { ok: false, error: "no extensions connected" }
  }

  return {
    ok: false,
    error: `multiple extensions connected, use --context <id> (connected: ${[...connectedContexts, ...cdpContexts].join(", ")})`,
  }
}
