import { describe, expect, test } from "bun:test"
import { parseMacosCommand } from "../cli/commands/macos"

// Parser fixes found by the desktop parity batches. Each case failed before its fix.
const desktop = (...args: string[]) => parseMacosCommand(["macos", ...args], undefined, true) as Record<string, any>
const legacy = (...args: string[]) => parseMacosCommand(["macos", ...args]) as Record<string, any>

describe("desktop parser fixes", () => {
  test("tree --background-only is accepted without sending a field the tree contract lacks", () => {
    expect(desktop("tree", "--pid", "42", "--background-only").backgroundOnly).toBeUndefined()
  })
  test("app with only flags defaults to activate", () => {
    expect(desktop("app", "--pid", "42")).toMatchObject({ subcommand: "activate", pid: 42 })
    expect(desktop("app", "hide", "--pid", "42")).toMatchObject({ subcommand: "hide", pid: 42 })
  })
  test("scroll with only flags keeps the default direction and amount", () => {
    expect(desktop("scroll", "--ref", "e1", "--pid", "42")).toMatchObject({ direction: "down", amount: 300, ref: "e1" })
    expect(desktop("scroll", "up", "120", "--pid", "42")).toMatchObject({ direction: "up", amount: 120 })
    expect(legacy("scroll", "--ref", "e1")).toMatchObject({ direction: "down", amount: 300 })
  })
  test("clipboard write requires the text and never writes a flag name", () => {
    expect(() => desktop("clipboard", "write", "--image", "p.png")).toThrow("clipboard write requires the text")
    expect(desktop("clipboard", "write", "hello").text).toBe("hello")
  })
  test("display move-window sends the native window and display ids", () => {
    expect(desktop("display", "move-window", "4247", "1")).toMatchObject({ sub: "move-window", windowId: 4247, displayId: 1 })
    expect(() => desktop("display", "move-window", "x", "1")).toThrow("display move-window requires")
  })
  test("container --volume reads host:/guest[:ro|rw]", () => {
    const mounts = (value: string) => (desktop("container", "run", "alpine", "--volume", value, "--", "echo", "ok").mounts as unknown[])[0]
    expect(mounts("/h/a:/g:ro")).toEqual({ hostPath: "/h/a", mountPath: "/g", mode: "ro" })
    expect(mounts("/h/a:/g")).toEqual({ hostPath: "/h/a", mountPath: "/g", mode: "ro" })
    expect(mounts("/h/a:/g:rw")).toEqual({ hostPath: "/h/a", mountPath: "/g", mode: "rw" })
  })
})
