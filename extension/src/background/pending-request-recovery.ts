export type RecoveryDeliveryResult = "sent" | "queued" | "failed"

export type RecoverablePendingRequest = {
  action: string
  timer: ReturnType<typeof setTimeout>
}

type LogFn = (message?: unknown, ...optionalParams: unknown[]) => void

export function recoverPendingRequestsAfterNativeDisconnect(
  pending: Iterable<[string, RecoverablePendingRequest]>,
  deliver: (msg: unknown) => RecoveryDeliveryResult,
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
  logError: LogFn = console.error
): { recovered: number; failed: number } {
  let recovered = 0
  let failed = 0

  for (const [id, req] of pending) {
    clearTimer(req.timer)
    logError(`orphaned request ${id} (${req.action}) — native port disconnected`)
    const delivery = deliver({ id, result: { success: false, error: "native port disconnected" } })
    if (delivery === "failed") {
      failed += 1
      logError(`final delivery failure for orphaned request ${id} (${req.action})`)
    } else {
      recovered += 1
    }
  }

  return { recovered, failed }
}
