// A text-mode screenshot is written to a file; --data-url keeps the old output.
import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs"
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
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(base, "interceptor")).mode & 0o777).toBe(0o700)
    }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("a shared temp folder (no TMPDIR) gets a folder per user", () => {
  const saved = process.env.TMPDIR
  delete process.env.TMPDIR
  try {
    expect(tempScreenshotDir(undefined, 1000)).toBe(join(tmpdir(), "interceptor-1000", "screenshots"))
  } finally { if (saved !== undefined) process.env.TMPDIR = saved }
})

test("--data-url is parsed for foreground and background captures", () => {
  expect(parseScreenshotCommand(["screenshot", "--data-url"]).dataUrl).toBe(true)
  expect(parseScreenshotCommand(["screenshot", "--background", "--data-url"]).dataUrl).toBe(true)
  expect(parseScreenshotCommand(["screenshot"]).dataUrl).toBeUndefined()
})

test.skipIf(process.platform === "win32")("an older open folder is made private; a linked screenshots folder is refused", () => {
  const base = mkdtempSync(join(tmpdir(), "screenshot-file-"))
  try {
    mkdirSync(join(base, "interceptor", "screenshots"), { recursive: true })
    chmodSync(join(base, "interceptor"), 0o755)
    chmodSync(join(base, "interceptor", "screenshots"), 0o775)
    writeTempScreenshot(new Uint8Array([1]), "png", base)
    expect(statSync(join(base, "interceptor")).mode & 0o777).toBe(0o700)
    expect(statSync(join(base, "interceptor", "screenshots")).mode & 0o777).toBe(0o700)
    rmSync(join(base, "interceptor", "screenshots"), { recursive: true })
    mkdirSync(join(base, "elsewhere"))
    symlinkSync(join(base, "elsewhere"), join(base, "interceptor", "screenshots"))
    expect(() => writeTempScreenshot(new Uint8Array([1]), "png", base)).toThrow("not a folder of this user")
  } finally { rmSync(base, { recursive: true, force: true }) }
})
