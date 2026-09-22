/**
 * daemon/ios/webinspector-transport.ts — Web Inspector Relay (WIR) transport.
 *
 * WIR is the OUTER protocol carried over the device's Web Inspector service
 * socket (classic `com.apple.webinspector` or the RSD `…shim.remote`). Its wire
 * shape (verified against the inspect-webkit implementation and the Appium iOS 26
 * fix) is:
 *   - 4-byte unsigned BIG-endian body length + a plist body (binary or XML);
 *   - outer keys `__selector` and `__argument`;
 *   - a connection identifier in WIRConnectionIdentifierKey.
 *
 * This module owns ALL WIR selector + key names (so they live in one place, not
 * scattered across verbs), the frame codec, listing normalization (keeping the
 * raw entry), and the named socket-setup variants. It frames over an injected
 * byte duplex so it is testable without a device. The INNER WIP JSON is handled
 * by webinspector-session.ts.
 *
 * Every outbound frame is followed by an EMPTY frame (a 4-byte zero length, no
 * body). On a real device webinspectord does not act on a message larger than
 * roughly two TCP segments (2.5-2.9 KB over Wi-Fi on iOS 27) until more bytes
 * arrive on the socket; without the prompt every reply lands one request late
 * and the DOM serializer never answers. ios-webkit-debug-proxy sends the same
 * empty payload after each message on iOS 11+ ("webinspectord may not ack the
 * message with relatively big payloads"). Inbound empty frames are ignored.
 */

import { decodePlist, encodeXmlPlist, DEFAULT_PLIST_LIMITS, type PlistDict, type PlistValue } from "./webinspector-plist"
import { isFinitePageId, type WirSetupVariant, type IosWebTargetType } from "../../shared/ios-web"

/** Minimal duplex the transport frames over. Satisfied by device-services'
 *  DeviceByteChannel and by usertunnel's TcpChan (structural typing). */
export interface DuplexBytes {
  write(b: Buffer): void
  onData(cb: (b: Buffer) => void): void
  onClose(cb: () => void): void
  close(): void
}

// ── WIR selector + key names (the single source of truth) ─────────────────────

export const WIR_SELECTOR = {
  reportIdentifier: "_rpc_reportIdentifier:",
  getConnectedApplications: "_rpc_getConnectedApplications:",
  forwardGetListing: "_rpc_forwardGetListing:",
  forwardSocketSetup: "_rpc_forwardSocketSetup:",
  forwardSocketData: "_rpc_forwardSocketData:",
  forwardDidClose: "_rpc_forwardDidClose:",
  forwardIndicateWebView: "_rpc_forwardIndicateWebView:",
} as const

/** Device → host selectors we consume. */
export const WIR_INCOMING = {
  reportConnectedApplicationList: "_rpc_reportConnectedApplicationList:",
  applicationConnected: "_rpc_applicationConnected:",
  applicationDisconnected: "_rpc_applicationDisconnected:",
  applicationUpdated: "_rpc_applicationUpdated:",
  applicationSentListing: "_rpc_applicationSentListing:",
  applicationSentData: "_rpc_applicationSentData:",
  applicationDidClose: "_rpc_applicationDidClose:",
} as const

export const WIR_KEY = {
  connectionIdentifier: "WIRConnectionIdentifierKey",
  applicationIdentifier: "WIRApplicationIdentifierKey",
  applicationBundleIdentifier: "WIRApplicationBundleIdentifierKey",
  applicationName: "WIRApplicationNameKey",
  isApplicationActive: "WIRIsApplicationActiveKey",
  isApplicationProxy: "WIRIsApplicationProxyKey",
  pageIdentifier: "WIRPageIdentifierKey",
  listing: "WIRListingKey",
  title: "WIRTitleKey",
  url: "WIRURLKey",
  type: "WIRTypeKey",
  senderKey: "WIRSenderKey",
  socketData: "WIRSocketDataKey",
  messageData: "WIRMessageDataKey",
  chunkSupported: "WIRMessageDataTypeChunkSupportedKey",
  automationAvailability: "WIRAutomationAvailabilityKey",
  hostApplicationIdentifier: "WIRHostApplicationIdentifierKey",
} as const

