import { expect, test } from "bun:test"

test("the shipped Linux overlay does not use glib's affected string iterator", async () => {
  const root = new URL("../interceptor-desktop/src/", import.meta.url).pathname
  const files = [...new Bun.Glob("**/*.rs").scanSync(root)]
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) expect(await Bun.file(`${root}/${file}`).text(), file).not.toMatch(/array_iter_str|VariantStrIter/)
})
