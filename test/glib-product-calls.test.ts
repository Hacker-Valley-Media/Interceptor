import { expect, test } from "bun:test"

test("the shipped Linux overlay does not use glib's affected string iterator", () => {
  const result = Bun.spawnSync(["rg", "-n", "array_iter_str|VariantStrIter", "interceptor-desktop/src", "--glob", "*.rs"], { cwd: new URL("..", import.meta.url).pathname })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(1)
})
