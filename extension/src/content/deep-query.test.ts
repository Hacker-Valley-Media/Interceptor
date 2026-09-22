import { expect, test } from "bun:test"

// The cases live in deep-query.check.ts and run in a child process. Bun's
// mock.module is process-wide: five suites mock ./element-discovery (three
// with getShadowRoot: () => null), so inside the full run every shadow case
// fails here, and the runner's diff of happy-dom nodes grew to 77 GB before
// the OS killed it (CI exit 137). Same isolation as sensitive.test.ts.
test("deep-query cases pass in an isolated process", async () => {
  const script = new URL("./deep-query.check.ts", import.meta.url).pathname
  const child = Bun.spawn([process.execPath, "run", script], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, `${out}\n${err}`).toBe(0)
  expect(out).toMatch(/(\d+) of \1 passed/)
}, 30_000)