// ── frame codec (4-byte BE length + plist body) ───────────────────────────────

export class WirFrameError extends Error {
  constructor(message: string) { super(message); this.name = "WirFrameError" }
}

/** The zero-length frame that prompts webinspectord to process the message before it. */
export function encodeWirEmptyFrame(): Buffer {
  return Buffer.alloc(4)
}

export function encodeWirFrame(value: PlistValue): Buffer {
  const body = Buffer.from(encodeXmlPlist(value), "utf-8")
  const hdr = Buffer.alloc(4)
  hdr.writeUInt32BE(body.length, 0)
  return Buffer.concat([hdr, body])
}

/**
 * Pull one complete WIR frame off a buffer. Returns undefined when the header or
 * body is still incomplete; throws WirFrameError if the declared length exceeds
 * the cap (fail before waiting to allocate that much).
 */
export function tryReadWirFrame(
  buf: Buffer,
  maxBytes = DEFAULT_PLIST_LIMITS.maxBytes,
): { body: Buffer; rest: Buffer } | undefined {
  if (buf.length < 4) return undefined
  const len = buf.readUInt32BE(0)
  if (len > maxBytes) throw new WirFrameError(`WIR frame length ${len} exceeds ${maxBytes}-byte cap`)
  if (buf.length < 4 + len) return undefined
  return { body: buf.subarray(4, 4 + len), rest: buf.subarray(4 + len) }
}

// ── listing normalization (pure — keeps enough to correlate, not the secrets) ─

export type RawWebTarget = {
  devicePageId: number | null
  type: IosWebTargetType
  title?: string
  url?: string
  inspectable: boolean
  /** The raw WIRListingKey dictionary key, kept for protocol correlation. */
  rawListingKey: string
}

export type ParsedApplication = {
  applicationId?: string
  bundleId?: string
  name?: string
  active?: boolean
  proxy?: boolean
}

const WIR_TYPE_MAP: Record<string, IosWebTargetType> = {
  WIRTypeWeb: "web-page",
  WIRTypeWebPage: "web-page",
  WIRTypeWebView: "web-view",
  WIRTypeJavaScript: "javascript",
  WIRTypeServiceWorker: "service-worker",
  WIRTypeWebApp: "web-app",
  WIRTypeAutomation: "other",
}

export function wirTypeToTargetType(wirType: unknown): IosWebTargetType {
  return (typeof wirType === "string" && WIR_TYPE_MAP[wirType]) || "web-page"
}

/** Parse one connected application entry from a `_rpc_applicationConnected:`
 *  argument or an element of the connected-application list. */
export function parseApplication(arg: PlistDict): ParsedApplication {
  return {
    applicationId: strOrUndef(arg[WIR_KEY.applicationIdentifier]),
    bundleId: strOrUndef(arg[WIR_KEY.applicationBundleIdentifier]),
    name: strOrUndef(arg[WIR_KEY.applicationName]),
    active: boolOrUndef(arg[WIR_KEY.isApplicationActive]),
    proxy: boolOrUndef(arg[WIR_KEY.isApplicationProxy]),
  }
}

/**
 * Parse the connected-application list. Modern builds carry a dict keyed by
 * application id; some carry an array. Both are handled.
 */
export function parseConnectedApplicationList(arg: PlistDict): ParsedApplication[] {
  const listing = arg[WIR_KEY.listing] ?? arg["WIRApplicationDictionaryKey"] ?? arg
  const out: ParsedApplication[] = []
  if (Array.isArray(listing)) {
    for (const e of listing) if (isDict(e)) out.push(parseApplication(e))
  } else if (isDict(listing)) {
    for (const v of Object.values(listing)) if (isDict(v)) out.push(parseApplication(v))
  }
  return out.filter((a) => a.applicationId)
}

/**
 * Parse a `_rpc_applicationSentListing:` argument into normalized targets. The
 * device supplies WIRListingKey as a dict keyed by page id. A missing/empty/
 * non-numeric page id yields devicePageId: null (never guessed).
 */
