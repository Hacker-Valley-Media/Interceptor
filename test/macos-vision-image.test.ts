import { describe, expect, spyOn, test } from "bun:test"
import { isAbsolute, join } from "node:path"
import { parseMacosCommand } from "../cli/commands/macos"

// `macos vision --image <path>` runs Vision over a saved file. The bridge's
// working directory is "/", so the CLI owns path resolution, and a dropped
// flag would silently recognize the frontmost window instead.

function parse(...args: string[]): Record<string, unknown> {
  return parseMacosCommand(["macos", "vision", ...args]) as Record<string, unknown>
}

/** Run a parse that is expected to exit; returns the exit code and stderr text. */
function parseExpectingExit(...args: string[]): { code: number | undefined; stderr: string } {
  const lines: string[] = []
  const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")) })
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`) }) as never)
  let code: number | undefined
  try { parse(...args) } catch (e) { code = Number(String((e as Error).message).split(":")[1]) }
  err.mockRestore(); exit.mockRestore()
  return { code, stderr: lines.join("\n") }
}

describe("macos vision --image", () => {
  test("an absolute path is sent as given", () => {
    const action = parse("text", "--image", "/tmp/shot.png")
    expect(action).toMatchObject({ type: "macos_vision", sub: "text", imagePath: "/tmp/shot.png" })
    expect(action.app).toBeUndefined()
  })

  test("a relative path is resolved against the caller's working directory", () => {
    const action = parse("text", "--image", "shots/a.png")
    expect(isAbsolute(action.imagePath as string)).toBe(true)
    expect(action.imagePath).toBe(join(process.cwd(), "shots/a.png"))
  })

  test("every vision verb carries the image path", () => {
    for (const verb of ["text", "faces", "hands", "bodies", "classify", "saliency"]) {
      expect(parse(verb, "--image", "/tmp/a.jpg")).toMatchObject({ sub: verb, imagePath: "/tmp/a.jpg" })
    }
  })

  test("--image with no value is a usage error, not a window capture", () => {
    const { code, stderr } = parseExpectingExit("text", "--image")
    expect(code).toBe(1)
    expect(stderr).toContain("--image requires a path")
  })

  test("--image followed by another flag is a usage error", () => {
    const { code, stderr } = parseExpectingExit("text", "--image", "--debug-dump", "/tmp/d.jpg")
    expect(code).toBe(1)
    expect(stderr).toContain("--image requires a path")
  })

  test("--image with --app is refused: a file and a window are different sources", () => {
    const { code, stderr } = parseExpectingExit("text", "--image", "/tmp/a.png", "--app", "Finder")
    expect(code).toBe(1)
    expect(stderr).toContain("not both")
  })

  test("window capture parsing is unchanged", () => {
    expect(parse("text", "--app", "Finder")).toMatchObject({ type: "macos_vision", sub: "text", app: "Finder" })
    expect(parse("text", "--app", "Finder").imagePath).toBeUndefined()
    expect(parse()).toMatchObject({ type: "macos_vision", sub: "text" })
    expect(parse("faces", "--debug-dump", "/tmp/d.jpg")).toMatchObject({ sub: "faces", debugDumpPath: "/tmp/d.jpg" })
  })

  test("--debug-dump still works with a file source", () => {
    expect(parse("text", "--image", "/tmp/a.png", "--debug-dump", "/tmp/d.jpg"))
      .toMatchObject({ imagePath: "/tmp/a.png", debugDumpPath: "/tmp/d.jpg" })
  })
})
