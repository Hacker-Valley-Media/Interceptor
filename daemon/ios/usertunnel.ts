// xcuitest.ts — launch an already-installed XCUITest runner over the userspace
// RemoteXPC tunnel, no root / no Xcode / pure Bun.
//
// Flow (iOS 17+, per go-ios runXUITestWithBundleIdsXcode15Ctx):
//   1. CoreDeviceProxy CDTunnel + userspace TCP mux (from rsd.ts) + RSD handshake
//      -> enumerate service ports.
//   2. mobile_image_mounter: verify DDI is mounted (skip if present).
//   3. installation_proxy: confirm the runner bundle is installed, grab its path.
//   4. DTX conn #1 to com.apple.dt.testmanagerd.remote (raw TCP over tunnel):
//        capability handshake, request the IDE channel,
//        _IDE_initiateSessionWithIdentifier:capabilities:.
//   5. coredevice.appservice (XPC over tunnel) + openstdiosocket:
//        launchapplication with our env vars -> PID.   <-- THE launch + env inject
//   6. DTX conn #2: _IDE_initiateControlSessionWithCapabilities:,
//        _IDE_authorizeTestSessionWithProcessID:<pid>,
//        request XCTestDriverInterface channel, _IDE_startExecutingTestPlanWithProtocolVersion:36.
//
// NSKeyedArchiver: built as an XML plist object graph and converted with `plutil`.
// XPC / HTTP2 / TCP-mux / DTX-header codecs are reused/validated against go-ios.

import net from "node:net"
import { randomBytes, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { connectServiceSocket } from "./lockdown"

const RUNNER_BUNDLE = "com.interceptor.InterceptorRunner.xctrunner"
const DBG = !!process.env.DBG

export type UserspaceRunnerEnv = {
  INTERCEPTOR_WS_URL: string
  INTERCEPTOR_WS_TOKEN: string
  INTERCEPTOR_UDID: string
  INTERCEPTOR_CONTEXT_ID: string
}

export type UserspaceLaunchOptions = {
  bundleId?: string
  env: UserspaceRunnerEnv
  launchAttempts?: number
  observeMs?: number
  log?: (message: string) => void
}

export type UserspaceRunnerHandle = {
  pid: number
  sessionId: string
  services: Record<string, number>
  close: () => void
}

// ── IPv6/TCP framing + userspace mux (verbatim from rsd.ts) ───────────────────
function parseIp6(s: string): Buffer {
  const [head, tail] = s.split("::")
  const h = head ? head.split(":").filter(Boolean) : []
  const t = tail ? tail.split(":").filter(Boolean) : []
  const mid = new Array(8 - h.length - t.length).fill("0")
  const parts = [...h, ...mid, ...t].map((x) => parseInt(x, 16))
  const b = Buffer.alloc(16)
  parts.forEach((v, i) => b.writeUInt16BE(v, i * 2))
  return b
}
function checksum16(buf: Buffer): number {
  let sum = 0
  for (let i = 0; i + 1 < buf.length; i += 2) sum += buf.readUInt16BE(i)
  if (buf.length % 2) sum += buf[buf.length - 1] << 8
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16)
  return (~sum) & 0xffff
}
const TCP_FIN = 1, TCP_SYN = 2, TCP_RST = 4, TCP_PSH = 8, TCP_ACK = 16
function buildTcpIp6(src: Buffer, dst: Buffer, sport: number, dport: number, seq: number, ack: number, flags: number, payload: Buffer, window = 65535): Buffer {
  const tcp = Buffer.alloc(20 + payload.length)
  tcp.writeUInt16BE(sport, 0); tcp.writeUInt16BE(dport, 2)
  tcp.writeUInt32BE(seq >>> 0, 4); tcp.writeUInt32BE(ack >>> 0, 8)
  tcp.writeUInt16BE((5 << 12) | flags, 12)
  tcp.writeUInt16BE(window, 14)
  payload.copy(tcp, 20)
  const pseudo = Buffer.alloc(40 + tcp.length)
  src.copy(pseudo, 0); dst.copy(pseudo, 16)
  pseudo.writeUInt32BE(tcp.length, 32); pseudo.writeUInt8(6, 39)
  tcp.copy(pseudo, 40)
  tcp.writeUInt16BE(checksum16(pseudo), 16)
  const ip = Buffer.alloc(40 + tcp.length)
  ip.writeUInt32BE(0x60000000, 0)
  ip.writeUInt16BE(tcp.length, 4); ip.writeUInt8(6, 6); ip.writeUInt8(64, 7)
  src.copy(ip, 8); dst.copy(ip, 24)
  tcp.copy(ip, 40)
  return ip
}
type Conn = {
  sport: number; dport: number; seq: number; ack: number
  established: boolean; onData: (b: Buffer) => void; onEstablished: () => void; onClose: () => void
}
export class Tun {
  private conns = new Map<number, Conn>()
  private racc = Buffer.alloc(0)
  constructor(private cdp: net.Socket, private myIp: Buffer, private devIp: Buffer) {
    cdp.on("data", (chunk: Buffer) => this.onWire(chunk))
  }
  private onWire(chunk: Buffer) {
    this.racc = Buffer.concat([this.racc, chunk])
    while (this.racc.length >= 40) {
      if ((this.racc[0] >> 4) !== 6) { this.racc = Buffer.alloc(0); break }
      const plen = this.racc.readUInt16BE(4); const total = 40 + plen
      if (this.racc.length < total) break
      const pkt = this.racc.subarray(0, total); this.racc = this.racc.subarray(total)
      if (pkt[6] !== 6) continue
      const tcp = pkt.subarray(40)
      const dport = tcp.readUInt16BE(2)
      const c = this.conns.get(dport)
      if (!c) continue
      const theirSeq = tcp.readUInt32BE(4)
      const flags = tcp.readUInt16BE(12) & 0x1ff
      const dataOff = (tcp.readUInt16BE(12) >> 12) * 4
      const data = tcp.subarray(dataOff)
      if ((flags & TCP_SYN) && (flags & TCP_ACK)) {
        c.seq = tcp.readUInt32BE(8); c.ack = (theirSeq + 1) >>> 0
        this.send(c, TCP_ACK, Buffer.alloc(0)); c.established = true; c.onEstablished()
      } else if (c.established) {
        if (data.length > 0) {
          if (theirSeq === c.ack) { c.ack = (c.ack + data.length) >>> 0; this.send(c, TCP_ACK, Buffer.alloc(0)); c.onData(data) }
          else this.send(c, TCP_ACK, Buffer.alloc(0))
        }
        if (flags & TCP_FIN) { c.ack = (c.ack + 1) >>> 0; this.send(c, TCP_ACK, Buffer.alloc(0)); c.onClose() }
        if (flags & TCP_RST) c.onClose()
      }
    }
  }
  private send(c: Conn, flags: number, payload: Buffer) {
    this.cdp.write(buildTcpIp6(this.myIp, this.devIp, c.sport, c.dport, c.seq, c.ack, flags, payload))
  }
  connect(dport: number): Promise<TcpChan> {
    const sport = 40000 + Math.floor(Math.random() * 20000)
    const c: Conn = { sport, dport, seq: Math.floor(Math.random() * 0x7fffffff), ack: 0, established: false, onData: () => {}, onEstablished: () => {}, onClose: () => {} }
    this.conns.set(sport, c)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`TCP connect to ${dport} timed out`)), 8000)
      c.onEstablished = () => {
        clearTimeout(t)
        resolve({
          write: (b: Buffer) => {
            // segment to the tunnel MTU (1280) minus IPv6(40)+TCP(20) headers.
            const MSS = 1220
            for (let off = 0; off < b.length; off += MSS) {
              const seg = b.subarray(off, off + MSS)
              this.send(c, TCP_ACK | TCP_PSH, seg)
              c.seq = (c.seq + seg.length) >>> 0
            }
            if (b.length === 0) { this.send(c, TCP_ACK | TCP_PSH, b) }
          },
          onData: (cb) => { c.onData = cb },
          onClose: (cb) => { c.onClose = cb },
          close: () => {
            if (!this.conns.has(sport)) return
            try { this.send(c, TCP_ACK | TCP_FIN, Buffer.alloc(0)); c.seq = (c.seq + 1) >>> 0 } catch {}
            this.conns.delete(sport)
          },
        })
      }
      this.send(c, TCP_SYN, Buffer.alloc(0))
    })
  }
}
export type TcpChan = { write: (b: Buffer) => void; onData: (cb: (b: Buffer) => void) => void; onClose: (cb: () => void) => void; close: () => void }

// ── XPC wire codec (from rsd.ts, matches go-ios xpc/encoding.go) ──────────────
const WRAPPER_MAGIC = 0x29b00b92, OBJ_MAGIC = 0x42133742, OBJ_VERSION = 5
// Flag names follow go-ios ios/xpc/encoding.go. pymobiledevice3 calls the same
// bits WANTING_REPLY / REPLY. 0x00010000 on an empty wrapper is the RemoteXPC
// keepalive the device expects answered with 0x00020000 + the same message id.
export const F_ALWAYS = 0x00000001, F_DATA = 0x00000100, F_HEARTBEAT_REQ = 0x00010000, F_HEARTBEAT_REPLY = 0x00020000, F_INIT = 0x00400000
const F_TERMINATOR = 0x0200 // 0x0201 handshake terminator; never a heartbeat
class U64 { constructor(public v: bigint | number) {} }
class I64 { constructor(public v: bigint | number) {} }
class Dbl { constructor(public v: number) {} }
class XData { constructor(public v: Buffer) {} }
class XUuid { constructor(public v: Buffer) {} }
const T_NULL = 0x1000, T_BOOL = 0x2000, T_INT64 = 0x3000, T_UINT64 = 0x4000, T_DOUBLE = 0x5000,
  T_DATA = 0x8000, T_STRING = 0x9000, T_UUID = 0xa000, T_ARRAY = 0xe000, T_DICT = 0xf000
