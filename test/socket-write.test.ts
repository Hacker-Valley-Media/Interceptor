// Issue #229: backpressure-safe raw-socket writes. The macOS unix-socket send
// buffer is 8 KiB (net.local.stream.sendspace), so a bare socket.write() of a
// larger frame partially writes even on an idle socket, silently dropping the
// tail and desyncing the receiver's length-prefixed framing. These tests pin
// the queue/drain contract and prove the fix over real unix sockets.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { socketWriteAll, drainSocketQueue, releaseSocketQueue, queuedByteLength } from "../daemon/socket-write"

function fakeSocket(acceptPerWrite: number[]) {
  const written: Buffer[] = []
  let call = 0
  return {
    written,
    write(data: Buffer | string) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const cap = call < acceptPerWrite.length ? acceptPerWrite[call] : buf.byteLength
      call++
      const accepted = Math.min(cap, buf.byteLength)
      written.push(Buffer.from(buf.subarray(0, accepted)))
      return accepted
    },
  }
}

describe("socketWriteAll / drainSocketQueue (unit)", () => {
  test("full write leaves nothing queued", () => {
    const sock = fakeSocket([])
    socketWriteAll(sock, Buffer.from("hello"))
    expect(queuedByteLength(sock)).toBe(0)
    expect(Buffer.concat(sock.written).toString()).toBe("hello")
  })

  test("partial write queues the exact tail", () => {
    const sock = fakeSocket([3])
    socketWriteAll(sock, Buffer.from("abcdef"))
    expect(Buffer.concat(sock.written).toString()).toBe("abc")
    expect(queuedByteLength(sock)).toBe(3)
    drainSocketQueue(sock)
    expect(Buffer.concat(sock.written).toString()).toBe("abcdef")
    expect(queuedByteLength(sock)).toBe(0)
  })

  test("a write while bytes are queued appends instead of jumping the queue", () => {
    // The reorder race (issue #229): frame B must never land inside frame
    // A's unsent tail.
    const sock = fakeSocket([2, 0])
    socketWriteAll(sock, Buffer.from("AAAA"))
    socketWriteAll(sock, Buffer.from("BBBB"))
    // Second write must not have touched the socket at all.
    expect(Buffer.concat(sock.written).toString()).toBe("AA")
    expect(queuedByteLength(sock)).toBe(6)
    drainSocketQueue(sock) // scripted 0-byte accept: stays queued, no progress
    expect(queuedByteLength(sock)).toBe(6)
    drainSocketQueue(sock) // now unrestricted: flushes in order
    expect(Buffer.concat(sock.written).toString()).toBe("AAAABBBB")
    expect(queuedByteLength(sock)).toBe(0)
  })

  test("drain stops and keeps the tail when the socket accepts partially", () => {
    const sock = fakeSocket([1, 2])
    socketWriteAll(sock, Buffer.from("abcdef"))
    drainSocketQueue(sock)
    expect(Buffer.concat(sock.written).toString()).toBe("abc")
    drainSocketQueue(sock)
    expect(Buffer.concat(sock.written).toString()).toBe("abcdef")
  })

  test("a throwing socket does not lose the queue until released", () => {
    // Queue a tail, then make the SAME socket throw: drain must swallow the
    // throw (close releases the queue) and the queue must survive until then.
    let throwing = false
    const sock = {
      write() {
        if (throwing) throw new Error("closed")
        return 1
      },
    }
    socketWriteAll(sock, Buffer.from("abc"))
    socketWriteAll(sock, Buffer.from("d"))
    expect(queuedByteLength(sock)).toBe(3)
    throwing = true
    expect(() => drainSocketQueue(sock)).not.toThrow()
    expect(queuedByteLength(sock)).toBe(3)
    releaseSocketQueue(sock)
    expect(queuedByteLength(sock)).toBe(0)
  })

  test("a negative write return fails the write and drops the queue on drain", () => {
    const dead = { write: () => -1 }
    expect(() => socketWriteAll(dead, Buffer.from("abc"))).toThrow()
    const dying = fakeSocket([1])
    socketWriteAll(dying, Buffer.from("abc"))
    expect(queuedByteLength(dying)).toBe(2)
    dying.write = () => -1
    drainSocketQueue(dying)
    expect(queuedByteLength(dying)).toBe(0)
  })
})

// Length-framed receiver mimicking the Swift bridge's read loop
// (Transport.swift handleClient) and the daemon's processBridgeBuffer.
function frameCollector() {
  const frames: Buffer[] = []
  let acc = Buffer.alloc(0)
  return {
    frames,
    push(chunk: Buffer) {
      acc = Buffer.concat([acc, chunk])
      while (acc.length >= 4) {
        const len = acc.readUInt32LE(0)
        if (acc.length < 4 + len) return
        frames.push(acc.subarray(4, 4 + len))
        acc = acc.subarray(4 + len)
      }
    },
  }
}

function frame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.byteLength, 0)
  return Buffer.concat([header, payload])
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) return false
    await Bun.sleep(10)
  }
  return true
}

describe("bridge-path integration over a real unix socket", () => {
  test("oversized frame arrives whole and does not poison the next frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "icpt-sw-"))
    const sockPath = join(dir, "bridge.sock")
    const collector = frameCollector()
    const server = Bun.listen({
      unix: sockPath,
      socket: {
        data(_s, chunk) { collector.push(Buffer.from(chunk)) },
        error() {},
      },
    })
    try {
      const client = await Bun.connect({
        unix: sockPath,
        socket: {
          data() {},
          drain(s) { drainSocketQueue(s) },
          close(s) { releaseSocketQueue(s) },
          error() {},
        },
      })
      // 100 KiB frame: > 12× the 8 KiB kernel send buffer.
      const big = Buffer.alloc(100 * 1024, 106)
      socketWriteAll(client, frame(big))
      // The poisoning scenario: a tiny follow-up request on the same
      // connection, written immediately (while the big tail is queued).
      const small = Buffer.from(JSON.stringify({ id: "next", action: { type: "macos_fs_read" } }))
      socketWriteAll(client, frame(small))

      expect(await waitFor(() => collector.frames.length === 2)).toBe(true)
      expect(collector.frames[0].byteLength).toBe(big.byteLength)
      expect(collector.frames[0].equals(big)).toBe(true)
      expect(collector.frames[1].equals(small)).toBe(true)
      client.end()
    } finally {
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("control: the old bare-write pattern truncates the same frame", async () => {
    // Guards the premise: if Bun ever starts buffering internally, this test
    // flags that the queue layer has become dead weight.
    const dir = mkdtempSync(join(tmpdir(), "icpt-sw-ctl-"))
    const sockPath = join(dir, "bridge.sock")
    let received = 0
    const server = Bun.listen({
      unix: sockPath,
      socket: {
        data(_s, chunk) { received += chunk.byteLength },
        error() {},
      },
    })
    try {
      const client = await Bun.connect({
        unix: sockPath,
        socket: { data() {}, error() {} },
      })
      const big = frame(Buffer.alloc(100 * 1024, 107))
      const wrote = client.write(big) // bare write, return value ignored — the old sendToBridge
      if (wrote === big.byteLength) {
        // A future Bun that buffers internally makes the queue layer dead
        // weight — surface that instead of failing an unrelated CI run.
        console.warn("socket.write accepted the full frame: Bun now buffers internally; revisit daemon/socket-write.ts")
      } else {
        expect(wrote).toBeLessThan(big.byteLength)
        await Bun.sleep(300)
        expect(received).toBe(wrote) // tail never arrives
      }
      client.end()
    } finally {
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
