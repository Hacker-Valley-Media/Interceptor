/**
 * cli/prompt.ts — hidden-input readers for credentials (issue #244).
 *
 * A secret value never travels on argv. It comes from a hidden TTY prompt
 * (raw mode, no echo) or, for scripts and SSH sessions, from stdin.
 */

const CTRL_C = String.fromCharCode(3)
const DEL = String.fromCharCode(127)

/** Read one line from the TTY without echo. Rejects on Ctrl-C. */
export function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }
    process.stderr.write(prompt)
    let buf = ""
    const cleanup = () => {
      stdin.off("data", onData)
      try { stdin.setRawMode?.(false) } catch {}
      stdin.pause()
    }
    const onData = (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      for (const c of str) {
        if (c === "\r" || c === "\n") { cleanup(); process.stderr.write("\n"); resolve(buf); return }
        if (c === CTRL_C) { cleanup(); process.stderr.write("\n"); reject(new Error("cancelled")); return }
        if (c === DEL || c === "\b") { buf = buf.slice(0, -1); continue }
        buf += c
      }
    }
    try { stdin.setRawMode?.(true) } catch {}
    stdin.resume()
    stdin.on("data", onData)
  })
}

/** Read all of stdin (pipe or file), dropping one trailing newline. */
export async function readStdinValue(opts: {maxBytes?:number;trimNewline?:boolean} = {}): Promise<string> {
  let text: string
  if (opts.maxBytes === undefined) text = await new Response(Bun.stdin.stream()).text()
  else {
    if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > 9_999_999) throw new Error("invalid stdin byte limit")
    const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const {done,value} = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > opts.maxBytes) throw new Error("stdin exceeds its byte limit")
        chunks.push(value)
      }
      text = new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock() }
  }
  return opts.trimNewline === false ? text : text.replace(/\r?\n$/, "")
}

/**
 * Value for a credential: stdin when asked for or when stdin is not a TTY,
 * else a hidden prompt with a confirmation.
 */
export async function readSecretValue(label: string, opts: { stdin?: boolean; confirm?: boolean } = {}): Promise<string> {
  if (opts.stdin || !process.stdin.isTTY) {
    const v = await readStdinValue()
    if (!v) { console.error(`error: no ${label} on stdin`); process.exit(1) }
    return v
  }
  let first: string
  try { first = await readHiddenLine(`${label}: `) } catch { console.error("cancelled"); process.exit(1) }
  if (!first) { console.error(`error: empty ${label}`); process.exit(1) }
  if (opts.confirm !== false) {
    let second: string
    try { second = await readHiddenLine(`Confirm ${label}: `) } catch { console.error("cancelled"); process.exit(1) }
    if (first !== second) { console.error("error: the two entries differ; nothing stored"); process.exit(1) }
  }
  return first
}