export function parseApplicationListing(arg: PlistDict): { applicationId?: string; targets: RawWebTarget[] } {
  const applicationId = strOrUndef(arg[WIR_KEY.applicationIdentifier])
  const listing = arg[WIR_KEY.listing]
  const targets: RawWebTarget[] = []
  if (isDict(listing)) {
    for (const [rawKey, entry] of Object.entries(listing)) {
      if (!isDict(entry)) continue
      const pid = entry[WIR_KEY.pageIdentifier]
      targets.push({
        devicePageId: isFinitePageId(pid) ? pid : null,
        type: wirTypeToTargetType(entry[WIR_KEY.type]),
        title: strOrUndef(entry[WIR_KEY.title]),
        url: strOrUndef(entry[WIR_KEY.url]),
        inspectable: entry[WIR_KEY.automationAvailability] === false ? true : true, // listed ⇒ inspectable
        rawListingKey: rawKey,
      })
    }
  }
  return { applicationId, targets }
}

// ── socket-setup variant builder (pure — the iOS 26 compatibility switch) ─────

export type SocketSetupParams = {
  applicationId: string
  /** Finite numeric page id, or null/undefined when the listing omitted it. */
  pageId: number | null | undefined
  senderKey: string
  connectionId: string
}

/**
 * Build the `_rpc_forwardSocketSetup:` argument for a named variant.
 *   - classic-page-id: always carries WIRPageIdentifierKey (legacy shape).
 *   - optional-page-id-no-chunks: omits WIRPageIdentifierKey when the id is
 *     absent/non-numeric AND sends WIRMessageDataTypeChunkSupportedKey: false,
 *     matching appium-remote-debugger PR #498.
 */
export function buildSocketSetupArgument(variant: WirSetupVariant, p: SocketSetupParams): PlistDict {
  const arg: PlistDict = {
    [WIR_KEY.connectionIdentifier]: p.connectionId,
    [WIR_KEY.applicationIdentifier]: p.applicationId,
    [WIR_KEY.senderKey]: p.senderKey,
  }
  if (variant === "classic-page-id") {
    arg[WIR_KEY.pageIdentifier] = isFinitePageId(p.pageId) ? p.pageId : 1
  } else {
    if (isFinitePageId(p.pageId)) arg[WIR_KEY.pageIdentifier] = p.pageId
    arg[WIR_KEY.chunkSupported] = false
  }
  return arg
}

// ── the transport ────────────────────────────────────────────────────────────

export type WirMessage = { selector: string; argument: PlistDict }

export type WebInspectorTransportHandlers = {
  onApplicationList?: (apps: ParsedApplication[]) => void
  onApplicationConnected?: (app: ParsedApplication) => void
  onApplicationDisconnected?: (app: ParsedApplication) => void
  onListing?: (parsed: { applicationId?: string; targets: RawWebTarget[]; raw: PlistDict }) => void
  /** Inner WIP bytes forwarded from the device for a given sender/page. */
  onSocketData?: (data: Buffer, ctx: { applicationId?: string; pageId?: number; senderKey?: string }) => void
  onApplicationDidClose?: (arg: PlistDict) => void
  onMessage?: (msg: WirMessage) => void
  onClose?: () => void
  onError?: (err: Error) => void
}

export class WebInspectorTransport {
  private acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private closed = false

  constructor(
    private chan: DuplexBytes,
    readonly connectionId: string,
    private handlers: WebInspectorTransportHandlers = {},
    private maxBytes = DEFAULT_PLIST_LIMITS.maxBytes,
  ) {
    chan.onData((c) => this.ingest(c))
    chan.onClose(() => { this.closed = true; this.handlers.onClose?.() })
  }

  private ingest(chunk: Buffer): void {
    this.acc = Buffer.concat([this.acc, chunk])
    try {
      for (;;) {
        const frame = tryReadWirFrame(this.acc, this.maxBytes)
        if (!frame) break
        this.acc = frame.rest
        if (frame.body.length === 0) continue
        this.dispatch(frame.body)
      }
    } catch (err) {
      // A malformed/oversized frame closes only this WIR connection.
      this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
      this.close()
    }
  }

