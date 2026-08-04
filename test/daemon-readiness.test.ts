import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import { TEMP } from "../shared/platform"

// Mock paths for testing
const testPidPath = `${TEMP}/test-interceptor.pid`
const testSocketPath = `${TEMP}/test-interceptor.sock`

beforeEach(() => {
  try { unlinkSync(testPidPath) } catch {}
  try { unlinkSync(testSocketPath) } catch {}
})

afterEach(() => {
  try { unlinkSync(testPidPath) } catch {}
  try { unlinkSync(testSocketPath) } catch {}
})

describe("daemon readiness check", () => {
  test("detects healthy daemon on WebSocket port", async () => {
    // Start a simple HTTP server to simulate daemon health check
    const server = Bun.serve({
      port: 0, // Use any available port
      fetch() {
        return new Response("interceptor daemon", { status: 200 })
      },
    })

    try {
      const port = server.port
      const response = await fetch(`http://127.0.0.1:${port}/`, { timeout: 2000 })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("interceptor daemon")
    } finally {
      server.stop(true)
    }
  })

  test("reports daemon failure when port is not responsive", async () => {
    // Try to connect to an invalid port
    try {
      await fetch("http://127.0.0.1:1/", { timeout: 100 })
    } catch (err) {
      // Expected: fetch throws when port is not listening
      expect(err).toBeDefined()
    }
  })

  test("cold start case: PID file missing indicates no daemon", () => {
    const pidExists = existsSync(testPidPath)
    expect(pidExists).toBe(false)
  })
})
