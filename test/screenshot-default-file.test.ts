// A text-mode screenshot is written to a file; --data-url keeps the old output.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseScreenshotCommand, tempScreenshotDir, writeTempScreenshot } from "../cli/commands/screenshot"

test("temp screenshots land under <TMPDIR>/interceptor/screenshots", () => {
  const base = mkdtempSync(join(tmpdir(), "screenshot-file-"))
  try {
    const path = writeTempScreenshot(new Uint8Array([1, 2, 3]), "png", base)
    expect(path.startsWith(join(base, "interceptor", "screenshots") + "/")).toBe(true)
    expect(path.endsWith(".png")).toBe(true)
    expect([...readFileSync(path)]).toEqual([1, 2, 3])
    expect(tempScreenshotDir(base)).toBe(join(base, "interceptor", "screenshots"))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("--data-url is parsed for foreground and background captures", () => {
  expect(parseScreenshotCommand(["screenshot", "--data-url"]).dataUrl).toBe(true)
  expect(parseScreenshotCommand(["screenshot", "--background", "--data-url"]).dataUrl).toBe(true)
  expect(parseScreenshotCommand(["screenshot"]).dataUrl).toBeUndefined()
})