function pad4(n: number) { return (4 - (n % 4)) % 4 }
function u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b }
function encObject(v: unknown): Buffer {
  if (v === null || v === undefined) return u32(T_NULL)
  if (typeof v === "boolean") { const b = Buffer.alloc(8); b.writeUInt32LE(T_BOOL, 0); b.writeUInt32LE(v ? 1 : 0, 4); return b }
  if (v instanceof U64) { const b = Buffer.alloc(12); b.writeUInt32LE(T_UINT64, 0); b.writeBigUInt64LE(BigInt(v.v), 4); return b }
  if (v instanceof I64) { const b = Buffer.alloc(12); b.writeUInt32LE(T_INT64, 0); b.writeBigInt64LE(BigInt(v.v), 4); return b }
  if (v instanceof Dbl) { const b = Buffer.alloc(12); b.writeUInt32LE(T_DOUBLE, 0); b.writeDoubleLE(v.v, 4); return b }
  if (typeof v === "number") { const b = Buffer.alloc(12); b.writeUInt32LE(T_INT64, 0); b.writeBigInt64LE(BigInt(v), 4); return b }
  if (v instanceof XUuid) return Buffer.concat([u32(T_UUID), v.v])
  if (v instanceof XData) { const p = pad4(v.v.length); return Buffer.concat([u32(T_DATA), u32(v.v.length), v.v, Buffer.alloc(p)]) }
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8"); const len = s.length + 1; const p = pad4(len)
    return Buffer.concat([u32(T_STRING), u32(len), s, Buffer.alloc(1 + p)])
  }
  if (Array.isArray(v)) { const body = Buffer.concat(v.map(encObject)); return Buffer.concat([u32(T_ARRAY), u32(body.length), u32(v.length), body]) }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
    const inner = Buffer.concat(entries.map(([k, val]) => {
      const kb = Buffer.from(k, "utf8"); const klen = kb.length + 1; const kp = pad4(klen)
      return Buffer.concat([kb, Buffer.alloc(1 + kp), encObject(val)])
    }))
    const payload = Buffer.concat([u32(entries.length), inner])
    return Buffer.concat([u32(T_DICT), u32(payload.length), payload])
  }
  throw new Error(`encObject: cannot encode ${typeof v}`)
}
export function encodeWrapper(dict: Record<string, unknown> | null, flags: number, messageId = 0): Buffer {
  const hdr = Buffer.alloc(24)
  hdr.writeUInt32LE(WRAPPER_MAGIC, 0); hdr.writeUInt32LE(flags >>> 0, 4); hdr.writeBigUInt64LE(BigInt(messageId), 16)
  if (dict === null) { hdr.writeBigUInt64LE(0n, 8); return hdr }
  const body = Buffer.concat([u32(OBJ_MAGIC), u32(OBJ_VERSION), encObject(dict)])
  hdr.writeBigUInt64LE(BigInt(body.length), 8)
  return Buffer.concat([hdr, body])
}
class Reader {
  off = 0
  constructor(public b: Buffer) {}
  u32() { const v = this.b.readUInt32LE(this.off); this.off += 4; return v }
  u64() { const v = this.b.readBigUInt64LE(this.off); this.off += 8; return v }
  i64() { const v = this.b.readBigInt64LE(this.off); this.off += 8; return v }
  dbl() { const v = this.b.readDoubleLE(this.off); this.off += 8; return v }
  bytes(n: number) { const v = this.b.subarray(this.off, this.off + n); this.off += n; return v }
  skip(n: number) { this.off += n }
}
function decObject(r: Reader): unknown {
  const t = r.u32()
  switch (t) {
    case T_NULL: return null
    case T_BOOL: return r.u32() !== 0
    case T_INT64: return r.i64()
    case T_UINT64: return r.u64()
    case T_DOUBLE: return r.dbl()
    case T_DATA: { const l = r.u32(); const b = Buffer.from(r.bytes(l)); r.skip(pad4(l)); return b }
    case T_STRING: { const l = r.u32(); const s = r.bytes(l); r.skip(pad4(l)); return s.subarray(0, l - 1).toString("utf8") }
    case T_UUID: return Buffer.from(r.bytes(16)).toString("hex")
    case T_ARRAY: { r.u32(); const n = r.u32(); const a: unknown[] = []; for (let i = 0; i < n; i++) a.push(decObject(r)); return a }
    case T_DICT: {
      r.u32(); const n = r.u32(); const d: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) {
        const start = r.off
        while (r.b[r.off] !== 0) r.off++
        const key = r.b.subarray(start, r.off).toString("utf8"); r.off++
        r.skip(pad4(r.off - start)); d[key] = decObject(r)
      }
      return d
    }
    default: throw new Error(`decObject: unknown type 0x${t.toString(16)} at off ${r.off - 4}`)
  }
}
export function tryDecodeWrapper(buf: Buffer): { flags: number; msgId: number; body: Record<string, unknown> | null; consumed: number } | null {
  if (buf.length < 24) return null
  const bodyLen = Number(buf.readBigUInt64LE(8))
  const need = 24 + bodyLen
  if (buf.length < need) return null
  const flags = buf.readUInt32LE(4)
  const msgId = Number(buf.readBigUInt64LE(16))
  if (bodyLen === 0) return { flags, msgId, body: null, consumed: need }
  const r = new Reader(buf.subarray(24, need)); r.u32(); r.u32()
  return { flags, msgId, body: decObject(r) as Record<string, unknown>, consumed: need }
}

/** Empty inbound wrapper with WANTING_REPLY set: answer it, do not hand it to request waiters. */
export function isXpcEmptyHeartbeatRequest(flags: number, body: Record<string, unknown> | null): boolean {
  if ((flags & F_HEARTBEAT_REQ) === 0) return false
  if ((flags & F_HEARTBEAT_REPLY) !== 0) return false
  if ((flags & F_INIT) !== 0) return false
  if ((flags & F_TERMINATOR) !== 0) return false
  if (body == null) return true
  return (flags & F_DATA) === 0 && Object.keys(body).length === 0
}

export function encodeXpcHeartbeatReply(msgId: number): Buffer {
  return encodeWrapper(null, F_ALWAYS | F_HEARTBEAT_REPLY, msgId)
}

// ── HTTP/2 minimal framing (from rsd.ts) ──────────────────────────────────────
const H2_MAGIC = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
export const FT_DATA = 0x0, FT_HEADERS = 0x1, FT_RST = 0x3, FT_SETTINGS = 0x4, FT_PING = 0x6, FT_GOAWAY = 0x7, FT_WINDOW_UPDATE = 0x8
export function h2frame(type: number, flags: number, streamId: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(9); h.writeUIntBE(payload.length, 0, 3); h.writeUInt8(type, 3); h.writeUInt8(flags, 4); h.writeUInt32BE(streamId >>> 0, 5)
  return Buffer.concat([h, payload])
}
function settingsFrame(s: [number, number][]): Buffer {
  const p = Buffer.alloc(s.length * 6); s.forEach(([id, v], i) => { p.writeUInt16BE(id, i * 6); p.writeUInt32BE(v >>> 0, i * 6 + 2) }); return h2frame(FT_SETTINGS, 0, 0, p)
}
function windowUpdate(streamId: number, incr: number): Buffer { const p = Buffer.alloc(4); p.writeUInt32BE(incr >>> 0, 0); return h2frame(FT_WINDOW_UPDATE, 0, streamId, p) }
export const ROOT = 1, REPLY = 3

