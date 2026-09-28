import { describe, expect, test } from "bun:test"
import {
  encodeWirFrame, encodeWirEmptyFrame, tryReadWirFrame, WirFrameError,
  buildSocketSetupArgument, parseApplicationListing, parseConnectedApplicationList,
  wirTypeToTargetType, WebInspectorTransport, WIR_KEY, WIR_INCOMING, WIR_SELECTOR,
  type DuplexBytes,
} from "../daemon/ios/webinspector-transport"
import { decodePlist, type PlistDict } from "../daemon/ios/webinspector-plist"

// Locks the WIR wire format: 4-byte BE length + plist body, __selector/__argument
// framing, listing normalization (keeping raw page ids honest), the iOS-26 setup
// variant switch, and forwarded socket data reassembly.

function fakeDuplex() {
  let dataCb: ((b: Buffer) => void) | undefined
  let closeCb: (() => void) | undefined
  const writes: Buffer[] = []
  const chan: DuplexBytes = {
    write: (b) => writes.push(Buffer.from(b)),
    onData: (cb) => { dataCb = cb },
    onClose: (cb) => { closeCb = cb },
    close: () => { closeCb?.() },
  }
  return { chan, feed: (b: Buffer) => dataCb?.(b), fireClose: () => closeCb?.(), writes }
}

/** The plist a sent frame carries. */
function sentFrame(buf: Buffer): { selector: string; argument: PlistDict } {
  const body = tryReadWirFrame(buf)!.body
  const decoded = decodePlist(body) as any
  return { selector: decoded.__selector, argument: decoded.__argument }
}

describe("WIR frame codec", () => {
  test("encode → decode round trip; length prefix is BE", () => {
    const frame = encodeWirFrame({ __selector: WIR_SELECTOR.reportIdentifier, __argument: { a: 1 } })
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4)
    const r = tryReadWirFrame(frame)!
    expect(r.rest.length).toBe(0)
    expect((decodePlist(r.body) as any).__selector).toBe(WIR_SELECTOR.reportIdentifier)
  })

  test("partial 4-byte header and partial body both return undefined", () => {
    const f = encodeWirFrame({ __selector: "x", __argument: {} })
    expect(tryReadWirFrame(f.subarray(0, 3))).toBeUndefined()
    expect(tryReadWirFrame(f.subarray(0, f.length - 1))).toBeUndefined()
  })

  test("multiple frames in one buffer split cleanly", () => {
    const a = encodeWirFrame({ __selector: "a", __argument: {} })
    const b = encodeWirFrame({ __selector: "b", __argument: {} })
    const first = tryReadWirFrame(Buffer.concat([a, b]))!
    expect((decodePlist(first.body) as any).__selector).toBe("a")
    const second = tryReadWirFrame(first.rest)!
    expect((decodePlist(second.body) as any).__selector).toBe("b")
    expect(second.rest.length).toBe(0)
  })

  test("oversized declared length fails before allocating", () => {
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(64 * 1024 * 1024, 0)
    expect(() => tryReadWirFrame(hdr, 32 * 1024 * 1024)).toThrow(WirFrameError)
  })
})

describe("WIR listing normalization", () => {
  test("type mapping", () => {
    expect(wirTypeToTargetType("WIRTypeWeb")).toBe("web-page")
    expect(wirTypeToTargetType("WIRTypeServiceWorker")).toBe("service-worker")
    expect(wirTypeToTargetType("WIRTypeJavaScript")).toBe("javascript")
    expect(wirTypeToTargetType(undefined)).toBe("web-page")
  })

  test("connected application list (dict-keyed)", () => {
    const apps = parseConnectedApplicationList({
      [WIR_KEY.listing]: {
        "PID:1": { [WIR_KEY.applicationIdentifier]: "PID:1", [WIR_KEY.applicationBundleIdentifier]: "com.apple.mobilesafari", [WIR_KEY.applicationName]: "Safari", [WIR_KEY.isApplicationActive]: true },
      },
    })
    expect(apps).toHaveLength(1)
    expect(apps[0].bundleId).toBe("com.apple.mobilesafari")
    expect(apps[0].active).toBe(true)
  })

  test("per-app page listing keeps finite page id and drops non-numeric to null", () => {
    const parsed = parseApplicationListing({
      [WIR_KEY.applicationIdentifier]: "PID:1",
      [WIR_KEY.listing]: {
        "1": { [WIR_KEY.pageIdentifier]: 1, [WIR_KEY.title]: "One", [WIR_KEY.url]: "https://a/", [WIR_KEY.type]: "WIRTypeWeb" },
        "x": { [WIR_KEY.title]: "No page id", [WIR_KEY.url]: "https://b/" },
      },
    })
    expect(parsed.applicationId).toBe("PID:1")
    const byKey = Object.fromEntries(parsed.targets.map((t) => [t.rawListingKey, t]))
    expect(byKey["1"].devicePageId).toBe(1)
    expect(byKey["x"].devicePageId).toBeNull() // never guessed
  })
})

