import { safePortPost } from "./safe-port-post"

export type NativePortLike = {
  postMessage(msg: unknown): void
  disconnect?: () => void
}

export function safeNativePortPost(port: NativePortLike | null | undefined, msg: unknown): { posted: boolean; error?: string } {
  return safePortPost(port, msg)
}

export function safeNativePortPing(port: NativePortLike | null | undefined): { posted: boolean; error?: string } {
  return safeNativePortPost(port, { type: "ping" })
}

export function safeNativePortDisconnect(port: Pick<NativePortLike, "disconnect"> | null | undefined): { disconnected: boolean; error?: string } {
  if (!port?.disconnect) return { disconnected: false, error: "no disconnect" }
  try {
    port.disconnect()
    return { disconnected: true }
  } catch (err) {
    return { disconnected: false, error: (err as Error).message }
  }
}

export function shouldSkipNativeKeepalive(now: number, lastNativeActivityAt: number, graceMs: number): boolean {
  return now - lastNativeActivityAt < graceMs
}
