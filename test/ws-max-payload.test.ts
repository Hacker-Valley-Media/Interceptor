/**
 * test/ws-max-payload.test.ts
 *
 * The daemon's WS server is the designated large-payload transport
 * (screenshots and `save` auto-route to it because native messaging drops
 * big responses). Bun's default maxPayloadLength is 16 MiB and the server
 * responds to a larger message by CLOSING the connection — killing every
 * in-flight request on that socket. The daemon therefore sets an explicit
 * maxPayloadLength aligned with the unix-socket transport's frame cap.
 *
 * Two layers:
 *   1. Source guard — startWsServer must wire maxPayloadLength to
 *      MAX_UPLOAD_FRAME_BYTES (catches a silent knob drop).
 *   2. Behavior — a Bun.serve WS server with that exact cap accepts a
 *      17 MB message (which kills a default-configured server), proving the
 *      shipped value actually lifts the ceiling.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { MAX_UPLOAD_FRAME_BYTES } from "../shared/platform"

const REPO_ROOT = resolve(import.meta.dir, "..")

describe("daemon WS server payload ceiling", () => {
  test("startWsServer wires maxPayloadLength to MAX_UPLOAD_FRAME_BYTES", () => {
    const src = readFileSync(resolve(REPO_ROOT, "daemon/index.ts"), "utf-8")
    expect(src.includes("maxPayloadLength: MAX_UPLOAD_FRAME_BYTES")).toBe(true)
  })

  test("a 17 MB message survives on the shipped cap", async () => {
    let received = 0
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response("ws only", { status: 400 })
      },
      websocket: {
        maxPayloadLength: MAX_UPLOAD_FRAME_BYTES,
        message(_ws, raw) {
          received = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
        },
      },
    })
    try {
      const size = 17 * 1024 * 1024
      const outcome = await new Promise<string>((resolveOutcome) => {
        const ws = new WebSocket(`ws://localhost:${server.port}`)
        ws.onopen = () => {
          ws.send("x".repeat(size))
          // Give the server time to either accept or kill the connection.
          setTimeout(() => { ws.close(); resolveOutcome("accepted") }, 1500)
        }
        ws.onclose = (e) => {
          if (e.code !== 1000) resolveOutcome(`killed code=${e.code}`)
        }
      })
      expect(outcome).toBe("accepted")
      expect(received).toBe(size)
    } finally {
      server.stop(true)
    }
  }, 15_000)
})
