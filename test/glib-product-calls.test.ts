import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("the shipped Linux overlay does not use glib's affected string iterator", async () => {
  const root = fileURLToPath(new URL("../interceptor-desktop/src/", import.meta.url))
  const files = [...new Bun.Glob("**/*.rs").scanSync(root)]
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) expect(await Bun.file(`${root}/${file}`).text(), file).not.toMatch(/array_iter_str|VariantStrIter/)
})
