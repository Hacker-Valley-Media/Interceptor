// Content scripts load as classic scripts: a top-level `export` in the bundle is a
// syntax error and the page gets no Interceptor at all. Unit tests import the
// TypeScript modules, so only a real bundle shows it.
import { expect, test } from "bun:test"
import { resolve } from "node:path"

for (const entry of ["extension/src/content.ts", "extension/src/net-buffer-content.ts"]) {
  test(`${entry} bundles with no top-level export`, async () => {
    const out = await Bun.build({ entrypoints: [resolve(import.meta.dir, "..", entry)], target: "browser" })
    expect(out.success).toBe(true)
    const code = await out.outputs[0].text()
    expect(code).not.toMatch(/^export\s*[{*]|^export\s+(const|function|class|default)\b/m)
  })
}
