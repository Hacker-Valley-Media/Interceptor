import { describe, expect, test } from "bun:test"
import { isProcessAlive } from "../shared/process-liveness"

function errorWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

describe("process liveness probe", () => {
  test("returns true when signal zero succeeds", () => {
    expect(isProcessAlive(123, () => {})).toBe(true)
  })

  test("treats EPERM as alive because the process exists but is protected", () => {
    expect(isProcessAlive(123, () => { throw errorWithCode("EPERM") })).toBe(true)
  })

  test("treats ESRCH as dead", () => {
    expect(isProcessAlive(123, () => { throw errorWithCode("ESRCH") })).toBe(false)
  })
})