// A RemoteXPC "service" connection over one TCP chan: 2 H2 streams (1=cs, 3=sc),
// the per-service init handshake, then send()/receive() XPC dicts. Mirrors
// go-ios ios/http + ios/xpc CreateXpcConnection/initializeXpcConnection.
export class XpcService {
  private inbound = Buffer.alloc(0)
  private csBuf = Buffer.alloc(0)   // stream 1 XPC bytes
  private scBuf = Buffer.alloc(0)   // stream 3 XPC bytes
  private csWaiters: Array<(m: any) => void> = []
  private scWaiters: Array<(m: any) => void> = []
  private csPend: any[] = []; private scPend: any[] = []
  private csHeadersSent = false; private scHeadersSent = false
  private msgId = 1
  private rxBytes = 0
  constructor(private chan: TcpChan, private tag: string) {
    chan.onData((c) => this.onData(c))
  }
  private onData(chunk: Buffer) {
    this.inbound = Buffer.concat([this.inbound, chunk])
    while (this.inbound.length >= 9) {
      const len = this.inbound.readUIntBE(0, 3)
      if (this.inbound.length < 9 + len) break
      const type = this.inbound[3], flags = this.inbound[4], sid = this.inbound.readUInt32BE(5) & 0x7fffffff
      const payload = this.inbound.subarray(9, 9 + len); this.inbound = this.inbound.subarray(9 + len)
      if (DBG) console.error(`[${this.tag}] H2 type=${type} flags=0x${flags.toString(16)} stream=${sid} len=${len}`)
      if (type === FT_SETTINGS) { if (!(flags & 0x1)) this.chan.write(h2frame(FT_SETTINGS, 0x1, 0, Buffer.alloc(0))) }
      else if (type === FT_PING) { if (!(flags & 0x1)) this.chan.write(h2frame(FT_PING, 0x1, 0, Buffer.from(payload))) }
      else if (type === FT_GOAWAY) { if (DBG) console.error(`[${this.tag}] GOAWAY ${payload.toString("hex")}`) }
      else if (type === FT_RST) { if (DBG) console.error(`[${this.tag}] RST stream ${sid} ${payload.toString("hex")}`) }
      else if (type === FT_DATA) {
        // replenish flow-control so large multi-frame replies never stall
        this.rxBytes += len
        if (this.rxBytes >= 512 * 1024) { this.chan.write(windowUpdate(0, this.rxBytes)); this.chan.write(windowUpdate(sid, this.rxBytes)); this.rxBytes = 0 }
        if (sid === ROOT) { this.csBuf = Buffer.concat([this.csBuf, payload]); this.drain("cs") }
        else if (sid === REPLY) { this.scBuf = Buffer.concat([this.scBuf, payload]); this.drain("sc") }
      }
    }
  }
  private drain(which: "cs" | "sc") {
    const bufName = which === "cs" ? "csBuf" : "scBuf"
    let dec = tryDecodeWrapper((this as any)[bufName])
    while (dec) {
      ;(this as any)[bufName] = (this as any)[bufName].subarray(dec.consumed)
      if (isXpcEmptyHeartbeatRequest(dec.flags, dec.body)) {
        if (DBG) console.error(`[${this.tag}] heartbeat req msgId=${dec.msgId} on ${which}`)
        // Device-originated empty WANTING_REPLY. Answer on the opposite H2
        // stream (cs↔sc) and do not deliver to request waiters — a pending
        // app.request() would otherwise take the keepalive as its reply.
        this.writeStream(which === "cs" ? REPLY : ROOT, encodeXpcHeartbeatReply(dec.msgId))
        dec = tryDecodeWrapper((this as any)[bufName])
        continue
      }
      const m = { flags: dec.flags, msgId: dec.msgId, body: dec.body }
      if (DBG) console.error(`[${this.tag}] <${which} flags=0x${dec.flags.toString(16)} msgId=${dec.msgId} keys=${dec.body ? Object.keys(dec.body).join(",") : "∅"}`)
      // advance our send counter past the reply's message id (device tracks it per stream)
      if (dec.msgId >= this.msgId) this.msgId = dec.msgId + 1
      const waiters = which === "cs" ? this.csWaiters : this.scWaiters
      const pend = which === "cs" ? this.csPend : this.scPend
      const w = waiters.shift(); if (w) w(m); else pend.push(m)
      dec = tryDecodeWrapper((this as any)[bufName])
    }
  }
  private recv(which: "cs" | "sc", timeoutMs = 8000): Promise<{ flags: number; body: any }> {
    const pend = which === "cs" ? this.csPend : this.scPend
    if (pend.length) return Promise.resolve(pend.shift())
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`[${this.tag}] timeout waiting on ${which}`)), timeoutMs)
      const waiters = which === "cs" ? this.csWaiters : this.scWaiters
      waiters.push((m) => { clearTimeout(t); res(m) })
    })
  }
  private writeStream(sid: number, xpc: Buffer) {
    if (sid === ROOT && !this.csHeadersSent) { this.chan.write(h2frame(FT_HEADERS, 0x4, ROOT, Buffer.alloc(0))); this.csHeadersSent = true }
    if (sid === REPLY && !this.scHeadersSent) { this.chan.write(h2frame(FT_HEADERS, 0x4, REPLY, Buffer.alloc(0))); this.scHeadersSent = true }
    this.chan.write(h2frame(FT_DATA, 0, sid, xpc))
  }
  // Full per-service RemoteXPC handshake, frame order exactly as devicectl /
  // pymobiledevice3 emit it. The daemon rejects (silently drops later requests)
  // if HEADERS#3 doesn't precede the ROOT 0x0201 terminator.
  async handshake() {
    this.chan.write(H2_MAGIC)
    this.chan.write(settingsFrame([[0x3, 100], [0x4, 1048576]]))
    this.chan.write(windowUpdate(0, 983041))
    this.chan.write(h2frame(FT_HEADERS, 0x4, ROOT, Buffer.alloc(0))); this.csHeadersSent = true
    // Data#1: empty dict, msgId 0, NOT wanting reply
    this.chan.write(h2frame(FT_DATA, 0, ROOT, encodeWrapper({}, F_ALWAYS, 0)))
    // Headers#3
    this.chan.write(h2frame(FT_HEADERS, 0x4, REPLY, Buffer.alloc(0))); this.scHeadersSent = true
    // Data#1: ROOT terminator flags 0x0201
    this.chan.write(h2frame(FT_DATA, 0, ROOT, encodeWrapper(null, 0x0201, 0)))
    // Data#3: INIT_HANDSHAKE on REPLY
    this.chan.write(h2frame(FT_DATA, 0, REPLY, encodeWrapper(null, F_INIT | F_ALWAYS, 0)))
    // drain the device's handshake echoes (empty dict reply on cs, init reply on sc)
    await this.recv("cs", 3000).catch(() => {})
    await this.recv("cs", 1000).catch(() => {})
    await this.recv("sc", 3000).catch(() => {})
    // messages start at id 1
    this.msgId = 1
  }
  // Send a request dict on cs, read the reply on sc (go-ios ReceiveOnServerClientStream).
  async request(dict: Record<string, unknown>, extraFlags = 0, timeoutMs = 8000): Promise<any> {
    const id = this.msgId++
    let f = F_ALWAYS | F_DATA | extraFlags
    this.writeStream(ROOT, encodeWrapper(dict, f, id))
    const m = await this.recv("sc", timeoutMs)
    return m.body
  }
  // race both streams (diagnostic)
  async requestEither(dict: Record<string, unknown>, extraFlags = 0): Promise<{ which: string; body: any }> {
    const id = this.msgId++
    this.writeStream(ROOT, encodeWrapper(dict, F_ALWAYS | F_DATA | extraFlags, id))
    return Promise.race([
      this.recv("sc").then((m) => ({ which: "sc", body: m.body })),
      this.recv("cs").then((m) => ({ which: "cs", body: m.body })),
    ])
  }
}

// ── DTX codec (validated against daemon/ios/testmanagerd.ts + go-ios) ─────────
const DTX_MAGIC = 0x795b3d1f
const t_null = 0x0a, t_string = 0x01, t_bytearray = 0x02, t_uint32 = 0x03, t_int64 = 0x06
// Auxiliary (DTXPrimitiveDictionary): [null-key, value] pairs.
class AuxEncoder {
  private parts: Buffer[] = []
  addNull() { const b = Buffer.alloc(4); b.writeUInt32LE(t_null, 0); this.parts.push(b) }
  addInt32(v: number) { this.addNull(); const b = Buffer.alloc(8); b.writeUInt32LE(t_uint32, 0); b.writeInt32LE(v, 4); this.parts.push(b) }
  addBytes(data: Buffer) { this.addNull(); const h = Buffer.alloc(8); h.writeUInt32LE(t_bytearray, 0); h.writeUInt32LE(data.length, 4); this.parts.push(h, data) }
  addArchived(obj: PlistNode) { this.addBytes(nskeyedArchive(obj)) }
  bytes() { return Buffer.concat(this.parts) }
}
function encodeDtx(identifier: number, conversationIndex: number, channelCode: number, expectsReply: boolean, messageType: number, payload: Buffer, aux: Buffer): Buffer {
  const auxSize = aux.length, payLen = payload.length
  let messageLength = 16 + auxSize + payLen
  if (auxSize > 0) messageLength += 16
  const msg = Buffer.alloc(32 + messageLength)
  msg.writeUInt32BE(DTX_MAGIC, 0)          // magic BIG-endian on wire (1f 3d 5b 79)
  msg.writeUInt32LE(32, 4)
  msg.writeUInt16LE(0, 8); msg.writeUInt16LE(1, 10)
  msg.writeUInt32LE(messageLength, 12)
  msg.writeUInt32LE(identifier >>> 0, 16)
  msg.writeUInt32LE(conversationIndex >>> 0, 20)
  msg.writeUInt32LE(channelCode >>> 0, 24)
  msg.writeUInt32LE(expectsReply ? 1 : 0, 28)
  // payload header @32: type, auxLenWithHeader, totalPayloadLen(=payLen+auxLenWithHeader), flags
  const auxLenWithHeader = auxSize > 0 ? auxSize + 16 : 0
  msg.writeUInt32LE(messageType, 32)
  msg.writeUInt32LE(auxLenWithHeader, 36)
  msg.writeUInt32LE(payLen + auxLenWithHeader, 40)
  msg.writeUInt32LE(0, 44)
  if (auxSize === 0) { payload.copy(msg, 48) }
  else {
    // aux header @48: bufferSize(496), 0, auxSize, 0
    msg.writeUInt32LE(496, 48); msg.writeUInt32LE(0, 52); msg.writeUInt32LE(auxSize, 56); msg.writeUInt32LE(0, 60)
    aux.copy(msg, 64); payload.copy(msg, 64 + auxSize)
  }
  return msg
}
export type DtxMsg = {
  fragments: number; fragmentIndex: number; messageLength: number
  identifier: number; conversationIndex: number; channelCode: number; expectsReply: boolean
  msgType: number; auxLen: number; totalPayloadLen: number
  aux: Buffer; payloadRaw: Buffer
}
function decodeDtx(buf: Buffer): { msg: DtxMsg; consumed: number } | null {
  if (buf.length < 32) return null
  if (buf.readUInt32BE(0) !== DTX_MAGIC) throw new Error(`DTX bad magic ${buf.subarray(0, 4).toString("hex")}`)
  const messageLength = buf.readUInt32LE(12)
  const fragmentIndex = buf.readUInt16LE(8), fragments = buf.readUInt16LE(10)
  const identifier = buf.readUInt32LE(16), conversationIndex = buf.readUInt32LE(20)
  const channelCode = buf.readInt32LE(24), expectsReply = buf.readUInt32LE(28) === 1
  // first fragment of a multi-part message is header-only
  if (fragments > 1 && fragmentIndex === 0) {
    return { msg: { fragments, fragmentIndex, messageLength, identifier, conversationIndex, channelCode, expectsReply, msgType: -1, auxLen: 0, totalPayloadLen: 0, aux: Buffer.alloc(0), payloadRaw: Buffer.alloc(0) }, consumed: 32 }
  }
  const total = 32 + messageLength
  if (buf.length < total) return null
  // Mid/last fragment of a multi-fragment message: the bytes after the 32-byte
  // routing header are a RAW payload chunk — there is NO per-fragment payload
  // header (only the reassembled whole has one). Hand back the chunk as
  // payloadRaw; handle() concatenates chunks then parses the real header.
  if (fragments > 1 && fragmentIndex > 0) {
    return { msg: { fragments, fragmentIndex, messageLength, identifier, conversationIndex, channelCode, expectsReply, msgType: -1, auxLen: 0, totalPayloadLen: 0, aux: Buffer.alloc(0), payloadRaw: Buffer.from(buf.subarray(32, total)) }, consumed: total }
  }
  const msgType = buf.readUInt32LE(32)
  const auxLen = buf.readUInt32LE(36)          // includes 16-byte aux header when >0
  const totalPayloadLen = buf.readUInt32LE(40)
  let aux = Buffer.alloc(0), payloadRaw = Buffer.alloc(0)
  if (auxLen > 0) { aux = Buffer.from(buf.subarray(64, 48 + auxLen)) }
  const payStart = auxLen > 0 ? 48 + auxLen : 48
  const payLen = totalPayloadLen - auxLen
  if (payLen > 0) payloadRaw = Buffer.from(buf.subarray(payStart, payStart + payLen))
  return { msg: { fragments, fragmentIndex, messageLength, identifier, conversationIndex, channelCode, expectsReply, msgType, auxLen, totalPayloadLen, aux, payloadRaw }, consumed: total }
}
// Reassemble a fragmented DTX message: `full` is the concatenated payload chunks
// (fragments 1..N-1), which begins with the 16-byte DTXMessagePayloadHeader. Mirrors
// decodeDtx's non-fragmented payload slicing but relative to the payload start.
function reassembleDtxPayload(full: Buffer, routing: DtxMsg): DtxMsg {
  const msgType = full.readUInt32LE(0)
  const auxLen = full.readUInt32LE(4)          // includes 16-byte aux header when >0
  const totalPayloadLen = full.readUInt32LE(8)
  let aux = Buffer.alloc(0), payloadRaw = Buffer.alloc(0)
  if (auxLen > 0) aux = Buffer.from(full.subarray(32, 16 + auxLen))
  const payStart = auxLen > 0 ? 16 + auxLen : 16
  const payLen = totalPayloadLen - auxLen
  if (payLen > 0) payloadRaw = Buffer.from(full.subarray(payStart, payStart + payLen))
  return { ...routing, msgType, auxLen, totalPayloadLen, aux, payloadRaw }
}

