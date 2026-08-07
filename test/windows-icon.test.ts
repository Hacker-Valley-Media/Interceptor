import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { readIcoFrames, validateWindowsIcon, WINDOWS_ICON_SIZES } from "../scripts/installer/generate-windows-icon"

describe("Windows product icon", () => {
  const icon = readFileSync(resolve(import.meta.dir, "../assets/windows/interceptor.ico"))

  test("contains the exact RGBA frame set", () => {
    expect(() => validateWindowsIcon(icon)).not.toThrow()
    expect(readIcoFrames(icon).map(frame => frame.width)).toEqual([...WINDOWS_ICON_SIZES])
  })
})
