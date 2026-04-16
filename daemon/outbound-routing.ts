export type OutboundTransport = "relay" | "ws" | "native" | "queue"

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