// parse aux primitive dict -> ordered list of {type, value}
export function parseAux(aux: Buffer): Array<{ type: number; value: Buffer | number }> {
  const out: Array<{ type: number; value: Buffer | number }> = []
  let o = 0
  while (o + 4 <= aux.length) {
    const t = aux.readUInt32LE(o); o += 4
    if (t === t_null) continue
    if (t === t_uint32) { out.push({ type: t, value: aux.readUInt32LE(o) }); o += 4; continue }
    if (t === t_int64) { out.push({ type: t, value: Number(aux.readBigUInt64LE(o)) }); o += 8; continue }
    if (t === t_bytearray || t === t_string) { const l = aux.readUInt32LE(o); o += 4; out.push({ type: t, value: aux.subarray(o, o + l) }); o += l; continue }
    break
  }
  return out
}

// ── NSKeyedArchiver via plutil (XML object graph -> binary plist) ─────────────
export type PlistNode =
  | { str: string } | { int: number | bigint } | { real: number } | { bool: boolean }
  | { data: Buffer } | { uuid: Buffer } | { dict: Record<string, PlistNode> } | { arr: PlistNode[] }
  | { url: string } | { nul: true } | { obj: { cls: string; props: Record<string, PlistNode> } }
  | { xctcaps: Record<string, PlistNode> }
