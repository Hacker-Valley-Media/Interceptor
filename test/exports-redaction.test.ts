/**
 * test/exports-redaction.test.ts
 *
 * Issue #160 (amended): captured headers STAY in exports by
 * default — they are part of the capture's value. `--redact-auth` opts into
 * stripping credential-bearing values, and export files are always created
 * owner-only (0600) because the default carries live credentials.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { redactCaptures, redactHeaderRecord, writeExport } from "../shared/exports"
import { buildHar } from "../shared/exports/har"
import { buildJsonEnvelope } from "../shared/exports/json-envelope"
import type { UnifiedCapture, ExportMetadata } from "../shared/exports/types"

const META: ExportMetadata = {
  generatorName: "interceptor",
  generatorVersion: "9.9.9",
  generatedAt: new Date("2026-08-20T17:00:00.000Z"),
  source: "net-log",
}

function fixture(): UnifiedCapture[] {
  return [{
    url: "https://x.com/i/api/graphql",
    method: "POST",
    status: 200,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_100,
    durationMs: 100,
    source: "xhr",
    requestHeaders: {
      authorization: "Bearer SECRET-BEARER",
      "x-csrf-token": "SECRET-CSRF",
      cookie: "auth_token=SECRET-COOKIE",
      "x-api-key": "SECRET-KEY",
      "x-custom-token": "SECRET-CUSTOM",
      accept: "application/json",
    },
    responseHeaders: {
      "set-cookie": "session=SECRET-SESSION",
      "content-type": "application/json",
    },
    responseBody: '{"ok":true}',
    responseContentType: "application/json",
    truncated: false,
  }]
}

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("redaction is opt-in (#160, amended)", () => {
  test("default: headers pass through verbatim in both encoders", () => {
    const har = buildHar(fixture(), META)
    const harHeaders = har.log.entries[0].request.headers as Array<{ name: string; value: string }>
    expect(harHeaders.find((h) => h.name === "authorization")?.value).toBe("Bearer SECRET-BEARER")
    const envelope = buildJsonEnvelope(fixture(), META)
    expect(envelope.entries[0].request.headers.authorization).toBe("Bearer SECRET-BEARER")
  })

  test("redactCaptures strips the exact set, the loose token/secret/session match, and set-cookie", () => {
    const [c] = redactCaptures(fixture())
    expect(c.requestHeaders.authorization).toBe("[redacted]")
    expect(c.requestHeaders["x-csrf-token"]).toBe("[redacted]")
    expect(c.requestHeaders.cookie).toBe("[redacted]")
    expect(c.requestHeaders["x-api-key"]).toBe("[redacted]")
    expect(c.requestHeaders["x-custom-token"]).toBe("[redacted]")   // loose /token/i
    expect(c.requestHeaders.accept).toBe("application/json")        // untouched
    expect(c.responseHeaders["set-cookie"]).toBe("[redacted]")
    expect(c.responseHeaders["content-type"]).toBe("application/json")
  })

  test("case-insensitive names are covered", () => {
    expect(redactHeaderRecord({ Authorization: "x", "X-CSRF-Token": "y" }))
      .toEqual({ Authorization: "[redacted]", "X-CSRF-Token": "[redacted]" })
  })

  test("HAR cookies derive from the (redacted) Cookie header, so they carry no values", () => {
    const har = buildHar(redactCaptures(fixture()), META)
    const cookies = har.log.entries[0].request.cookies as Array<{ name: string; value: string }>
    for (const cookie of cookies) expect(cookie.value).not.toContain("SECRET")
    expect(JSON.stringify(har)).not.toContain("SECRET")
  })
})

describe("writeExport file hygiene (#160)", () => {
  test("files are created mode 600 and redactAuth threads through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interceptor-export-test-"))
    cleanups.push(dir)
    const out = join(dir, "capture.har")
    await writeExport({ format: "har", captures: fixture(), meta: META, out, redactAuth: true })
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(readFileSync(out, "utf-8")).not.toContain("SECRET")
  })

  test("default export keeps headers and is still 600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interceptor-export-test-"))
    cleanups.push(dir)
    const out = join(dir, "capture.json")
    await writeExport({ format: "json", captures: fixture(), meta: META, out })
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(readFileSync(out, "utf-8")).toContain("SECRET-BEARER")
  })

  test("a pre-existing world-readable file is re-chmodded to 600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interceptor-export-test-"))
    cleanups.push(dir)
    const out = join(dir, "existing.json")
    writeFileSync(out, "{}")
    chmodSync(out, 0o644)
    await writeExport({ format: "json", captures: fixture(), meta: META, out })
    expect(statSync(out).mode & 0o777).toBe(0o600)
  })
})
