export type ContextSocket = {
  send: (data: string) => void
  __contextId?: string
  __native?: boolean
  /** Manifest version the extension registered with (issue #241). */
  __version?: string
}

export type ContextKind = "extension" | "runtime" | "cdp" | "ios"

export type ContextDescription = { contextId: string; kind: ContextKind; version?: string }

/**
 * `contexts` returns plain ids by default — the CLI's `contexts` verb and every
 * script that parses it depend on that shape. The verbose form adds the kind
 * and, for browser extensions, the manifest version they registered with, so
 * `interceptor diagnose` can show a stale extension snapshot next to the CLI
 * version (issue #241: a browser keeps the old extension loaded after a pkg
 * install until it is reloaded).
 */
export function describeContexts(
  ids: string[],
  lookup: (contextId: string) => ContextSocket | undefined,
  prefixes: { runtime: string; cdp: string; ios: string },
): ContextDescription[] {
  return ids.map((contextId) => {
    const kind: ContextKind = contextId.startsWith(prefixes.runtime) ? "runtime"
      : contextId.startsWith(prefixes.cdp) ? "cdp"
      : contextId.startsWith(prefixes.ios) ? "ios"
      : "extension"
    const version = lookup(contextId)?.__version
    return version ? { contextId, kind, version } : { contextId, kind }
  })
}

export type ContextConflictMessage = {
  type: "context_conflict"
  contextId: string
  error: string
}

export type ContextRegisteredMessage = {
  type: "context_registered"
  contextId: string
}

export type ContextClaimResult =
  | {
      status: "registered"
      contextId: string
      previousContextId?: string
      message: ContextRegisteredMessage
    }
  | {
      status: "conflict"
      contextId: string
      message: ContextConflictMessage
    }

export function contextConflictMessage(contextId: string): ContextConflictMessage {
  return {
    type: "context_conflict",
    contextId,
    error: `context '${contextId}' is already in use`,
  }
}

export function contextRegisteredMessage(contextId: string): ContextRegisteredMessage {
  return {
    type: "context_registered",
    contextId,
  }
}

export function claimContextId(
  contextMap: Map<string, ContextSocket>,
  ws: ContextSocket,
  contextId: string,
): ContextClaimResult {
  const existing = contextMap.get(contextId)
  if (existing && existing !== ws) {
    return {
      status: "conflict",
      contextId,
      message: contextConflictMessage(contextId),
    }
  }

  const previousContextId = ws.__contextId
  if (previousContextId && previousContextId !== contextId && contextMap.get(previousContextId) === ws) {
    contextMap.delete(previousContextId)
  }

  ws.__contextId = contextId
  contextMap.set(contextId, ws)

  return {
    status: "registered",
    contextId,
    previousContextId: previousContextId && previousContextId !== contextId ? previousContextId : undefined,
    message: contextRegisteredMessage(contextId),
  }
}