function xmlEscape(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
export function nskeyedArchive(n: PlistNode): Buffer {
  return buildArchiveOffset(n)
}
// Build objects with a leading $null already accounted for.
function buildArchiveOffset(n: PlistNode): Buffer {
  const objects: string[] = ["<string>$null</string>"]
  const idx = archiveNodeAbs(n, objects)
  const uidRef = (i: number) => `<dict><key>CF$UID</key><integer>${i}</integer></dict>`
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>$archiver</key><string>NSKeyedArchiver</string>
<key>$version</key><integer>100000</integer>
<key>$top</key><dict><key>root</key>${uidRef(idx)}</dict>
<key>$objects</key><array>${objects.join("")}</array>
</dict></plist>`
  return plutilToBinary(Buffer.from(xml, "utf8"))
}
// archiveNodeAbs: indices are absolute into `objects` (which already has $null at 0).
function archiveNodeAbs(n: PlistNode, objects: string[]): number {
  const uidRef = (i: number) => `<dict><key>CF$UID</key><integer>${i}</integer></dict>`
  const push = (xml: string) => { const i = objects.length; objects.push(xml); return i }
  const inlineValue = (value: PlistNode): string => {
    if ("str" in value) return `<string>${xmlEscape(value.str)}</string>`
    if ("int" in value) return `<integer>${value.int}</integer>`
    if ("real" in value) return `<real>${value.real}</real>`
    if ("bool" in value) return value.bool ? "<true/>" : "<false/>"
    if ("data" in value) return `<data>${value.data.toString("base64")}</data>`
    if ("nul" in (value as any)) return uidRef(0)
    return uidRef(archiveNodeAbs(value, objects))
  }
  if ("str" in n) return push(`<string>${xmlEscape(n.str)}</string>`)
  if ("int" in n) return push(`<integer>${n.int}</integer>`)
  if ("real" in n) return push(`<real>${n.real}</real>`)
  if ("bool" in n) return push(n.bool ? "<true/>" : "<false/>")
  if ("data" in n) return push(`<data>${n.data.toString("base64")}</data>`)
  if ("uuid" in n) {
    const idx = push("PLACEHOLDER")
    const cls = push(`<dict><key>$classes</key><array><string>NSUUID</string><string>NSObject</string></array><key>$classname</key><string>NSUUID</string></dict>`)
    objects[idx] = `<dict><key>$class</key>${uidRef(cls)}<key>NS.uuidbytes</key><data>${(n as any).uuid.toString("base64")}</data></dict>`
    return idx
  }
  if ("xctcaps" in (n as any)) {
    const dictRef = archiveNodeAbs({ dict: (n as any).xctcaps }, objects)
    const idx = push("PLACEHOLDER")
    const cls = push(`<dict><key>$classes</key><array><string>XCTCapabilities</string><string>NSObject</string></array><key>$classname</key><string>XCTCapabilities</string></dict>`)
    objects[idx] = `<dict><key>$class</key>${uidRef(cls)}<key>capabilities-dictionary</key>${uidRef(dictRef)}</dict>`
    return idx
  }
  if ("nul" in (n as any)) return 0  // reference to objects[0] = "$null"
  if ("url" in (n as any)) {
    const relRef = archiveNodeAbs({ str: (n as any).url }, objects)
    const idx = push("PLACEHOLDER")
    const cls = push(`<dict><key>$classes</key><array><string>NSURL</string><string>NSObject</string></array><key>$classname</key><string>NSURL</string></dict>`)
    objects[idx] = `<dict><key>$class</key>${uidRef(cls)}<key>NS.base</key>${uidRef(0)}<key>NS.relative</key>${uidRef(relRef)}</dict>`
    return idx
  }
  if ("obj" in (n as any)) {
    const o = (n as any).obj as { cls: string; props: Record<string, PlistNode> }
    const idx = push("PLACEHOLDER")
    const cls = push(`<dict><key>$classes</key><array><string>${o.cls}</string><string>NSObject</string></array><key>$classname</key><string>${o.cls}</string></dict>`)
    const parts = [`<key>$class</key>${uidRef(cls)}`]
    const xctConfigObjectKeys = new Set([
      "aggregateStatisticsBeforeCrash", "automationFrameworkPath", "productModuleName", "sessionIdentifier",
      "targetApplicationBundleID", "targetApplicationPath", "testBundleURL", "testsToRun", "testsToSkip",
      "testIdentifiersToRun", "testIdentifiersToSkip", "IDECapabilities",
    ])
    for (const k of Object.keys(o.props)) {
      const value = o.cls === "XCTestConfiguration" && !xctConfigObjectKeys.has(k)
        ? inlineValue(o.props[k])
        : uidRef(archiveNodeAbs(o.props[k], objects))
      parts.push(`<key>${xmlEscape(k)}</key>${value}`)
    }
    objects[idx] = `<dict>${parts.join("")}</dict>`
    return idx
  }
  if ("arr" in n) {
    const idx = push("PLACEHOLDER")
    const cls = push(`<dict><key>$classes</key><array><string>NSArray</string><string>NSObject</string></array><key>$classname</key><string>NSArray</string></dict>`)
    const refs = (n as any).arr.map((c: PlistNode) => archiveNodeAbs(c, objects))
    objects[idx] = `<dict><key>$class</key>${uidRef(cls)}<key>NS.objects</key><array>${refs.map(uidRef).join("")}</array></dict>`
    return idx
  }
  const idx = push("PLACEHOLDER")
  const cls = push(`<dict><key>$classes</key><array><string>NSDictionary</string><string>NSObject</string></array><key>$classname</key><string>NSDictionary</string></dict>`)
  const keys = Object.keys((n as any).dict)
  const keyRefs = keys.map((k) => archiveNodeAbs({ str: k }, objects))
  const valRefs = keys.map((k) => archiveNodeAbs((n as any).dict[k], objects))
  objects[idx] = `<dict><key>$class</key>${uidRef(cls)}<key>NS.keys</key><array>${keyRefs.map(uidRef).join("")}</array><key>NS.objects</key><array>${valRefs.map(uidRef).join("")}</array></dict>`
  return idx
}
function plutilToBinary(xml: Buffer): Buffer {
  return execFileSync("plutil", ["-convert", "binary1", "-o", "-", "-"], { input: xml, maxBuffer: 64 * 1024 * 1024 })
}

/** go-ios appservice UI-test launch flags. An empty dict leaves the runner unable to background (XCTest 10300). */
export function uiTestPlatformSpecificOptionsXml(): string {
  return `<?xml version="1.0"?><plist version="1.0"><dict>` +
    `<key>ActivateSuspended</key><integer>1</integer>` +
    `<key>StartSuspendedKey</key><integer>0</integer>` +
    `<key>__ActivateSuspended</key><integer>1</integer>` +
    `</dict></plist>`
}
function plutilToXml(bin: Buffer): string {
  try { return execFileSync("plutil", ["-convert", "xml1", "-o", "-", "-"], { input: bin, maxBuffer: 64 * 1024 * 1024 }).toString("utf8") }
  catch { return "<plutil decode failed>" }
}

// ── a DTX channel abstraction over a raw TCP chan ─────────────────────────────
const DTX_METHODINVOCATION = 0x2, DTX_ACK = 0x0, DTX_RESPONSE = 0x3, DTX_ERROR = 0x4
export class DtxConnection {
  private inbound = Buffer.alloc(0)
  private frags = new Map<number, Buffer[]>()   // identifier -> collected fragment bodies
  private globalMsgId = 5
  private channelCodeCounter = 1
  private replyWaiters = new Map<string, (m: DtxMsg) => void>()  // `${chan}:${id}` -> cb
  private requestChannelQueue: DtxMsg[] = []
  private requestChannelWaiters: Array<(m: DtxMsg) => void> = []
  // Incoming method-call handlers (device/runner -> us). Return a PlistNode to send
  // a DTX RESPONSE (e.g. _XCT_testRunnerReadyWithCapabilities: -> XCTestConfiguration).
  private handlers = new Map<string, (m: DtxMsg) => PlistNode | null | void>()
  onCall(selector: string, fn: (m: DtxMsg) => PlistNode | null | void): void { this.handlers.set(selector, fn) }
  // Per-channel raw-message listeners for streaming services (e.g. Instruments
  // sysmontap/graphics push samples as unsolicited channel frames). Registered
  // AFTER the setup calls resolve, so it never swallows a channelCall reply.
  private channelListeners = new Map<number, (m: DtxMsg) => void>()
  onChannelMessage(code: number, cb: (m: DtxMsg) => void): void { this.channelListeners.set(code, cb) }
  offChannelMessage(code: number): void { this.channelListeners.delete(code) }
  // Broadcast listener for services that push unsolicited samples on the device's
  // OWN channel (Instruments sysmontap/graphics stream on channelCode -1, NOT the
  // requested channel). Returns true if it consumed the frame. Registered only
  // while streaming (after setup resolves), so it never eats a pending reply.
  private broadcast?: (m: DtxMsg) => boolean
  onBroadcast(cb: (m: DtxMsg) => boolean): void { this.broadcast = cb }
  offBroadcast(): void { this.broadcast = undefined }
  constructor(private chan: TcpChan, private tag: string) {
    chan.onData((c) => this.onData(c))
  }
  /** Release the underlying channel. */
  close(): void { try { this.chan.close() } catch {} }
  private onData(chunk: Buffer) {
    this.inbound = Buffer.concat([this.inbound, chunk])
    let dec = decodeDtx(this.inbound)
    while (dec) {
      this.inbound = this.inbound.subarray(dec.consumed)
      this.handle(dec.msg)
      dec = this.inbound.length ? decodeDtx(this.inbound) : null
    }
  }
  private handle(m: DtxMsg) {
    // reassemble fragments: fragment 0 is header-only; fragments 1..N-1 each carry a
    // raw payload chunk. Concatenate the chunks, then parse the single payload header
    // (msgType/auxLen/totalPayloadLen) out of the reassembled whole.
    if (m.fragments > 1) {
      if (m.fragmentIndex === 0) { this.frags.set(m.identifier, []); if (m.expectsReply) this.sendAck(m); return }
      const list = this.frags.get(m.identifier)
      if (list) {
        list.push(m.payloadRaw)
        if (m.fragments - m.fragmentIndex === 1) { this.frags.delete(m.identifier); m = reassembleDtxPayload(Buffer.concat(list), m) }
        else return
      }
    }
    // Streaming channel listener (sysmontap/graphics): consume every frame on a
    // listened non-global channel. Only set while streaming, so no call replies race it.
    if (m.channelCode !== 0) {
      const cl = this.channelListeners.get(m.channelCode)
      if (cl) { cl(m); if (m.expectsReply) this.sendAck(m); return }
    }
    // Broadcast: Instruments streams samples on the device's push channel (-1),
    // not the requested channel. Give a registered broadcast first refusal on any
    // non-global frame; if it consumes, we're done.
    if (m.channelCode !== 0 && this.broadcast) {
      if (this.broadcast(m)) { if (m.expectsReply) this.sendAck(m); return }
    }
    if (DBG) {
      const tName = { 0: "Ack", 2: "Invoke", 3: "Response", 4: "Error" }[m.msgType] ?? `t${m.msgType}`
      console.error(`[${this.tag}] <DTX c${m.channelCode} i${m.identifier}.${m.conversationIndex} ${tName} auxLen=${m.auxLen} payLen=${m.totalPayloadLen - m.auxLen}${m.expectsReply ? " e" : ""}`)
    }
    // A reply to one of our calls (conversationIndex>0 or a Response/Error) — resolve; no ack.
    if (m.conversationIndex > 0 || m.msgType === DTX_RESPONSE || m.msgType === DTX_ERROR) {
      const key = `${m.channelCode}:${m.identifier}`
      const w = this.replyWaiters.get(key)
      if (w) { this.replyWaiters.delete(key); w(m); return }
      for (const [k, cb] of this.replyWaiters) {
        if (k.endsWith(`:${m.identifier}`)) { this.replyWaiters.delete(k); cb(m); return }
      }
      return
    }
    // Incoming method invocation from the device/runner.
    if (m.msgType === DTX_METHODINVOCATION && m.payloadRaw.length) {
      const sel = this.decodeSelector(m.payloadRaw)
      if (sel === "_requestChannelWithCode:identifier:") {
        const w = this.requestChannelWaiters.shift()
        if (w) w(m); else this.requestChannelQueue.push(m)
        if (m.expectsReply) this.sendAck(m)
        return
      }
      const h = sel ? this.handlers.get(sel) : undefined
      if (h) {
        const ret = h(m)
        if (ret != null) this.sendResponse(m, ret)
        else if (m.expectsReply) this.sendAck(m)
        if (DBG) console.error(`[${this.tag}] handled incoming ${sel}${ret != null ? " (responded)" : ""}`)
        return
      }
      if (DBG && sel) console.error(`[${this.tag}] incoming (unhandled) ${sel}`)
    }
    if (m.expectsReply) this.sendAck(m)
  }
  private sendResponse(m: DtxMsg, value: PlistNode) {
    const payload = nskeyedArchive(value)
    const msg = encodeDtx(m.identifier, m.conversationIndex + 1, m.channelCode, false, DTX_RESPONSE, payload, Buffer.alloc(0))
    this.chan.write(msg)
  }
  private decodeSelector(payload: Buffer): string | null {
    try {
      const xml = plutilToXml(payload)
      const m = xml.match(/<string>([^<]+)<\/string>/g)
      // in an archived NSString the last $objects string is the value
      if (m && m.length) { const last = m[m.length - 1].replace(/<\/?string>/g, ""); return last }
    } catch {}
    return null
  }
  private decodeChannelRequest(m: DtxMsg): { requestedCode?: number; identifier?: string } {
    const args = parseAux(m.aux)
    const requestedCode = typeof args[0]?.value === "number" ? args[0].value : undefined
    const identifier = Buffer.isBuffer(args[1]?.value) ? this.decodeSelector(args[1].value) ?? undefined : undefined
    return { requestedCode, identifier }
  }
  private sendAck(m: DtxMsg) {
    const ack = Buffer.alloc(48)
    ack.writeUInt32BE(DTX_MAGIC, 0); ack.writeUInt32LE(32, 4); ack.writeUInt16LE(0, 8); ack.writeUInt16LE(1, 10)
    ack.writeUInt32LE(16, 12); ack.writeUInt32LE(m.identifier, 16); ack.writeUInt32LE(m.conversationIndex + 1, 20)
    ack.writeUInt32LE(m.channelCode >>> 0, 24); ack.writeUInt32LE(0, 28)
    ack.writeUInt32LE(DTX_ACK, 32)
    this.chan.write(ack)
  }
  // Send a method call on a channel, await the reply message.
  private async call(channelCode: number, identifier: number, selector: string, args: PlistNode[], expectReply: boolean): Promise<DtxMsg | null> {
    const payload = nskeyedArchive({ str: selector })
    const aux = new AuxEncoder()
    for (const a of args) aux.addArchived(a)
    const msg = encodeDtx(identifier, 0, channelCode, expectReply, DTX_METHODINVOCATION, payload, aux.bytes())
    if (DBG) console.error(`[${this.tag}] >DTX c${channelCode} i${identifier} call ${selector} (${args.length} args)${expectReply ? " e" : ""}`)
    if (!expectReply) { this.chan.write(msg); return null }
    return new Promise((resolve, reject) => {
      const key = `${channelCode}:${identifier}`
      const t = setTimeout(() => { this.replyWaiters.delete(key); reject(new Error(`[${this.tag}] timeout on ${selector}`)) }, 15000)
      this.replyWaiters.set(key, (m) => { clearTimeout(t); resolve(m) })
      this.chan.write(msg)
    })
  }
  // global-channel method call (channel 0), auto-incrementing global id.
  async globalCall(selector: string, args: PlistNode[]): Promise<DtxMsg | null> {
    const id = this.globalMsgId++
    return this.call(0, id, selector, args, true)
  }
  // Request a channel; returns its assigned channelCode. The reply comes on channel 0.
  async requestChannelIdentifier(identifier: string): Promise<number> {
    const code = this.channelCodeCounter++
    const id = this.globalMsgId++
    const payload = nskeyedArchive({ str: "_requestChannelWithCode:identifier:" })
    const aux = new AuxEncoder()
    aux.addInt32(code)
    aux.addBytes(nskeyedArchive({ str: identifier }))
    const msg = encodeDtx(id, 0, 0, true, DTX_METHODINVOCATION, payload, aux.bytes())
    if (DBG) console.error(`[${this.tag}] >DTX request channel '${identifier}' code=${code} id=${id}`)
    await new Promise<void>((resolve, reject) => {
      const key = `0:${id}`
      const t = setTimeout(() => { this.replyWaiters.delete(key); reject(new Error(`[${this.tag}] timeout requesting channel ${identifier}`)) }, 15000)
      this.replyWaiters.set(key, () => { clearTimeout(t); resolve() })
      this.chan.write(msg)
    })
    return code
  }
  // Open a channel WITHOUT waiting for a reply (the device doesn't reply to the
  // XCTestDriverInterface channel request — go-ios ForChannelRequest is fire-and-forget).
  openChannelNoWait(identifier: string): number {
    const code = this.channelCodeCounter++
    const id = this.globalMsgId++
    const payload = nskeyedArchive({ str: "_requestChannelWithCode:identifier:" })
    const aux = new AuxEncoder(); aux.addInt32(code); aux.addBytes(nskeyedArchive({ str: identifier }))
    this.chan.write(encodeDtx(id, 0, 0, false, DTX_METHODINVOCATION, payload, aux.bytes()))
    return code
  }
  async waitForIncomingChannelRequest(timeoutMs = 30_000): Promise<{ channelCode: number; requestedCode?: number; identifier?: string }> {
    const takeQueued = (): DtxMsg | undefined => this.requestChannelQueue.shift()
    const queued = takeQueued()
    if (queued) return { channelCode: -1, ...this.decodeChannelRequest(queued) }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.requestChannelWaiters.indexOf(waiter)
        if (i >= 0) this.requestChannelWaiters.splice(i, 1)
        reject(new Error(`[${this.tag}] timeout waiting for incoming DTX channel request`))
      }, timeoutMs)
      const waiter = (m: DtxMsg) => {
        clearTimeout(t)
        resolve({ channelCode: -1, ...this.decodeChannelRequest(m) })
      }
      this.requestChannelWaiters.push(waiter)
    })
  }
  // call on an already-open channel with its own id space (start at 1)
  private channelIds = new Map<number, number>()
  async channelCall(channelCode: number, selector: string, args: PlistNode[], expectReply = true): Promise<DtxMsg | null> {
    const id = this.channelIds.get(channelCode) ?? 1
    this.channelIds.set(channelCode, id + 1)
    return this.call(channelCode, id, selector, args, expectReply)
  }
}

// ── minimal lockdown-plist service request over a raw TCP chan ────────────────
// (mobile_image_mounter + installation_proxy shims speak plist-over-tunnel with a
//  4-byte big-endian length prefix, same as usbmux plist services.)
function plistReqFrame(xmlBody: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(xmlBody.length, 0); return Buffer.concat([len, xmlBody])
}
function buildXmlPlist(dict: Record<string, string>): Buffer {
  // tiny string-only plist builder for the requests we need
  let body = ""
  for (const [k, v] of Object.entries(dict)) body += `<key>${k}</key><string>${v}</string>`
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>`, "utf8")
}
async function plistServiceOnce(chan: TcpChan, reqDict: Record<string, string>, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const t = setTimeout(() => reject(new Error("plist service timeout")), timeoutMs)
    chan.onData((c) => {
      buf = Buffer.concat([buf, c])
      if (buf.length >= 4) {
        const l = buf.readUInt32BE(0)
        if (buf.length >= 4 + l) { clearTimeout(t); resolve(buf.subarray(4, 4 + l).toString("utf8")) }
      }
    })
    chan.write(plistReqFrame(buildXmlPlist(reqDict)))
  })
}

