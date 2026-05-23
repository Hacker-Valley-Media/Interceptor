import { describe, expect, test } from "bun:test"
import { parseMacosCommand } from "../cli/commands/macos"

describe("macos parser", () => {
  test("menu --app keeps the app name out of the menu path", () => {
    const action = parseMacosCommand(["macos", "menu", "--app", "TextEdit"]) as Record<string, unknown>
    expect(action.type).toBe("macos_menu")
    expect(action.app).toBe("TextEdit")
    expect(action.items).toBeUndefined()
  })

  test("menu positional items still parse as a menu path", () => {
    const action = parseMacosCommand(["macos", "menu", "Window", "Bring All to Front"]) as Record<string, unknown>
    expect(action.type).toBe("macos_menu")
    expect(action.items).toEqual(["Window", "Bring All to Front"])
  })

  test("inspect with a ref uses the raw inspect action", () => {
    const action = parseMacosCommand(["macos", "inspect", "e5"]) as Record<string, unknown>
    expect(action.type).toBe("macos_inspect")
    expect(action.ref).toBe("e5")
  })

  test("bare inspect uses the compound inspect action", () => {
    const action = parseMacosCommand(["macos", "inspect"]) as Record<string, unknown>
    expect(action.type).toBe("macos_compound")
    expect(action.sub).toBe("inspect")
  })

  test("inspect with --app keeps the compound inspect action", () => {
    const action = parseMacosCommand(["macos", "inspect", "--app", "TextEdit"]) as Record<string, unknown>
    expect(action.type).toBe("macos_compound")
    expect(action.sub).toBe("inspect")
    expect(action.app).toBe("TextEdit")
  })

  test("open is background-first by default — no --activate means activate=false", () => {
    const action = parseMacosCommand(["macos", "open", "TextEdit"]) as Record<string, unknown>
    expect(action.type).toBe("macos_compound")
    expect(action.sub).toBe("open")
    expect(action.app).toBe("TextEdit")
    expect(action.activate).toBe(false)
  })

  test("open --activate sets activate=true so the bridge will foreground", () => {
    const action = parseMacosCommand(["macos", "open", "TextEdit", "--activate"]) as Record<string, unknown>
    expect(action.type).toBe("macos_compound")
    expect(action.sub).toBe("open")
    expect(action.activate).toBe(true)
  })

  test("click --app routes the synthesized event to a specific PID via the bridge", () => {
    const action = parseMacosCommand(["macos", "click", "100,200", "--app", "TextEdit"]) as Record<string, unknown>
    expect(action.type).toBe("macos_click")
    expect(action.coords).toBe("100,200")
    expect(action.app).toBe("TextEdit")
  })

  test("type --app carries the app target through to the bridge", () => {
    const action = parseMacosCommand(["macos", "type", "hello", "--app", "TextEdit"]) as Record<string, unknown>
    expect(action.type).toBe("macos_type")
    expect(action.text).toBe("hello")
    expect(action.app).toBe("TextEdit")
  })

  test("keys --pid carries an explicit PID target through to the bridge", () => {
    const action = parseMacosCommand(["macos", "keys", "Meta+A", "--pid", "1234"]) as Record<string, unknown>
    expect(action.type).toBe("macos_keys")
    expect(action.keys).toBe("Meta+A")
    expect(action.pid).toBe(1234)
  })

  test("drag --app carries app target through to the bridge", () => {
    const action = parseMacosCommand(["macos", "drag", "100,100", "200,200", "--app", "Finder"]) as Record<string, unknown>
    expect(action.type).toBe("macos_drag")
    expect(action.app).toBe("Finder")
  })

  test("capture frame defaults to no explicit timeout", () => {
    const action = parseMacosCommand(["macos", "capture", "frame"]) as Record<string, unknown>
    expect(action.type).toBe("macos_capture")
    expect(action.sub).toBe("frame")
    expect(action.timeoutMs).toBeUndefined()
  })

  test("capture frame --timeout-ms threads through to the bridge", () => {
    const action = parseMacosCommand(["macos", "capture", "frame", "--timeout-ms", "3000"]) as Record<string, unknown>
    expect(action.type).toBe("macos_capture")
    expect(action.sub).toBe("frame")
    expect(action.timeoutMs).toBe(3000)
  })

  test("trust with no flags is read-only — no prompt fields are true", () => {
    const action = parseMacosCommand(["macos", "trust"]) as Record<string, unknown>
    expect(action.type).toBe("macos_trust")
    expect(action.noPrompt).toBe(false)
    expect(action.prompt).toBe(false)
    expect(action.walkthrough).toBe(false)
    expect(action.accessibilityPrompt).toBe(false)
    expect(action.screenPrompt).toBe(false)
    expect(action.microphonePrompt).toBe(false)
  })

  test("trust --prompt fans out to all three prompt families", () => {
    const action = parseMacosCommand(["macos", "trust", "--prompt"]) as Record<string, unknown>
    expect(action.prompt).toBe(true)
    expect(action.walkthrough).toBe(false)
    expect(action.noPrompt).toBe(false)
  })

  test("trust --walkthrough implies prompt", () => {
    const action = parseMacosCommand(["macos", "trust", "--walkthrough"]) as Record<string, unknown>
    expect(action.prompt).toBe(true)
    expect(action.walkthrough).toBe(true)
  })

  test("trust --microphone-prompt only sets the microphone prompt flag", () => {
    const action = parseMacosCommand(["macos", "trust", "--microphone-prompt"]) as Record<string, unknown>
    expect(action.microphonePrompt).toBe(true)
    expect(action.accessibilityPrompt).toBe(false)
    expect(action.screenPrompt).toBe(false)
    expect(action.prompt).toBe(false)
  })

  test("trust --no-prompt forces every prompt flag to false even when others are present", () => {
    const action = parseMacosCommand([
      "macos", "trust",
      "--no-prompt",
      "--prompt",
      "--walkthrough",
      "--accessibility-prompt",
      "--screen-prompt",
      "--microphone-prompt",
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_trust")
    expect(action.noPrompt).toBe(true)
    expect(action.prompt).toBe(false)
    expect(action.walkthrough).toBe(false)
    expect(action.accessibilityPrompt).toBe(false)
    expect(action.screenPrompt).toBe(false)
    expect(action.microphonePrompt).toBe(false)
  })

  test("trust --no-prompt alone yields a clean read-only payload", () => {
    const action = parseMacosCommand(["macos", "trust", "--no-prompt"]) as Record<string, unknown>
    expect(action.noPrompt).toBe(true)
    expect(action.prompt).toBe(false)
  })

  test("tcc status parses target", () => {
    const action = parseMacosCommand(["macos", "tcc", "status", "--target", "host"]) as Record<string, unknown>
    expect(action.type).toBe("macos_tcc_status")
    expect(action.sub).toBe("status")
    expect(action.target).toBe("host")
  })

  test("tcc profile generate parses output and services", () => {
    const action = parseMacosCommand([
      "macos", "tcc", "profile", "generate",
      "--target", "host",
      "--out", "/tmp/interceptor.mobileconfig",
      "--service", "Accessibility,PostEvent",
      "--full-disk",
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_tcc_profile_generate")
    expect(action.sub).toBe("profile_generate")
    expect(action.out).toBe("/tmp/interceptor.mobileconfig")
    expect(action.services).toEqual(["Accessibility", "PostEvent"])
    expect(action.fullDisk).toBe(true)
  })
})
