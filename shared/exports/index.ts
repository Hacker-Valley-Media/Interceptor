/**
 * shared/exports/index.ts — public surface for the network-export pipeline.
 *
 * Consumers (CLI command handlers) import:
 *   - `writeExport(...)` — pick the right encoder by format and write to stdout / file.
 *   - `fromPassive`, `fromMonitorArtifacts` — turn raw capture sources into UnifiedCapture[].
 *   - Type re-exports.
 *
 * Encoders themselves stay pure (UnifiedCapture[] → string | Uint8Array).
 * I/O lives here.
 */

import { writeFileSync, chmodSync } from "node:fs"
import type { ExportFormat, ExportMetadata, UnifiedCapture } from "./types"
import { buildHar } from "./har"
import { buildPcapng } from "./pcapng"
import { buildJsonEnvelope } from "./json-envelope"

export * from "./types"
export { fromPassive, fromMonitorArtifacts, fromMonitorEvents } from "./unify"
export type { PassiveNetEntry } from "./unify"
export { buildHar } from "./har"
export { buildPcapng } from "./pcapng"
export { buildJsonEnvelope } from "./json-envelope"

export type WriteExportOptions = {
  format: ExportFormat
  captures: UnifiedCapture[]
  meta: ExportMetadata
  /** Output path. When omitted, writes to stdout (only safe for text formats). */
  out?: string
  /**
   * Replace credential-bearing header values with "[redacted]" before
   * encoding. OFF by default — captured headers are part of the export's
   * value; pass `net log --redact-auth` when the capture should not carry
   * live credentials (issue #160).
   */
  redactAuth?: boolean
}

// Header names that carry credentials or session state. Exact set from issue
// #160 plus a loose name match for the token/secret/session family.
const REDACT_EXACT = /^(authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|x-api-key)$/i
const REDACT_LOOSE = /token|secret|session/i

export function redactHeaderRecord(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = REDACT_EXACT.test(name) || REDACT_LOOSE.test(name) ? "[redacted]" : value
  }
  return out
}

/**
 * Shallow-copy captures with credential headers redacted on both sides
 * (set-cookie lives on the response). The HAR encoder derives its cookies
 * arrays from these header records, so redacting here empties those too.
 */
export function redactCaptures(captures: UnifiedCapture[]): UnifiedCapture[] {
  return captures.map((c) => ({
    ...c,
    requestHeaders: redactHeaderRecord(c.requestHeaders),
    responseHeaders: redactHeaderRecord(c.responseHeaders),
  }))
}

/**
 * Resolve a format alias to a canonical encoder format.
 *   "json"   → JSON envelope
 *   "har"    → HAR 1.2
 *   "pcapng" → pcapng bytes
 *   "text"   → caller decides (we return the captures unchanged)
 *   "plan"   → caller-owned (monitor.ts builds a replay script)
 */
export function isBinaryFormat(format: ExportFormat): boolean {
  return format === "pcapng"
}

/**
 * Refuse to dump binary output to a TTY — that would corrupt the user's
 * terminal. Bun and Node both expose `process.stdout.isTTY` on the writable
 * stream; we accept the optional override for tests.
 */
function stdoutIsTty(): boolean {
  // process is available in Bun. Cast through unknown to avoid Node typings churn.
  const out = (globalThis as unknown as { process?: { stdout?: { isTTY?: boolean } } }).process?.stdout
  return Boolean(out?.isTTY)
}

/**
 * Dispatch + write. Returns the number of bytes written (Bun.write contract).
 *
 * For text-class formats (`json`, `har`), the encoder output is JSON-stringified
 * and written. For `pcapng`, a Uint8Array is written verbatim. The text format
 * is passed through unchanged by this dispatcher — the CLI caller is expected
 * to fall back to its existing pretty-print pipeline for `format === "text"`.
 */
export async function writeExport(opts: WriteExportOptions): Promise<number> {
  const { format, meta, out } = opts
  const captures = opts.redactAuth ? redactCaptures(opts.captures) : opts.captures
  if (format === "text" || format === "plan") {
    throw new Error(`writeExport does not handle '${format}'; the CLI should branch before reaching here`)
  }

  if (format === "pcapng" && !out && stdoutIsTty()) {
    throw new Error("refusing to write binary pcapng to a TTY — pass --out <path> or redirect stdout")
  }

  let payload: string | Uint8Array
  if (format === "har") {
    payload = JSON.stringify(buildHar(captures, meta))
  } else if (format === "json") {
    payload = JSON.stringify(buildJsonEnvelope(captures, meta))
  } else if (format === "pcapng") {
    payload = buildPcapng(captures, meta)
  } else {
    throw new Error(`unknown export format: ${format}`)
  }

  if (out) {
    // Exports carry captured headers (credentials by default) — keep the file
    // owner-only. Bun.write has no mode parameter
    // (docs/bun/docs/runtime/file-io.md), so write through node:fs; the
    // explicit chmod covers pre-existing files, where writeFileSync's mode
    // only applies at creation.
    writeFileSync(out, payload, { mode: 0o600 })
    chmodSync(out, 0o600)
    return typeof payload === "string" ? Buffer.byteLength(payload, "utf-8") : payload.byteLength
  }

  // Bun.write signatures (docs/bun/docs/runtime/file-io.md):
  //   Bun.write(path | BunFile | Bun.stdout, string | Uint8Array | ...): Promise<number>
  // `Bun` is available globally in Bun runtime.
  const BunRef = (globalThis as unknown as { Bun?: { write: (dest: unknown, data: unknown) => Promise<number>; stdout: unknown } }).Bun
  if (!BunRef) {
    throw new Error("Bun runtime is required for writeExport")
  }
  return BunRef.write(BunRef.stdout, payload)
}