// ── main ──────────────────────────────────────────────────────────────────────
// The XCTestConfiguration handed to the runner when it calls back
// _XCT_testRunnerReadyWithCapabilities: (iOS 17 — delivered over DTX, not a file).
function createTestConfig(sessionUuidBytes: Buffer, productModuleName: string, testBundleURL: string): PlistNode {
  const ideCaps: Record<string, PlistNode> = {}
  for (const k of ["expected failure test capability","test case run configurations","test timeout capability","test iterations","request diagnostics for specific devices","delayed attachment transfer","skipped test capability","daemon container sandbox extension","ubiquitous test identifiers","XCTIssue capability"]) ideCaps[k] = { bool: true }
  return { obj: { cls: "XCTestConfiguration", props: {
    aggregateStatisticsBeforeCrash: { dict: { XCSuiteRecordsKey: { dict: {} } } },
    automationFrameworkPath: { str: "/System/Developer/Library/PrivateFrameworks/XCTAutomationSupport.framework" },
    baselineFileRelativePath: { nul: true }, baselineFileURL: { nul: true }, defaultTestExecutionTimeAllowance: { nul: true },
    disablePerformanceMetrics: { bool: false }, emitOSLogs: { bool: false }, gatherLocalizableStringsData: { bool: false },
    initializeForUITesting: { bool: true }, maximumTestExecutionTimeAllowance: { nul: true }, randomExecutionOrderingSeed: { nul: true },
    reportActivities: { bool: true }, reportResultsToIDE: { bool: true }, sessionIdentifier: { uuid: sessionUuidBytes },
    systemAttachmentLifetime: { int: 2 }, testApplicationUserOverrides: { nul: true }, testBundleRelativePath: { nul: true },
    testBundleURL: { url: testBundleURL }, testExecutionOrdering: { int: 0 }, testsDrivenByIDE: { bool: false },
    testsMustRunOnMainThread: { bool: true }, testTimeoutsEnabled: { bool: false }, treatMissingBaselinesAsFailures: { bool: false },
    userAttachmentLifetime: { int: 0 }, preferredScreenCaptureFormat: { int: 2 }, IDECapabilities: { xctcaps: ideCaps },
  } } }
  void productModuleName // hostless UI runner: no app-under-test → productModuleName omitted
}

