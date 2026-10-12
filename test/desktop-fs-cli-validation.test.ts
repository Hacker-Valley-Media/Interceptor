import {expect, test} from "bun:test"
import {parseMacosCommand} from "../cli/commands/macos"

test("desktop filesystem numeric flags cannot be truncated or discarded", () => {
  for (const range of ["0.5,2", "0,2.5", "garbage", "1", "1,2,3", ",2", "9007199254740992,2"]) {
    expect(() => parseMacosCommand(["macos", "fs", "read", "/tmp/f", "--byte-range", range], undefined, true)).toThrow()
  }
  for (const flag of ["--limit", "--timeout-ms"]) {
    for (const value of ["1.5", "1junk", "true", "9007199254740992", "--scope"]) {
      expect(() => parseMacosCommand(["macos", "fs", "search", "x", flag, value], undefined, true)).toThrow()
    }
    expect(() => parseMacosCommand(["macos", "fs", "search", "x", flag], undefined, true)).toThrow()
  }
  expect(() => parseMacosCommand(["macos", "fs", "read", "/tmp/f", "--byte-range"], undefined, true)).toThrow()
})

test("desktop filesystem retains zeros for native bounds checks and preserves legacy parsing", () => {
  expect(parseMacosCommand(["macos", "fs", "read", "/tmp/f", "--byte-range", "0,0"], undefined, true)?.byteRange).toEqual({start: 0, length: 0})
  expect(parseMacosCommand(["macos", "fs", "search", "x", "--limit", "0"], undefined, true)?.limit).toBe(0)
  expect(parseMacosCommand(["macos", "fs", "search", "x"], undefined, true)?.limit).toBe(50)
  expect(parseMacosCommand(["macos", "fs", "read", "/tmp/f", "--byte-range", "1.5,2.5"])?.byteRange).toEqual({start: 1, length: 2})
  expect(parseMacosCommand(["macos", "fs", "search", "x", "--limit", "0"])?.limit).toBe(50)
})
