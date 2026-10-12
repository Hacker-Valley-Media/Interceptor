#!/usr/bin/env bun
// Checks the version a native provider binary was built as, without running it (a Linux or
// Windows binary cannot run on the Mac that packages it). The provider's User-Agent literal
// "Interceptor/<CARGO_PKG_VERSION>" is compiled into every build.
//   bun scripts/provider-version.ts <provider binary> <version>
import { readFileSync } from "node:fs"

export function embedsVersion(binary: Uint8Array, version: string): boolean {
  const bytes = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength)
  const marker = Buffer.from(`Interceptor/${version}`)
  for (let at = bytes.indexOf(marker); at >= 0; at = bytes.indexOf(marker, at + 1)) {
    // String literals are packed without separators. A digit, dot, + or - next means a longer version.
    if (!/[0-9.+-]/.test(String.fromCharCode(bytes[at + marker.length] ?? 0))) return true
  }
  return false
}

if (import.meta.main) {
  const [binary, version] = process.argv.slice(2)
  if (!binary || !version) throw new Error("usage: bun scripts/provider-version.ts <provider binary> <version>")
  if (!embedsVersion(readFileSync(binary), version)) {
    console.error(`${binary} was not built as version ${version}; rebuild it from this checkout.`)
    process.exit(1)
  }
}
