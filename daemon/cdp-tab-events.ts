// Raw CDP event subscriptions for browser tabs.
//
// A client on the IPC socket sends {type:"cdp_tab_events"} and keeps the socket
// open. The extension then posts each matching CDP event once, tagged with the
// subscriptions it is for, and this module writes it to their sockets. A
// subscription ends when its socket closes; the daemon renews the extension's
// lease while the socket is open (extension/src/background/cdp-session.ts).

/** Raw CDP reaches a signed-in profile, so only the IPC socket accepts it. */
export const RAW_CDP_ACTION_TYPES = new Set([
  "cdp_tab_attach", "cdp_tab_detach", "cdp_tab_send", "cdp_tab_status",
  "cdp_tab_events", "cdp_tab_subscribe", "cdp_tab_unsubscribe", "cdp_tab_renew",
])

export function isRawCdpAction(type: unknown): boolean {
  return typeof type === "string" && RAW_CDP_ACTION_TYPES.has(type)
}

export const CDP_EVENT_TYPE = "cdp_event"
/** Extension event frames open with this, so they are recognized without a parse. */
export const CDP_EVENT_FRAME_PREFIX = `{"type":"${CDP_EVENT_TYPE}"`
/** A subscriber this far behind is dropped rather than buffered without limit. */
export const SUBSCRIBER_MAX_QUEUED_BYTES = 64 * 1024 * 1024
export const SUBSCRIPTION_RENEW_INTERVAL_MS = 10_000

export type CdpSubscriber<S extends object = object> = {
  subscription: string
  socket: S
  contextId?: string
  tabId?: number
}

export type CdpEventFrame = {
  type: typeof CDP_EVENT_TYPE
  subscription: string
  tabId?: number
  method: string
  params?: unknown
  sessionId?: string
}

export class CdpSubscriptions<S extends object = object> {
  private readonly byId = new Map<string, CdpSubscriber<S>>()

  get size(): number { return this.byId.size }

  add(subscriber: CdpSubscriber<S>): void {
    this.byId.set(subscriber.subscription, subscriber)
  }

  get(subscription: string): CdpSubscriber<S> | undefined {
    return this.byId.get(subscription)
  }

  remove(subscription: string): CdpSubscriber<S> | undefined {
    const subscriber = this.byId.get(subscription)
    this.byId.delete(subscription)
    return subscriber
  }

  removeSocket(socket: S): CdpSubscriber<S>[] {
    const removed: CdpSubscriber<S>[] = []
    for (const subscriber of this.byId.values()) {
      if (subscriber.socket === socket) removed.push(subscriber)
    }
    for (const subscriber of removed) this.byId.delete(subscriber.subscription)
    return removed
  }

  /** Subscription ids per extension context, for one lease renewal each. */
  byContext(): Map<string | undefined, string[]> {
    const groups = new Map<string | undefined, string[]>()
    for (const subscriber of this.byId.values()) {
      const ids = groups.get(subscriber.contextId)
      if (ids) ids.push(subscriber.subscription)
      else groups.set(subscriber.contextId, [subscriber.subscription])
    }
    return groups
  }

  /** The sockets an extension event goes to, each with the frame it receives. */
  route(msg: Record<string, unknown>): Array<{ subscriber: CdpSubscriber<S>; frame: CdpEventFrame }> {
    const ids = Array.isArray(msg.subscriptions) ? msg.subscriptions : []
    const method = typeof msg.method === "string" ? msg.method : ""
    if (!method) return []
    const out: Array<{ subscriber: CdpSubscriber<S>; frame: CdpEventFrame }> = []
    for (const id of ids) {
      const subscriber = typeof id === "string" ? this.byId.get(id) : undefined
      if (!subscriber) continue
      out.push({
        subscriber,
        frame: {
          type: CDP_EVENT_TYPE,
          subscription: subscriber.subscription,
          ...(typeof msg.tabId === "number" ? { tabId: msg.tabId } : {}),
          method,
          params: msg.params ?? {},
          ...(typeof msg.sessionId === "string" ? { sessionId: msg.sessionId } : {}),
        },
      })
    }
    return out
  }
}

/** A subscription-ended notice in the same shape as a CDP event. */
export function subscriptionEndedFrame(subscriber: CdpSubscriber, reason: string): CdpEventFrame {
  return {
    type: CDP_EVENT_TYPE,
    subscription: subscriber.subscription,
    ...(subscriber.tabId !== undefined ? { tabId: subscriber.tabId } : {}),
    method: "Interceptor.subscriptionEnded",
    params: { reason },
  }
}

/** Length-prefixed frame, as every message on the IPC socket. */
export function encodeIpcFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.byteLength, 0)
  return Buffer.concat([header, body])
}