export async function launchRunnerOverUserspaceTunnel(udid: string, opts: UserspaceLaunchOptions): Promise<UserspaceRunnerHandle> {
  const runnerBundle = opts.bundleId ?? RUNNER_BUNDLE
  const log = opts.log ?? (() => {})
  // 1. tunnel + RSD (shared with the web-inspection device-service broker)
  const { tun, cdp, services } = await openRemoteXpcTunnel(udid, log)
  const port = (name: string) => {
    const p = services[name]; if (!p) throw new Error(`service ${name} not found`); return p
  }

  // 2. DDI mounted?
  try {
    const imChan = await tun.connect(port("com.apple.mobile.mobile_image_mounter.shim.remote"))
    const resp = await plistServiceOnce(imChan, { Command: "LookupImage", ImageType: "Developer" })
    const mounted = /ImageSignature/.test(resp) || /ImagePresent/.test(resp)
    log(`DDI (Developer image) mounted: ${mounted ? "YES" : "no/unknown"} ${DBG ? resp.slice(0, 200) : ""}`)
  } catch (e) { log(`DDI check skipped: ${(e as Error).message}`) }

  // 3. get the runner app path via lockdown installation_proxy (over usbmux — reliable,
  //    unlike the tunnel .shim.remote which uses a different framing).
  const { lookupAppPath } = await import("./installer")
  const runnerAppPath = (await lookupAppPath(udid, runnerBundle)) ?? ""
  log(`Runner app path: ${runnerAppPath || "NOT FOUND"}`)
  if (!runnerAppPath) throw new Error(`runner app ${runnerBundle} is not installed on ${udid}`)
  // iOS 17+ runners accept the config but never schedule tests when the test
  // bundle path is ambiguous. go-ios uses the absolute bundle path in the launch
  // environment and pymobiledevice3 uses an absolute file URL in the config.
  const testBundlePath = `${runnerAppPath}/PlugIns/InterceptorRunner.xctest`
  const testBundleURL = `file://${testBundlePath}`

  // 4. DTX conn #1 -> testmanagerd, capability handshake + IDE session
  const tmPort = port("com.apple.dt.testmanagerd.remote")
  const dtx1 = new DtxConnection(await tun.connect(tmPort), "tm1")
  log("DTX conn #1 open to testmanagerd; waiting for _notifyOfPublishedCapabilities...")
  await new Promise((r) => setTimeout(r, 800)) // let device push its caps + we auto-ack
  const ideChan1 = await dtx1.requestChannelIdentifier("dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface")
  log(`IDE channel #1 opened (code ${ideChan1})`)

  const testSessionID = randomUUID().toUpperCase()
  const sessionUuidBytes = Buffer.from(testSessionID.replace(/-/g, ""), "hex")
  // iOS 17 delivers the XCTestConfiguration over DTX when the runner calls back.
  const testConfig = createTestConfig(sessionUuidBytes, "InterceptorRunner", testBundleURL)
  dtx1.onCall("_XCT_testRunnerReadyWithCapabilities:", () => { log("runner requested config -> sending XCTestConfiguration"); return testConfig })
  const decodeArg0 = (m: any): string => { try { for (const a of parseAux(m.aux)) if (Buffer.isBuffer(a.value)) { const xml = plutilToXml(a.value); const mm = xml.match(/<string>([\s\S]*?)<\/string>/g); if (mm) return mm[mm.length - 1].replace(/<\/?string>/g, "") } } catch {} return "" }
  dtx1.onCall("_XCT_logDebugMessage:", (m) => { const s = decodeArg0(m); if (s.trim()) log(`RUNNER LOG: ${s.slice(0, 240)}`) })
  dtx1.onCall("_XCT_didFinishExecutingTestPlan", () => { log("*** test plan FINISHED ***") })
  dtx1.onCall("_XCT_didBeginExecutingTestPlan", () => { log("*** test plan BEGAN ***") })
  // The runner reports XCUITest init failures here. Error 10300 ("Failed to
  // background test runner within 30.0s") happens when the screen is locked
  // OR when appservice launched the runner without UI-test activation flags.
  dtx1.onCall("_XCT_initializationForUITestingDidFailWithError:", (m) => {
    const err = decodeArg0(m)
    log(`*** UI-TESTING INIT FAILED: ${err.slice(0, 220)} ***`)
    if (/background test runner|\b10300\b/i.test(err)) {
      log("HINT: XCUITest could not background the runner within 30s. Unlock the iPhone and set Settings → Display & Brightness → Auto-Lock → Never, then retry.")
    }
  })
  const localCaps: Record<string, PlistNode> = {
    "XCTIssue capability": { int: 1 }, "daemon container sandbox extension": { int: 1 },
    "delayed attachment transfer": { int: 1 }, "expected failure test capability": { int: 1 },
    "request diagnostics for specific devices": { int: 1 }, "skipped test capability": { int: 1 },
    "test case run configurations": { int: 1 }, "test iterations": { int: 1 },
    "test timeout capability": { int: 1 }, "ubiquitous test identifiers": { int: 1 },
  }
  log("Calling _IDE_initiateSessionWithIdentifier:capabilities:...")
  const initReply = await dtx1.channelCall(ideChan1, "_IDE_initiateSessionWithIdentifier:capabilities:", [
    { uuid: sessionUuidBytes } as any,
    { xctcaps: localCaps } as any,
  ])
  reportReply("initiateSession", initReply, log)

  // Keep conn #2 ready before launching the runner. On recent iOS builds the
  // xctrunner process can exit before a post-launch control session catches up.
  const dtx2 = new DtxConnection(await tun.connect(tmPort), "tm2")
  log("DTX conn #2 open to testmanagerd; waiting for _notifyOfPublishedCapabilities...")
  await new Promise((r) => setTimeout(r, 800))
  const ideChan2 = await dtx2.requestChannelIdentifier("dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface")
  log(`IDE channel #2 opened (code ${ideChan2})`)
  let controlSessionInitiated = false
  try {
    log("Calling _IDE_initiateControlSessionWithCapabilities: before launch...")
    const ctrlReply = await dtx2.channelCall(ideChan2, "_IDE_initiateControlSessionWithCapabilities:", [{ xctcaps: {} } as any])
    reportReply("initiateControlSession", ctrlReply, log)
    controlSessionInitiated = true
  } catch (e) {
    log(`pre-launch control session deferred: ${(e as Error).message}`)
  }

  // 5. appservice launch with env  <-- THE launch + env injection.
  // coredevice's appservice is single-request-per-connection, so each launch
  // attempt opens a fresh appservice + openstdiosocket. SpringBoard refuses to
  // launch while the device is locked, so retry until unlocked.
  const testEnv: Record<string, unknown> = {
    "INTERCEPTOR_WS_URL": opts.env.INTERCEPTOR_WS_URL,
    "INTERCEPTOR_WS_TOKEN": opts.env.INTERCEPTOR_WS_TOKEN,
    "INTERCEPTOR_UDID": opts.env.INTERCEPTOR_UDID,
    "INTERCEPTOR_CONTEXT_ID": opts.env.INTERCEPTOR_CONTEXT_ID,
    // the xctrunner env go-ios sets for iOS17 UI tests:
    "CA_ASSERT_MAIN_THREAD_TRANSACTIONS": "0", "CA_DEBUG_TRANSACTIONS": "0",
    "DYLD_INSERT_LIBRARIES": "/Developer/usr/lib/libMainThreadChecker.dylib",
    "DYLD_FRAMEWORK_PATH": "/System/Developer/Library/Frameworks",
    "DYLD_LIBRARY_PATH": "/System/Developer/usr/lib",
    "MTC_CRASH_ON_REPORT": "1", "NSUnbufferedIO": "YES", "OS_ACTIVITY_DT_MODE": "YES",
    "SQLITE_ENABLE_THREAD_ASSERTIONS": "1",
    "XCTestBundlePath": testBundlePath,
    "XCTestConfigurationFilePath": "", "XCTestManagerVariant": "DDI",
    "XCTestSessionIdentifier": testSessionID,
  }
  const platformOpts = plutilToBinary(Buffer.from(uiTestPlatformSpecificOptionsXml(), "utf8"))

  const logRunnerStdio = (b: Buffer) => {
    const text = b.toString("utf8").replace(/\0/g, "").trim()
    if (!text) return
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) log(`RUNNER STDIO: ${trimmed.slice(0, 300)}`)
    }
  }

  async function attemptLaunch(): Promise<{ pid: number | null; locked: boolean; err?: any; keepAlive?: unknown[] }> {
    const appChan = await tun.connect(port("com.apple.coredevice.appservice"))
    const app = new XpcService(appChan, "appsvc")
    let stdioChan: TcpChan | undefined
    let handedOff = false
    try {
      await app.handshake()
      stdioChan = await tun.connect(port("com.apple.coredevice.openstdiosocket"))
      const chan = stdioChan
      const stdioUuid: Buffer = await new Promise((res, rej) => {
        let acc = Buffer.alloc(0); const t = setTimeout(() => rej(new Error("stdio uuid timeout")), 6000)
        let resolved = false
        chan.onData((c) => {
          acc = Buffer.concat([acc, c])
          if (!resolved && acc.length >= 16) {
            resolved = true
            clearTimeout(t)
            const uuid = acc.subarray(0, 16)
            const rest = acc.subarray(16)
            chan.onData(logRunnerStdio)
            if (rest.length) logRunnerStdio(rest)
            res(uuid)
          }
        })
      })
      const launchReq = coreDeviceRequest(randomUUID(), "com.apple.coredevice.feature.launchapplication", {
        "applicationSpecifier": { "bundleIdentifier": { "_0": runnerBundle } },
        "options": {
          "arguments": [], "environmentVariables": testEnv,
          "platformSpecificOptions": new XData(platformOpts),
          "standardIOUsesPseudoterminals": true, "startStopped": false, "terminateExisting": true,
          "user": { "active": true }, "workingDirectory": null,
        },
        "standardIOIdentifiers": {
          "standardInput": new XUuid(stdioUuid), "standardOutput": new XUuid(stdioUuid), "standardError": new XUuid(stdioUuid),
        },
      })
      const resp = await app.request(launchReq, F_HEARTBEAT_REQ, 30000)
      const pid = extractPid(resp)
      if (pid != null) { handedOff = true; return { pid, locked: false, keepAlive: [appChan, app, stdioChan] } }
      const err = resp?.["CoreDevice.error"] as any
      const ui = err?.userInfoWithNSSecureCoding
      const xml = Buffer.isBuffer(ui) ? plutilToXml(ui) : ""
      return { pid: null, locked: /Locked|unlock/.test(xml), err: { domain: err?.domain, code: err?.code, xml } }
    } finally {
      // Unless the channels were handed off to keepAlive, close them so a locked
      // retry (or a thrown handshake/stdio timeout) can't accumulate half-open
      // tunnel connections in Tun.conns across up to MAX_ATTEMPTS iterations.
      if (!handedOff) {
        try { appChan.close() } catch {}
        try { stdioChan?.close() } catch {}
      }
    }
  }

  log("Launching InterceptorRunner with INTERCEPTOR_* env...")
  const MAX_ATTEMPTS = opts.launchAttempts ?? Number(process.env.LAUNCH_ATTEMPTS ?? 40)
  let pid: number | null = null
  let launchKeepAlive: unknown[] = []
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await attemptLaunch()
    if (r.pid != null) { pid = r.pid; launchKeepAlive = r.keepAlive ?? []; break }
    if (r.locked) {
      if (attempt === 1) log("Device is LOCKED; SpringBoard refuses to launch. Unlock the phone; retrying every 3s...")
      await new Promise((res) => setTimeout(res, 3000)); continue
    }
    log(`LAUNCH DENIED - domain=${r.err?.domain} code=${r.err?.code}`)
    const reasons = (r.err?.xml as string).match(/<string>[^<]*(?:launch|denied|reason|failed)[^<]*<\/string>/gi)
    const reasonText = reasons?.map((s) => s.replace(/<\/?string>/g, "")).join("; ")
    if (reasons) reasons.forEach((s) => log("   " + s.replace(/<\/?string>/g, "")))
    const trustHint = /not been explicitly trusted|Developer App Certificate is not trusted/i.test(r.err?.xml ?? "")
      ? " Trust it on the iPhone: Settings > General > VPN & Device Management > Developer App > Trust."
      : ""
    throw new Error(`runner launch denied by iOS (${r.err?.domain ?? "unknown"} code ${r.err?.code ?? "?"})${reasonText ? `: ${reasonText}` : ""}.${trustHint}`)
  }
  if (pid == null) throw new Error("runner did not launch — device stayed locked")
  log(`*** RUNNER LAUNCHED - PID ${pid} ***`)

  // 6. DTX conn #2: control session + authorize PID + startExecutingTestPlan
  if (!controlSessionInitiated) {
    log("Calling _IDE_initiateControlSessionWithCapabilities: after launch...")
    const ctrlReply = await dtx2.channelCall(ideChan2, "_IDE_initiateControlSessionWithCapabilities:", [{ xctcaps: {} } as any])
    reportReply("initiateControlSession", ctrlReply, log)
    controlSessionInitiated = true
  }
  log(`Calling _IDE_authorizeTestSessionWithProcessID:${pid}...`)
  const authReply = await dtx2.channelCall(ideChan2, "_IDE_authorizeTestSessionWithProcessID:", [{ int: pid } as any])
  reportReply("authorizeTestSession", authReply, log)

  // The runner opens the XCTestDriverInterface reverse channel after it is
  // authorized. go-ios binds that incoming channel as DTX channel -1; sending
  // start on the IDE daemon channel leaves the runner idle after config.
  log("Waiting for XCTestDriverInterface reverse channel...")
  const driverChan = await dtx1.waitForIncomingChannelRequest(30_000)
  log(`XCTestDriverInterface channel requested (${driverChan.identifier ?? "unknown"} code ${driverChan.requestedCode ?? "?"}); using DTX default channel ${driverChan.channelCode}`)
  log(`Starting test plan (protocol 36, async) on driver channel ${driverChan.channelCode}...`)
  await dtx1.channelCall(driverChan.channelCode, "_IDE_startExecutingTestPlanWithProtocolVersion:", [{ int: 36 } as any], false)
  log("test plan start sent; waiting for runner registration in daemon...")
  const keepAlive = [tun, dtx1, dtx2, ...launchKeepAlive]
  if (opts.observeMs && opts.observeMs > 0) await new Promise((r) => setTimeout(r, opts.observeMs))
  return {
    pid,
    sessionId: testSessionID,
    services,
    close: () => {
      void keepAlive.length
      try { cdp.destroy() } catch {}
    },
  }
}

async function main() {
  const udid = process.env.UDID
  if (!udid) throw new Error("Set UDID=<device udid> for the standalone usertunnel diagnostic")
  const os = await import("node:os")
  let lanIp = process.env.WS_HOST ?? ""
  if (!lanIp) {
    try {
      const iface = execFileSync("route", ["-n", "get", "default"]).toString().match(/interface:\s*(\w+)/)?.[1]
      if (iface) lanIp = execFileSync("ipconfig", ["getifaddr", iface]).toString().trim()
    } catch {}
    if (!lanIp) for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254")) lanIp = a.address
  }
  const wsPort = Number(process.env.WS_PORT ?? 8765)
  Bun.serve({ port: wsPort, hostname: "0.0.0.0",
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("ios-runner-ws") },
    websocket: {
      open() { console.log("\n*** RUNNER CONNECTED TO WS ***\n") },
      message(_ws, msg) { console.log("RUNNER >", typeof msg === "string" ? msg.slice(0, 300) : `[${(msg as Buffer).length}b]`) },
    },
  })
  const wsUrl = `ws://${lanIp}:${wsPort}/ios`
  console.log(`WS server listening on ${wsUrl}`)
  await launchRunnerOverUserspaceTunnel(udid, {
    env: {
      INTERCEPTOR_WS_URL: wsUrl,
      INTERCEPTOR_WS_TOKEN: "placeholder-token-" + randomBytes(4).toString("hex"),
      INTERCEPTOR_UDID: udid,
      INTERCEPTOR_CONTEXT_ID: "ctx-" + randomBytes(4).toString("hex"),
    },
    observeMs: Number(process.env.OBSERVE_MS ?? 30000),
    log: console.log,
  })
  console.log("Done observing.")
  process.exit(0)
}