describe("WIR socket-setup variant", () => {
  const base = { applicationId: "PID:1", senderKey: "S1", connectionId: "C1" }

  test("classic always carries a numeric page id", () => {
    const arg = buildSocketSetupArgument("classic-page-id", { ...base, pageId: 7 })
    expect(arg[WIR_KEY.pageIdentifier]).toBe(7)
    expect(arg[WIR_KEY.chunkSupported]).toBeUndefined()
  })

  test("optional-page-id-no-chunks omits page id when absent and sends chunk=false", () => {
    const withId = buildSocketSetupArgument("optional-page-id-no-chunks", { ...base, pageId: 3 })
    expect(withId[WIR_KEY.pageIdentifier]).toBe(3)
    expect(withId[WIR_KEY.chunkSupported]).toBe(false)

    const noId = buildSocketSetupArgument("optional-page-id-no-chunks", { ...base, pageId: null })
    expect(noId[WIR_KEY.pageIdentifier]).toBeUndefined() // omitted, not guessed
    expect(noId[WIR_KEY.chunkSupported]).toBe(false)
  })
})

describe("WebInspectorTransport dispatch", () => {
  test("reportIdentifier writes a framed selector; listing + socket data are dispatched", () => {
    const d = fakeDuplex()
    const targets: any[] = []
    const socketChunks: Buffer[] = []
    const t = new WebInspectorTransport(d.chan, "C1", {
      onListing: (p) => targets.push(...p.targets),
      onSocketData: (data) => socketChunks.push(data),
    })
    t.reportIdentifier()
    expect(sentFrame(d.writes[0]).selector).toBe(WIR_SELECTOR.reportIdentifier)

    // Device sends a listing.
    d.feed(encodeWirFrame({
      __selector: WIR_INCOMING.applicationSentListing,
      __argument: { [WIR_KEY.applicationIdentifier]: "PID:1", [WIR_KEY.listing]: { "1": { [WIR_KEY.pageIdentifier]: 1, [WIR_KEY.type]: "WIRTypeWeb" } } },
    }))
    expect(targets).toHaveLength(1)
    expect(targets[0].devicePageId).toBe(1)

    // Inner WIP bytes arrive as applicationSentData with WIRMessageDataKey.
    d.feed(encodeWirFrame({
      __selector: WIR_INCOMING.applicationSentData,
      __argument: { [WIR_KEY.applicationIdentifier]: "PID:1", [WIR_KEY.messageData]: Buffer.from('{"id":1}') },
    }))
    expect(Buffer.concat(socketChunks).toString()).toBe('{"id":1}')
  })

  test("forwarded socket data split across two TCP chunks reassembles into one frame", () => {
    const d = fakeDuplex()
    const chunks: Buffer[] = []
    new WebInspectorTransport(d.chan, "C1", { onSocketData: (data) => chunks.push(data) })
    const frame = encodeWirFrame({
      __selector: WIR_INCOMING.applicationSentData,
      __argument: { [WIR_KEY.messageData]: Buffer.from("split-payload") },
    })
    d.feed(frame.subarray(0, 6)) // header + a few bytes
    expect(chunks).toHaveLength(0) // nothing dispatched yet
    d.feed(frame.subarray(6))     // the rest
    expect(Buffer.concat(chunks).toString()).toBe("split-payload")
  })

  test("a malformed frame closes only this connection via onError+onClose", () => {
    const d = fakeDuplex()
    let closed = false
    let errored = false
    new WebInspectorTransport(d.chan, "C1", { onError: () => { errored = true }, onClose: () => { closed = true } })
    // Declared length ok, but body is a plist dict WITHOUT __selector.
    d.feed(encodeWirFrame({ notASelector: 1 }))
    expect(errored).toBe(true)
    expect(closed).toBe(true)
  })
})

describe("WIR empty-frame prompt (webinspectord large-message stall)", () => {
  test("every outbound frame is followed by a 4-byte zero-length frame", () => {
    const d = fakeDuplex()
    const t = new WebInspectorTransport(d.chan, "C1")
    t.reportIdentifier()
    t.forwardSocketData("PID:1", 1, "S", Buffer.from("x".repeat(12_000)))
    expect(d.writes).toHaveLength(4)
    expect(sentFrame(d.writes[0]).selector).toBe(WIR_SELECTOR.reportIdentifier)
    expect(d.writes[1].equals(encodeWirEmptyFrame())).toBe(true)
    expect(sentFrame(d.writes[2]).selector).toBe(WIR_SELECTOR.forwardSocketData)
    expect(d.writes[3].equals(Buffer.alloc(4))).toBe(true)
    expect(d.writes[3].readUInt32BE(0)).toBe(0)
  })

  test("an inbound zero-length frame between two real frames is ignored, not a protocol error", () => {
    const d = fakeDuplex()
    const chunks: Buffer[] = []
    let errored = false
    new WebInspectorTransport(d.chan, "C1", { onSocketData: (data) => chunks.push(data), onError: () => { errored = true } })
    const frame = (s: string) => encodeWirFrame({ __selector: WIR_INCOMING.applicationSentData, __argument: { [WIR_KEY.messageData]: Buffer.from(s) } })
    d.feed(Buffer.concat([frame("a"), encodeWirEmptyFrame(), frame("b")]))
    expect(errored).toBe(false)
    expect(chunks.map((c) => c.toString())).toEqual(["a", "b"])
  })
})
