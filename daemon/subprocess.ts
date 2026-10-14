export type SubprocessResult = { stdout: string; stderr: string; code: number }

/** Capture an owned child without blocking the daemon or leaving its group alive at the deadline. */
export async function captureSubprocess(
  argv: string[],
  opts: { timeoutMs?: number; input?: string; env?: Record<string, string | undefined>; name?: string; timeoutLabel?: string } = {},
): Promise<SubprocessResult> {
  const name = opts.name ?? argv[0]
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe", stderr: "pipe", stdin: opts.input === undefined ? "ignore" : Buffer.from(opts.input),
      env: opts.env, detached: process.platform !== "win32", windowsHide: true,
    })
  } catch (err) {
    return { stdout: "", stderr: `failed to spawn ${name}: ${(err as Error).message}`, code: 127 }
  }
  const stop = () => {
    // Only our freshly spawned group is signaled. A daemon that deliberately
    // detaches into its own group retains its separate lifetime.
    if (process.platform !== "win32") {
      try { process.kill(-proc.pid, "SIGKILL"); return } catch {}
    }
    try { proc.kill("SIGKILL") } catch {}
  }
  let timedOut = false
  // Bun's own spawnSync timeout fired at once in the idle Windows daemon (cdp discover: 18 s idle
  // passed, 22 s failed against 20 s), so the deadline is checked on the monotonic clock and re-armed.
  const deadline = performance.now() + (opts.timeoutMs ?? 0)
  const expire = () => { const left = deadline - performance.now(); if (left > 0) { timer = setTimeout(expire, left); return } timedOut = true; stop() }
  let timer = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(expire, opts.timeoutMs) : undefined
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(), proc.exited,
    ])
    return timedOut
      ? { stdout, stderr: stderr + `\n[${opts.timeoutLabel ?? name}] killed after ${opts.timeoutMs}ms`, code: 124 }
      : { stdout, stderr, code }
  } catch (err) {
    stop()
    return { stdout: "", stderr: `${name} run error: ${(err as Error).message}`, code: 1 }
  } finally { if (timer) clearTimeout(timer) }
}
