// Backpressure-safe writes for raw Bun sockets (unix + TCP).
//
// Bun's socket.write() buffers nothing: it returns how many bytes the kernel
// accepted and silently keeps the rest with the caller. On macOS the unix
// stream send buffer is 8 KiB (net.local.stream.sendspace), so any frame
// bigger than that partially writes even on an idle socket. A dropped tail
// desyncs length-prefixed framing on the receiver and eats every subsequent
// message on the connection (issue #229). Every raw-socket writer in the daemon
// must route through socketWriteAll and flush from its drain handler.
//
// The queue is keyed by socket object identity — Bun passes the same socket
// object to open/data/drain/close as Bun.connect resolves with (verified on
// Bun 1.3.11).

type WritableSocket = { write: (data: Buffer | string) => number }

const queues = new Map<object, Buffer[]>()

/**
 * Write `data` preserving order under backpressure. If bytes are already
 * queued for this socket, writing now would jump ahead of a truncated frame's
 * tail and corrupt the stream — so append instead; drainSocketQueue flushes
 * in order when the socket's drain handler fires.
 */
export function socketWriteAll(socket: WritableSocket, data: Buffer): void {
  const queue = queues.get(socket)
  if (queue && queue.length > 0) {
    queue.push(data)
    return
  }
  const wrote = socket.write(data)
  if (wrote < data.byteLength) {
    queues.set(socket, [Buffer.from(data.subarray(wrote))])
  }
}

/** Flush queued bytes in order. Call from the socket's drain handler. */
export function drainSocketQueue(socket: WritableSocket): void {
  const queue = queues.get(socket)
  if (!queue || queue.length === 0) return
  while (queue.length > 0) {
    const chunk = queue[0]
    let wrote = 0
    try {
      wrote = socket.write(chunk)
    } catch {
      // Socket is closing; its close handler releases the queue.
      return
    }
    if (wrote < chunk.byteLength) {
      queue[0] = chunk.subarray(wrote)
      return
    }
    queue.shift()
  }
  queues.delete(socket)
}

/** Drop any queued bytes. Call from the socket's close handler. */
export function releaseSocketQueue(socket: object): void {
  queues.delete(socket)
}

/** Test-only visibility: bytes currently queued for a socket. */
export function queuedByteLength(socket: object): number {
  const queue = queues.get(socket)
  if (!queue) return 0
  return queue.reduce((sum, chunk) => sum + chunk.byteLength, 0)
}
