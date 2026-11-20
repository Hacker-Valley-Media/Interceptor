import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { checkExtensionCode } from "../scripts/check-extension-code"

test("the bundled OCR worker and offscreen document only load packaged code", () => {
  const dir = mkdtempSync(join(tmpdir(), "interceptor-ocr-code-"))
  try {
    mkdirSync(join(dir, "tesseract"))
    for (const [entry, output, ...flags] of [
      ["extension/src/offscreen.ts", "offscreen.js"],
      ["extension/src/tesseract-worker.ts", "tesseract/worker.min.js", "--minify", "--format=iife", "--define=global=globalThis"],
    ]) {
      const result = Bun.spawnSync([process.execPath, "build", entry, "--target=browser", "--outfile=" + join(dir, output), ...flags], {
        cwd: resolve(import.meta.dir, ".."),
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
    }
    checkExtensionCode(dir)
    // new Worker(path) loads a classic script and supplies no Node global.
    const listeners: string[] = []
    runInNewContext(readFileSync(join(dir, "tesseract/worker.min.js"), "utf8"), {
      addEventListener: (event: string) => listeners.push(event),
    })
    expect(listeners).toContain("message")

    // The store checks every script, including ones outside the OCR bundles.
    const extra = join(dir, "extra.js")
    for (const code of [
      'const url = "https://other.example/worker.mjs?build=1"',
      'new Worker("https://other.example/code")',
      'new Blob(["importScripts(path)"])',
      'new Function("return 1")',
      'eval("1")',
    ]) {
      writeFileSync(extra, code)
      expect(() => checkExtensionCode(dir)).toThrow("extra.js")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