// ── helpers ───────────────────────────────────────────────────────────────────
function uuidToStr(b: Buffer): string {
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
function xpcEnv(env: Record<string, unknown>): Record<string, unknown> { return env } // strings encode as XPC strings
function coreDeviceRequest(deviceId: string, feature: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    "CoreDevice.CoreDeviceDDIProtocolVersion": new I64(0),
    "CoreDevice.action": {},
    "CoreDevice.coreDeviceVersion": {
      "components": [new U64(0x15c), new U64(1), new U64(0), new U64(0), new U64(0)],
      "originalComponentsCount": new I64(2), "stringValue": "348.1",
    },
    "CoreDevice.deviceIdentifier": deviceId,
    "CoreDevice.featureIdentifier": feature,
    "CoreDevice.input": input,
    "CoreDevice.invocationIdentifier": randomUUID(),
  }
}
function extractPid(resp: any): number | null {
  const out = resp?.["CoreDevice.output"]
  const tok = out?.["processToken"]
  const pid = tok?.["processIdentifier"]
  if (typeof pid === "bigint") return Number(pid)
  if (typeof pid === "number") return pid
  return null
}
function jsonReplacer(_k: string, v: any) {
  if (typeof v === "bigint") return v.toString()
  if (Buffer.isBuffer(v)) return `<data ${v.length}b ${v.subarray(0, 16).toString("hex")}>`
  return v
}
function reportReply(name: string, m: any, log: (message: string) => void = console.log) {
  if (!m) { log(`  ${name}: (no reply)`); return }
  if (m.msgType === DTX_ERROR) {
    log(`  ${name}: DTX ERROR`)
    log("    payload xml: " + plutilToXml(m.payloadRaw).slice(0, 800))
    return
  }
  let summary = ""
  if (m.payloadRaw && m.payloadRaw.length) {
    const xml = plutilToXml(m.payloadRaw)
    summary = xml.replace(/\s+/g, " ").slice(0, 300)
  }
  log(`  ${name}: OK (c${m.channelCode} i${m.identifier}.${m.conversationIndex}) ${summary}`)
}

export type RemoteXpcTunnel = { tun: Tun; cdp: net.Socket; services: Record<string, number> }

/**
 * Bring up the CoreDeviceProxy CDTunnel + userspace TCP mux + RSD handshake and
 * return the tunnel plus the enumerated service→port map. Extracted verbatim
 * from launchRunnerOverUserspaceTunnel so runner-launch and the web-inspection
 * device-service broker (daemon/ios/device-services.ts) share ONE RemoteXPC
 * bring-up instead of duplicating the tunnel handshake.
 */
export async function openRemoteXpcTunnel(udid: string, log: (m: string) => void = () => {}): Promise<RemoteXpcTunnel> {
  const { sock: cdp } = await connectServiceSocket(udid, "com.apple.internal.devicecompute.CoreDeviceProxy")
  const rq = Buffer.from(JSON.stringify({ type: "clientHandshakeRequest", mtu: 1280 }))
  cdp.write(Buffer.concat([Buffer.from("CDTunnel\0"), Buffer.from([rq.length]), rq]))
  const params: any = await new Promise((res, rej) => {
    let acc = Buffer.alloc(0); const t = setTimeout(() => rej(new Error("cdtunnel hs timeout")), 8000)
    const on = (c: Buffer) => { acc = Buffer.concat([acc, c]); if (acc.length >= 10 && acc.length >= 10 + acc[9]) { clearTimeout(t); cdp.off("data", on); res(JSON.parse(acc.subarray(10, 10 + acc[9]).toString())) } }
    cdp.on("data", on); cdp.on("error", rej)
  })
  const myIp = parseIp6(params.clientParameters.address), devIp = parseIp6(params.serverAddress)
  const tun = new Tun(cdp, myIp, devIp)
  const rsdChan = await tun.connect(params.serverRSDPort as number)
  const services = await rsdHandshake(rsdChan)
  log(`RSD: ${Object.keys(services).length} services enumerated`)
  return { tun, cdp, services }
}

// RSD handshake over the given TCP chan; returns {serviceName: port}
async function rsdHandshake(chan: TcpChan): Promise<Record<string, number>> {
  const app = new XpcServiceRaw(chan)
  return app.rsd()
}
// RSD uses the same H2/XPC but a slightly different message sequence (Handshake
// with Services). Reuse XpcService's frame plumbing via a thin subclass.
export class XpcServiceRaw {
  private inbound = Buffer.alloc(0)
  private rootBuf = Buffer.alloc(0)
  private replyBuf = Buffer.alloc(0)
  private waiters: Array<(w: any) => void> = []
  private pend: any[] = []
  private gotSettings = false
  private rootHeadersSent = false
  private replyHeadersSent = false
  constructor(private chan: TcpChan) { chan.onData((c) => this.onData(c)) }
  private writeRaw(sid: number, xpc: Buffer) {
    if (sid === ROOT && !this.rootHeadersSent) { this.chan.write(h2frame(FT_HEADERS, 0x4, ROOT, Buffer.alloc(0))); this.rootHeadersSent = true }
    if (sid === REPLY && !this.replyHeadersSent) { this.chan.write(h2frame(FT_HEADERS, 0x4, REPLY, Buffer.alloc(0))); this.replyHeadersSent = true }
    this.chan.write(h2frame(FT_DATA, 0, sid, xpc))
  }
  private drainRaw(which: "root" | "reply") {
    const bufName = which === "root" ? "rootBuf" : "replyBuf"
    let dec = tryDecodeWrapper((this as any)[bufName] as Buffer)
    while (dec) {
      ;(this as any)[bufName] = ((this as any)[bufName] as Buffer).subarray(dec.consumed)
      if (isXpcEmptyHeartbeatRequest(dec.flags, dec.body)) {
        this.writeRaw(which === "root" ? REPLY : ROOT, encodeXpcHeartbeatReply(dec.msgId))
        dec = tryDecodeWrapper((this as any)[bufName] as Buffer)
        continue
      }
      if (which === "root") {
        const w = this.waiters.shift(); if (w) w(dec); else this.pend.push(dec)
      }
      dec = tryDecodeWrapper((this as any)[bufName] as Buffer)
    }
  }
  private onData(chunk: Buffer) {
    this.inbound = Buffer.concat([this.inbound, chunk])
    while (this.inbound.length >= 9) {
      const len = this.inbound.readUIntBE(0, 3)
      if (this.inbound.length < 9 + len) break
      const type = this.inbound[3], flags = this.inbound[4], sid = this.inbound.readUInt32BE(5) & 0x7fffffff
      const payload = this.inbound.subarray(9, 9 + len); this.inbound = this.inbound.subarray(9 + len)
      if (type === FT_SETTINGS) { if (!(flags & 0x1)) { this.gotSettings = true; this.chan.write(h2frame(FT_SETTINGS, 0x1, 0, Buffer.alloc(0))) } }
      else if (type === FT_PING) { if (!(flags & 0x1)) this.chan.write(h2frame(FT_PING, 0x1, 0, Buffer.from(payload))) }
      else if (type === FT_DATA && sid === ROOT) {
        this.rootBuf = Buffer.concat([this.rootBuf, payload])
        this.drainRaw("root")
      } else if (type === FT_DATA && sid === REPLY) {
        this.replyBuf = Buffer.concat([this.replyBuf, payload])
        this.drainRaw("reply")
      }
    }
  }
  private next(timeoutMs = 8000): Promise<any> {
    if (this.pend.length) return Promise.resolve(this.pend.shift())
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("rsd wrapper timeout")), timeoutMs); this.waiters.push((w) => { clearTimeout(t); res(w) }) })
  }
  async rsd(): Promise<Record<string, number>> {
    this.chan.write(H2_MAGIC)
    this.chan.write(settingsFrame([[0x3, 100], [0x4, 16 * 1024 * 1024]]))
    this.chan.write(windowUpdate(0, 16 * 1024 * 1024 - 65535))
    this.chan.write(h2frame(FT_HEADERS, 0x4, ROOT, Buffer.alloc(0))); this.rootHeadersSent = true
    this.chan.write(h2frame(FT_DATA, 0, ROOT, encodeWrapper({}, F_ALWAYS, 0)))
    this.chan.write(h2frame(FT_HEADERS, 0x4, REPLY, Buffer.alloc(0))); this.replyHeadersSent = true
    this.chan.write(h2frame(FT_DATA, 0, ROOT, encodeWrapper(null, 0x0201, 0)))
    this.chan.write(h2frame(FT_DATA, 0, REPLY, encodeWrapper(null, F_ALWAYS | F_INIT, 0)))
    const start = Date.now(); while (!this.gotSettings && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 50))
    const handshake = {
      MessageType: "Handshake", MessagingProtocolVersion: new U64(7),
      UUID: new XUuid(Buffer.from(randomUUID().replace(/-/g, ""), "hex")),
      Properties: { RemoteXPCVersionFlags: new U64(0x0100000000000006n), SensitivePropertiesVisible: true },
      Services: {},
    }
    this.chan.write(h2frame(FT_DATA, 0, ROOT, encodeWrapper(handshake, F_ALWAYS | F_DATA | F_HEARTBEAT_REQ, 1)))
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      let w: any; try { w = await this.next(Math.max(500, deadline - Date.now())) } catch { break }
      if (!w.body) continue
      const peer = (w.body.peer_info ?? w.body) as any
      const svcs = (peer?.Services ?? w.body.Services) as Record<string, any> | undefined
      if (svcs && Object.keys(svcs).length) {
        const out: Record<string, number> = {}
        for (const [name, info] of Object.entries(svcs)) { const p = (info && typeof info === "object") ? (info.Port ?? info.port) : info; out[name] = Number(p) }
        return out
      }
    }
    throw new Error("RSD: no Services received")
  }
}

if (import.meta.main) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1) })
}