  private dispatch(body: Buffer): void {
    const decoded = decodePlist(body, { ...DEFAULT_PLIST_LIMITS, maxBytes: this.maxBytes })
    if (!isDict(decoded)) throw new WirFrameError("WIR frame is not a dict")
    const selector = strOrUndef(decoded["__selector"])
    const argument = isDict(decoded["__argument"]) ? (decoded["__argument"] as PlistDict) : {}
    if (!selector) throw new WirFrameError("WIR frame missing __selector")

    this.handlers.onMessage?.({ selector, argument })
    switch (selector) {
      case WIR_INCOMING.reportConnectedApplicationList:
        this.handlers.onApplicationList?.(parseConnectedApplicationList(argument))
        return
      case WIR_INCOMING.applicationConnected:
        this.handlers.onApplicationConnected?.(parseApplication(argument))
        return
      case WIR_INCOMING.applicationDisconnected:
        this.handlers.onApplicationDisconnected?.(parseApplication(argument))
        return
      case WIR_INCOMING.applicationSentListing: {
        const parsed = parseApplicationListing(argument)
        this.handlers.onListing?.({ ...parsed, raw: argument })
        return
      }
      case WIR_INCOMING.applicationSentData: {
        const data = argument[WIR_KEY.messageData]
        if (Buffer.isBuffer(data)) {
          this.handlers.onSocketData?.(data, {
            applicationId: strOrUndef(argument[WIR_KEY.applicationIdentifier]),
            pageId: numOrUndef(argument[WIR_KEY.pageIdentifier]),
            senderKey: strOrUndef(argument[WIR_KEY.senderKey]),
          })
        }
        return
      }
      case WIR_INCOMING.applicationDidClose:
        this.handlers.onApplicationDidClose?.(argument)
        return
      default:
        return // applicationUpdated and others surface via onMessage only
    }
  }

  private send(selector: string, argument: PlistDict): void {
    if (this.closed) return
    this.chan.write(encodeWirFrame({ __selector: selector, __argument: argument }))
    this.chan.write(encodeWirEmptyFrame())
  }

  /** Announce our connection identifier (first message of the session). */
  reportIdentifier(): void {
    this.send(WIR_SELECTOR.reportIdentifier, { [WIR_KEY.connectionIdentifier]: this.connectionId })
  }

  getConnectedApplications(): void {
    this.send(WIR_SELECTOR.getConnectedApplications, { [WIR_KEY.connectionIdentifier]: this.connectionId })
  }

  forwardGetListing(applicationId: string): void {
    this.send(WIR_SELECTOR.forwardGetListing, {
      [WIR_KEY.connectionIdentifier]: this.connectionId,
      [WIR_KEY.applicationIdentifier]: applicationId,
    })
  }

  forwardSocketSetup(variant: WirSetupVariant, p: Omit<SocketSetupParams, "connectionId">): void {
    this.send(WIR_SELECTOR.forwardSocketSetup, buildSocketSetupArgument(variant, { ...p, connectionId: this.connectionId }))
  }

  forwardSocketData(applicationId: string, pageId: number | null | undefined, senderKey: string, data: Buffer): void {
    const arg: PlistDict = {
      [WIR_KEY.connectionIdentifier]: this.connectionId,
      [WIR_KEY.applicationIdentifier]: applicationId,
      [WIR_KEY.senderKey]: senderKey,
      [WIR_KEY.socketData]: data,
    }
    if (isFinitePageId(pageId)) arg[WIR_KEY.pageIdentifier] = pageId
    this.send(WIR_SELECTOR.forwardSocketData, arg)
  }

  forwardDidClose(applicationId: string, pageId: number | null | undefined, senderKey: string): void {
    const arg: PlistDict = {
      [WIR_KEY.connectionIdentifier]: this.connectionId,
      [WIR_KEY.applicationIdentifier]: applicationId,
      [WIR_KEY.senderKey]: senderKey,
    }
    if (isFinitePageId(pageId)) arg[WIR_KEY.pageIdentifier] = pageId
    this.send(WIR_SELECTOR.forwardDidClose, arg)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.chan.close() } catch {}
  }
}

// ── small typed plist accessors ───────────────────────────────────────────────

function isDict(v: PlistValue | undefined): v is PlistDict {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v)
}
function strOrUndef(v: PlistValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined
}
function numOrUndef(v: PlistValue | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}
function boolOrUndef(v: PlistValue | undefined): boolean | undefined {
  return typeof v === "boolean" ? v : undefined
}
