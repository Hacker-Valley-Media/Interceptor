import { describe, expect, test } from "bun:test"
import {
  F_ALWAYS, F_DATA, F_HEARTBEAT_REQ, F_HEARTBEAT_REPLY, F_INIT,
  FT_DATA, FT_HEADERS, ROOT, REPLY,
  encodeWrapper, tryDecodeWrapper, h2frame,
  isXpcEmptyHeartbeatRequest, encodeXpcHeartbeatReply,
  uiTestPlatformSpecificOptionsXml,
  XpcService, XpcServiceRaw,
  type TcpChan,
} from "../daemon/ios/usertunnel"

// Locks the RemoteXPC empty-request / heartbeat reply codec against
// go-ios HeartbeatRequestFlag/HeartbeatReplyFlag and pymobiledevice3
// WANTING_REPLY/REPLY. An inbound empty 0x00010000 wrapper must be answered
// with an empty 0x00020000 wrapper on the opposite H2 stream and must not
// resolve a pending request() waiter.

function mockChan(): { chan: TcpChan; inject: (b: Buffer) => void; written: Buffer[] } {
  const written: Buffer[] = []
  let onData: ((b: Buffer) => void) | undefined
  const chan: TcpChan = {
    write: (b) => { written.push(Buffer.from(b)) },
    onData: (cb) => { onData = cb },
    onClose: () => {},
    close: () => {},
  }
  return { chan, inject: (b) => onData?.(b), written }
}

function concat(bufs: Buffer[]): Buffer { return Buffer.concat(bufs) }

function parseH2(buf: Buffer): Array<{ type: number; flags: number; sid: number; payload: Buffer }> {
  const frames: Array<{ type: number; flags: number; sid: number; payload: Buffer }> = []
  let off = 0
  while (off + 9 <= buf.length) {
    const len = buf.readUIntBE(off, 3)
    if (off + 9 + len > buf.length) break
    frames.push({
      type: buf[off + 3]!,
      flags: buf[off + 4]!,
      sid: buf.readUInt32BE(off + 5) & 0x7fffffff,
      payload: buf.subarray(off + 9, off + 9 + len),
    })
    off += 9 + len
  }
  return frames
}

function xpcDataFrames(written: Buffer[], sid: number) {
  return parseH2(concat(written)).filter((f) => f.type === FT_DATA && f.sid === sid)
}

function heartbeatReq(msgId: number, sid: number): Buffer {
  return h2frame(FT_DATA, 0, sid, encodeWrapper(null, F_ALWAYS | F_HEARTBEAT_REQ, msgId))
}

describe("RemoteXPC heartbeat / empty-request codec", () => {
  test("F_HEARTBEAT_REPLY is go-ios 0x00020000 / pymobiledevice3 REPLY", () => {
    expect(F_HEARTBEAT_REQ).toBe(0x00010000)
    expect(F_HEARTBEAT_REPLY).toBe(0x00020000)
  })

  test("empty WANTING_REPLY is a heartbeat; replies, init, terminator, and data are not", () => {
    expect(isXpcEmptyHeartbeatRequest(F_ALWAYS | F_HEARTBEAT_REQ, null)).toBe(true)
    expect(isXpcEmptyHeartbeatRequest(F_ALWAYS | F_HEARTBEAT_REQ, {})).toBe(true)
    expect(isXpcEmptyHeartbeatRequest(F_ALWAYS | F_HEARTBEAT_REPLY, null)).toBe(false)
    expect(isXpcEmptyHeartbeatRequest(F_ALWAYS | F_HEARTBEAT_REQ | F_HEARTBEAT_REPLY, null)).toBe(false)
    expect(isXpcEmptyHeartbeatRequest(F_ALWAYS | F_INIT, null)).toBe(false)
    expect(isXpcEmptyHeartbeatRequest(0x0201, null)).toBe(false)
    expect(isXpcEmptyHeartbeatRequest(F_ALWAYS | F_DATA | F_HEARTBEAT_REQ, { CoreDevice: 1 })).toBe(false)
    expect(isXpcEmptyHeartbeatRequest(F_ALWAYS, null)).toBe(false)
  })

  test("heartbeat reply wrapper is 24 bytes, bodyLen 0, same message id, REPLY flag", () => {
    const b = encodeXpcHeartbeatReply(42)
    expect(b.length).toBe(24)
    const dec = tryDecodeWrapper(b)!
    expect(dec.consumed).toBe(24)
    expect(dec.body).toBeNull()
    expect(dec.msgId).toBe(42)
    expect(dec.flags & F_HEARTBEAT_REPLY).toBe(F_HEARTBEAT_REPLY)
    expect(dec.flags & F_ALWAYS).toBe(F_ALWAYS)
    expect(dec.flags & F_HEARTBEAT_REQ).toBe(0)
    expect(dec.flags & F_DATA).toBe(0)
  })
})

