import { existsSync } from "node:fs"
import { execFile, type ExecFileException } from "node:child_process"
import { promisify } from "node:util"
import { dirname, isAbsolute, join } from "node:path"
import { bridgeSocketPath } from "./bridge-paths"

export function desktopProviderBinary(): string | undefined {
  const name = process.platform === "win32" ? "interceptor-desktop.exe" : "interceptor-desktop"
  const override = process.env.INTERCEPTOR_DESKTOP_PROVIDER
  if (override) return existsSync(override) ? override : undefined
  const candidates = [
    join(dirname(process.execPath), name), join(dirname(process.execPath), "..", name),
    join(process.env.LOCALAPPDATA || "", "Programs", "Interceptor", name),
    join(process.env.HOME || "", ".local", "share", "interceptor", name),
    join(import.meta.dir, "..", "dist", name)]
  // An unset LOCALAPPDATA or HOME would leave a cwd-relative candidate; never run a file planted there.
  return candidates.find(p => isAbsolute(p) && existsSync(p))
}

export async function desktopProviderEndpoint(): Promise<string> {
  if (process.env.INTERCEPTOR_DESKTOP_ENDPOINT) return process.env.INTERCEPTOR_DESKTOP_ENDPOINT
  if (process.platform !== "win32" && process.platform !== "linux") return bridgeSocketPath()
  const binary = desktopProviderBinary()
  if (!binary) throw Object.assign(new Error("native desktop provider is not installed"), {code:"not_installed"})
  let stdout: string
  const started = performance.now()
  for (let attempt = 0; ; attempt++) {
    try {
      // Identity is a read-only lookup before negotiation. A Windows timeout may be
      // retried once within an eight-second total budget; each attempt keeps a
      // five-second maximum and the 4096-byte bound. A first launch of the provider
      // under antivirus scanning measured over two seconds on a Windows ARM64 VM.
      const timeout = Math.max(1, Math.min(5000, Math.floor(8000 - (performance.now() - started))))
      const identity = await promisify(execFile)(binary, ["--identity"], { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 4096 })
      stdout = identity.stdout
      break
    } catch (error) {
      const failure = error as ExecFileException & {stderr?: string}
      const timedOut = failure.code === "ETIMEDOUT" ||
        (failure.killed === true && failure.signal === "SIGTERM" && failure.code == null)
      if (process.platform === "win32" && attempt === 0 && timedOut && performance.now() - started < 8000) continue
      throw Object.assign(new Error("native desktop session identity unavailable: " + JSON.stringify({
        status: failure.code, signal: failure.signal, error: failure.message?.slice(0, 512), stderr: failure.stderr?.slice(0, 512),
      })), {code:process.platform==="linux" && failure.stderr?.includes("no systemd login session; a GUI broker is required") ? "no_interactive_session" : "provider_failed"})
    }
  }
  const descriptor = JSON.parse(stdout) as { endpoint?: unknown; session?: unknown; uid?: unknown }
  if (process.platform === "linux") {
    if (typeof descriptor.session !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.session) ||
        descriptor.uid !== process.getuid?.() || typeof descriptor.endpoint !== "string" ||
        !descriptor.endpoint.startsWith("/") || !descriptor.endpoint.endsWith(`/interceptor-desktop/session-${descriptor.session}.sock`)) {
      throw new Error("invalid current-user Linux desktop provider descriptor")
    }
    return descriptor.endpoint
  }
  if (descriptor.session === "0") throw Object.assign(new Error("Windows native control requires the logged-in user's interactive session; Session 0 is not supported"), { code: "no_interactive_session" })
  if (typeof descriptor.endpoint !== "string" || !/^\\\\\.\\pipe\\interceptor-desktop-S-\d+(?:-\d+)+-\d+$/.test(descriptor.endpoint)) {
    throw new Error("invalid current-user desktop provider descriptor")
  }
  return descriptor.endpoint
}
