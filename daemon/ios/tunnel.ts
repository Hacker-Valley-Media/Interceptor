/**
 * daemon/ios/tunnel.ts — client for the root tunnel helper.
 *
 * iOS 17+ gates dev services (testmanagerd, image mounter) behind a RemoteXPC
 * tunnel. Instead of hand-rolling a utun, the root helper (tunnel-helper/) drives
 * base-macOS `remotectl relay` to expose a device's RemoteXPC service on a
 * localhost TCP port over the OS tunnel. THIS module is the unprivileged client:
 * it asks the helper (over /var/run/interceptor-ios-tunnel.sock) to relay a
 * service and returns the {host,port} the caller then speaks the service to.
 */

import net from "node:net"

/** Localhost unix socket the root helper listens on (see tunnel-helper/). */
export const HELPER_SOCKET = "/var/run/interceptor-ios-tunnel.sock"

/** Per-session env injected into the on-device test process. */
export type RunnerEnv = {
  INTERCEPTOR_WS_URL: string
  INTERCEPTOR_WS_TOKEN: string
  INTERCEPTOR_UDID: string
  INTERCEPTOR_CONTEXT_ID: string
  /** This device's secret; the runner saves it to register after the device starts it. */
  INTERCEPTOR_DEVICE_SECRET?: string
  /** Comma-separated URLs the runner saves and tries when the device starts it. */
  INTERCEPTOR_WS_URLS?: string
}

export type ServiceEndpoint = { host: string; port: number }
export type TunnelInfo = { deviceIp: string; rsdPort: number; ifname: string }

/**
 * Ask the root helper to bring up (and hold) the CoreDeviceProxy utun tunnel to
 * the device. Returns the device's tunnel IPv6 + RSD port; once up, the caller
 * reaches RSD/testmanagerd over plain node:net (the OS routes via the utun).
 */
export async function getTunnel(udid: string): Promise<TunnelInfo> {
  const r = await helperRequest({ op: "tunnel", udid }, 30_000)
  if (!r.ok || typeof r.deviceIp !== "string" || typeof r.rsdPort !== "number") {
    throw new Error(`tunnel: helper could not bring up the tunnel: ${String(r.error ?? "unknown")}`)
  }
  return { deviceIp: r.deviceIp, rsdPort: r.rsdPort, ifname: typeof r.ifname === "string" ? r.ifname : "" }
}

/** Is the root tunnel helper installed + running? (socket present.) */
export function helperAvailable(): boolean {
  try { return require("node:fs").existsSync(HELPER_SOCKET) } catch { return false }
}

/** One JSON-line request/response against the helper socket. */
function helperRequest(msg: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!helperAvailable()) {
      reject(new Error(
        "tunnel: the root tunnel helper (com.interceptor.ios-tunnel) is not running. It is installed + " +
        "bootstrapped by the pkg postinstall; check `sudo launchctl print system/com.interceptor.ios-tunnel` " +
        "and /var/log/interceptor-ios-tunnel.log.",
      ))
      return
    }
    const sock = net.connect(HELPER_SOCKET)
    let buf = ""
    const timer = setTimeout(() => { try { sock.destroy() } catch {} ; reject(new Error("tunnel helper timed out")) }, timeoutMs)
    sock.on("connect", () => sock.write(JSON.stringify(msg) + "\n"))
    sock.on("data", (chunk) => {
      buf += chunk.toString()
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      clearTimeout(timer)
      try { resolve(JSON.parse(buf.slice(0, nl))) } catch (e) { reject(e as Error) }
      try { sock.destroy() } catch {}
    })
    sock.on("error", (e) => { clearTimeout(timer); reject(e) })
  })
}

/**
 * Ask the helper to relay a device RemoteXPC service to a localhost port.
 * Returns the endpoint the caller connects to (installer/ddi/testmanagerd).
 */
export async function getServiceEndpoint(udid: string, service: string): Promise<ServiceEndpoint> {
  const r = await helperRequest({ op: "relay", udid, service })
  if (!r.ok || typeof r.port !== "number") {
    throw new Error(`tunnel: helper could not relay ${service}: ${String(r.error ?? "unknown")}`)
  }
  return { host: typeof r.host === "string" ? r.host : "127.0.0.1", port: r.port }
}

/** Raw `remotectl list` from the helper (root discovery) — for diagnostics/wiring. */
export async function discoverDevices(): Promise<string> {
  const r = await helperRequest({ op: "discover" })
  return typeof r.list === "string" ? r.list : ""
}

/** Run remotectl (root) with arbitrary args via the helper — diagnostic passthrough. */
export async function runRemotectl(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await helperRequest({ op: "remotectl", args }, 30_000)
  return {
    code: typeof r.code === "number" ? r.code : null,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  }
}
