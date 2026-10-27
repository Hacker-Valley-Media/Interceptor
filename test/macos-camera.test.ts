import { describe, expect, test } from "bun:test"
import { isAbsolute, join } from "node:path"
import { parseMacosCommand } from "../cli/commands/macos"
import { pickTimeoutForAction, timeoutMessage } from "../cli/transport"

// `macos camera` parses to one macos_camera action per subcommand. The bridge's
// working directory is "/", so the CLI owns --out path resolution.

function parse(...args: string[]): Record<string, unknown> {
  return parseMacosCommand(["macos", "camera", ...args]) as Record<string, unknown>
}

describe("macos camera", () => {
  test("each subcommand becomes a macos_camera action", () => {
    for (const sub of ["list", "start", "frame", "status", "stop"]) {
      expect(parse(sub)).toEqual({ type: "macos_camera", sub })
    }
  })

  test("a bare camera is status", () => {
    expect(parse()).toEqual({ type: "macos_camera", sub: "status" })
  })

  test("start carries the device selector and fps", () => {
    expect(parse("start", "--device", "PedPhone Camera", "--fps", "5")).toEqual({ type: "macos_camera", sub: "start", device: "PedPhone Camera", fps: 5 })
  })

  test("--prompt is a bare flag, on start only", () => {
    expect(parse("start", "--prompt")).toEqual({ type: "macos_camera", sub: "start", prompt: true })
    expect(parse("start", "--device", "FaceTime", "--prompt", "--fps", "5")).toEqual({ type: "macos_camera", sub: "start", device: "FaceTime", fps: 5, prompt: true })
    expect(parse("start", "--device", "FaceTime")).not.toHaveProperty("prompt")
    expect(() => parse("frame", "--prompt")).toThrow("camera frame does not take --prompt")
    expect(() => parse("start", "--prompt", "yes")).toThrow("camera start does not take yes")
    expect(() => parse("start", "--prompt", "--prompt")).toThrow("repeated flag: --prompt")
    expect(() => parse("start", "--device", "--prompt")).toThrow("--device requires a value")
  })

  test("frame resolves --out against the caller's working directory", () => {
    const action = parse("frame", "--out", "shots/f.jpg", "--max-long-edge", "640", "--quality", "80", "--timeout-ms", "1500")
    expect(isAbsolute(action.out as string)).toBe(true)
    expect(action).toMatchObject({ out: join(process.cwd(), "shots/f.jpg"), maxLongEdge: 640, quality: 80, timeoutMs: 1500 })
  })

  test("an absolute --out is sent as given", () => {
    expect(parse("frame", "--out", "/tmp/f.jpg").out).toBe("/tmp/f.jpg")
  })

  test("unknown subcommands and flags that belong elsewhere are refused", () => {
    expect(() => parse("record")).toThrow("camera requires list, start, frame, status or stop")
    expect(() => parse("start", "--out", "/tmp/f.jpg")).toThrow("camera start does not take --out")
    expect(() => parse("frame", "--device", "x")).toThrow("camera frame does not take --device")
    expect(() => parse("list", "--fps", "5")).toThrow("camera list does not take --fps")
  })

  test("flag values are required, bounded integers, and not repeated", () => {
    expect(() => parse("frame", "--out")).toThrow("--out requires a value")
    expect(() => parse("frame", "--out", "")).toThrow("--out requires a value")
    expect(() => parse("start", "--device", "")).toThrow("--device requires a value")
    expect(() => parse("start", "--fps", "--device")).toThrow("--fps requires a value")
    expect(() => parse("start", "--fps", "0")).toThrow("--fps must be an integer from 1 to 30")
    expect(() => parse("start", "--fps", "60")).toThrow("--fps must be an integer from 1 to 30")
    expect(() => parse("frame", "--quality", "8.5")).toThrow("--quality must be an integer from 1 to 100")
    expect(() => parse("frame", "--max-long-edge", "4")).toThrow("--max-long-edge must be an integer from 16 to 8192")
    expect(() => parse("start", "--fps", "5", "--fps", "6")).toThrow("repeated flag: --fps")
  })

  test("a camera timeout points at the camera prompt", () => {
    expect(timeoutMessage("macos_camera", 125_000)).toContain("Camera for camera start --prompt")
  })

  test("start --prompt outlasts the camera prompt, a plain start does not wait for one, and frame outlasts its own wait", () => {
    expect(pickTimeoutForAction(parse("start", "--prompt") as never)).toBeGreaterThanOrEqual(125_000)
    expect(pickTimeoutForAction(parse("start") as never)).toBe(pickTimeoutForAction(parse("status") as never))
    expect(pickTimeoutForAction(parse("frame", "--timeout-ms", "50000") as never)).toBeGreaterThanOrEqual(55_000)
  })
})