describe("XpcService heartbeat replies", () => {
  test("empty request on stream 3 is answered on stream 1 with the same message id", () => {
    const { chan, inject, written } = mockChan()
    new XpcService(chan, "t")
    inject(heartbeatReq(7, REPLY))
    const data = xpcDataFrames(written, ROOT)
    expect(data.length).toBe(1)
    const dec = tryDecodeWrapper(data[0]!.payload)!
    expect(dec.msgId).toBe(7)
    expect(dec.body).toBeNull()
    expect(dec.flags & F_HEARTBEAT_REPLY).toBe(F_HEARTBEAT_REPLY)
    expect(parseH2(concat(written)).some((f) => f.type === FT_HEADERS && f.sid === ROOT)).toBe(true)
  })

  test("empty request on stream 1 is answered on stream 3 with the same message id", () => {
    const { chan, inject, written } = mockChan()
    new XpcService(chan, "t")
    inject(heartbeatReq(9, ROOT))
    const data = xpcDataFrames(written, REPLY)
    expect(data.length).toBe(1)
    expect(tryDecodeWrapper(data[0]!.payload)!.msgId).toBe(9)
    expect(tryDecodeWrapper(data[0]!.payload)!.flags & F_HEARTBEAT_REPLY).toBe(F_HEARTBEAT_REPLY)
  })

  test("a heartbeat on stream 3 does not resolve a pending request waiter", async () => {
    const { chan, inject, written } = mockChan()
    const svc = new XpcService(chan, "t")
    const pending = svc.request({ CoreDevice: { featureIdentifier: "x" } }, 0, 500)
    written.length = 0
    inject(heartbeatReq(11, REPLY))
    const raced = await Promise.race([
      pending.then((body) => ({ done: true as const, body })),
      new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), 40)),
    ])
    expect(raced.done).toBe(false)
    expect(xpcDataFrames(written, ROOT).length).toBe(1)

    inject(h2frame(FT_DATA, 0, REPLY, encodeWrapper({ pid: 99 }, F_ALWAYS | F_DATA | F_HEARTBEAT_REPLY, 1)))
    const body = await pending
    expect(Number(body.pid)).toBe(99)
  })
})

describe("XpcServiceRaw heartbeat replies", () => {
  test("empty request on ROOT is answered on REPLY", () => {
    const { chan, inject, written } = mockChan()
    new XpcServiceRaw(chan)
    inject(heartbeatReq(3, ROOT))
    const data = xpcDataFrames(written, REPLY)
    expect(data.length).toBe(1)
    const dec = tryDecodeWrapper(data[0]!.payload)!
    expect(dec.msgId).toBe(3)
    expect(dec.flags & F_HEARTBEAT_REPLY).toBe(F_HEARTBEAT_REPLY)
  })

  test("empty request on REPLY is answered on ROOT and does not look like an RSD handshake body", () => {
    const { chan, inject, written } = mockChan()
    new XpcServiceRaw(chan)
    inject(heartbeatReq(4, REPLY))
    const data = xpcDataFrames(written, ROOT)
    expect(data.length).toBe(1)
    expect(tryDecodeWrapper(data[0]!.payload)!.body).toBeNull()
  })
})

describe("UI-test platformSpecificOptions", () => {
  test("xml carries the go-ios ActivateSuspended launch flags", () => {
    const xml = uiTestPlatformSpecificOptionsXml()
    expect(xml).toContain("<key>ActivateSuspended</key><integer>1</integer>")
    expect(xml).toContain("<key>StartSuspendedKey</key><integer>0</integer>")
    expect(xml).toContain("<key>__ActivateSuspended</key><integer>1</integer>")
    expect(xml).not.toMatch(/<dict\s*\/>/)
  })
})
