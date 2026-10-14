export type OutboundTransport = "relay" | "ws" | "native" | "queue"
export type ContextRoutingValidation =
  | { ok: true }
  | { ok: false; error: string; code: "target_gone" | "target_ambiguous" }

export function isControlMessage(msg: unknown): boolean {
  const candidate = msg as { type?: unknown }
  return candidate?.type === "ping" || candidate?.type === "pong"
}

/** Keepalive ping arriving over a registered native relay socket. Answered
 *  directly on the originating socket so liveness never depends on the
 *  relay-slot routing state. */
export function isRelayPing(msg: unknown): boolean {
  return (msg as { type?: unknown } | null)?.type === "ping"
}

/** Identity-checked relay-slot release: only the CURRENT relay's close frees
 *  the slot. A superseded relay's lingering process closing later must not
 *  unregister the live relay — that clobber turned any transient reconnect
 *  into a permanent pong-timeout loop. */
export function relaySlotAfterClose<S>(current: S | null, closing: S): { slot: S | null; released: boolean } {
  if (current === closing) return { slot: null, released: true }
  return { slot: current, released: false }
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
  /** iOS device contexts (ios:<udid>). Like cdpContexts, verbs for these are
   *  routed before this check; they participate in disambiguation so the operator
   *  is told to use --context when only an iOS context exists. */
  iosContexts?: string[]
}): ContextRoutingValidation {
  const { contextId, connectedContexts, nativeRelayAvailable } = input
  const cdpContexts = input.cdpContexts ?? []
  const iosContexts = input.iosContexts ?? []
  const auxContexts = [...cdpContexts, ...iosContexts]

  if (contextId) {
    if (connectedContexts.includes(contextId)) return { ok: true }
    if (auxContexts.includes(contextId)) return { ok: true }
    const all = [...connectedContexts, ...auxContexts]
    const hint = all.length > 0
      ? ` (connected: ${all.join(", ")})`
      : " (no contexts connected)"
    return { ok: false, code: "target_gone", error: `context '${contextId}' not found${hint}` }
  }

  if (connectedContexts.length === 1) return { ok: true }
  if (connectedContexts.length === 0 && nativeRelayAvailable) return { ok: true }
  if (connectedContexts.length === 0) {
    if (auxContexts.length > 0) {
      const label = cdpContexts.length && iosContexts.length ? "CDP/iOS"
        : iosContexts.length ? "iOS device" : "CDP app"
      return { ok: false, code: "target_ambiguous", error: `no extensions connected; a ${label} context exists — use --context ${auxContexts.length === 1 ? auxContexts[0] : "<id>"} (${auxContexts.join(", ")})` }
    }
    return { ok: false, code: "target_gone", error: "no extensions connected" }
  }

  return {
    ok: false,
    code: "target_ambiguous",
    error: `multiple extensions connected, use --context <id> (connected: ${[...connectedContexts, ...auxContexts].join(", ")})`,
  }
}
