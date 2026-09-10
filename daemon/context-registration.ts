import { isExtensionInstallType, type ExtensionInstallType } from "../shared/extension-identity"

export type ContextSocket = {
  send: (data: string) => void
  __contextId?: string
  __native?: boolean
  /** Manifest version the extension registered with (issue #241). */
  __version?: string
  /** chrome.runtime.id; the store install and the unpacked copy share it since 0.25.0. */
  __extensionId?: string
  /** chrome.management.getSelf().installType: development = unpacked, normal = store. */
  __installType?: ExtensionInstallType
}

export type ContextKind = "extension" | "runtime" | "cdp" | "ios"

export type ContextDescription = {
  contextId: string
  kind: ContextKind
  version?: string
  extensionId?: string
  installType?: ExtensionInstallType
  /** True when the native-messaging relay Chrome spawned belongs to this extension ID. */
  native?: boolean
}

/** Copy the identity fields of an `extension` registration onto its socket.
 *  Every field is optional so a 0.24.x extension (version only) or an older one
 *  (context id only) registers exactly as before. */
export function recordExtensionIdentity(
  sock: ContextSocket,
  payload: { version?: unknown; extensionId?: unknown; installType?: unknown },
): void {
  sock.__version = typeof payload.version === "string" ? payload.version : undefined
  sock.__extensionId = typeof payload.extensionId === "string" && /^[a-p]{32}$/.test(payload.extensionId)
    ? payload.extensionId
    : undefined
  sock.__installType = isExtensionInstallType(payload.installType) ? payload.installType : undefined
}

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
  nativeExtensionId?: string,
): ContextDescription[] {
  return ids.map((contextId) => {
    const kind: ContextKind = contextId.startsWith(prefixes.runtime) ? "runtime"
      : contextId.startsWith(prefixes.cdp) ? "cdp"
      : contextId.startsWith(prefixes.ios) ? "ios"
      : "extension"
    const sock = lookup(contextId)
    const out: ContextDescription = { contextId, kind }
    if (sock?.__version) out.version = sock.__version
    if (kind === "extension") {
      if (sock?.__extensionId) out.extensionId = sock.__extensionId
      if (sock?.__installType) out.installType = sock.__installType
      if (nativeExtensionId && sock?.__extensionId === nativeExtensionId) out.native = true
    }
    return out
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
