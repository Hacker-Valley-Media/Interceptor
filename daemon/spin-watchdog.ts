// Idle-spin watchdog (issue #216).
//
// A standalone daemon was observed at ~100% CPU for hours with no connected
// clients and nothing new in the log. The cause is not known (no stack sample
// from a wedged process yet), so this does not claim a fix: it makes the state
// visible and self-healing. The keepalive tick measures the CPU the process
// spent since the previous tick; when the daemon is busy while it has nothing
// to do, it logs a diagnostic and, after SPIN_EXIT_TICKS consecutive such
// ticks, exits so the next CLI call (or the browser's native-host connect)
// respawns a fresh daemon.
//
// Limit: this runs on the event loop. It catches event-loop-level spins (timer
// storms, socket poll loops, a drain loop that never yields to sleep) but not a
// JS busy-loop that blocks the main thread — that would block the tick too.
// Pure so the decision is unit-testable without a live daemon.

export const SPIN_BUSY_FRACTION = 0.85
/** Consecutive busy-while-idle keepalive ticks (10 s each) before exiting. */
export const SPIN_EXIT_TICKS = 6

export type SpinWatchdogState = { busyIdleTicks: number }

export type SpinSample = {
  /** process.cpuUsage() user+system microseconds spent since the last tick. */
  cpuMicros: number
  /** Wall-clock milliseconds elapsed since the last tick. */
  wallMs: number
  /** No clients, no in-flight requests, no registered contexts. */
  idle: boolean
}

export type SpinVerdict = "ok" | "spinning" | "exit"

export function spinWatchdogStep(
  state: SpinWatchdogState,
  sample: SpinSample,
): { state: SpinWatchdogState; verdict: SpinVerdict; busyFraction: number } {
  const busyFraction = sample.wallMs > 0 ? Math.max(0, sample.cpuMicros / 1000 / sample.wallMs) : 0
  if (!sample.idle || busyFraction < SPIN_BUSY_FRACTION) {
    return { state: { busyIdleTicks: 0 }, verdict: "ok", busyFraction }
  }
  const busyIdleTicks = state.busyIdleTicks + 1
  return {
    state: { busyIdleTicks },
    verdict: busyIdleTicks >= SPIN_EXIT_TICKS ? "exit" : "spinning",
    busyFraction,
  }
}
