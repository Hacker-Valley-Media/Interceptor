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

  test("macos monitor start parses task metadata", () => {
    const action = parseMacosCommand([
      "macos", "monitor", "start",
      "--task", "Teach Slack triage",
      "--mode", "human-teach",
      "--app", "Slack",
      "--retention-policy", "retain-short",
      "--guard-policy", "approval-required",
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_monitor")
    expect(action.sub).toBe("start")
    expect(action.taskRef).toBe("Teach Slack triage")
    expect(action.taskMode).toBe("human-teach")
    expect(action.app).toBe("Slack")
    expect(action.retentionPolicyId).toBe("retain-short")
    expect(action.guardPolicyId).toBe("approval-required")
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

  test("intent dispatch parses pure JXA", () => {
    const action = parseMacosCommand(["macos", "intent", "dispatch", "--jxa", "1 + 1"]) as Record<string, unknown>
    expect(action.type).toBe("macos_intent_dispatch")
    expect(action.jxa).toBe("1 + 1")
    expect(action.bundleId).toBeUndefined()
  })

  test("intent dispatch parses bundle-targeted JXA", () => {
    const action = parseMacosCommand([
      "macos", "intent", "dispatch",
      "--bundle", "com.apple.finder",
      "--jxa", "target.name()"
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_intent_dispatch")
    expect(action.bundleId).toBe("com.apple.finder")
    expect(action.jxa).toBe("target.name()")
  })

  test("intent dispatch keeps deprecated --javascript as a JXA alias", () => {
    const action = parseMacosCommand(["macos", "intent", "dispatch", "--javascript", "1 + 1"]) as Record<string, unknown>
    expect(action.type).toBe("macos_intent_dispatch")
    expect(action.jxa).toBe("1 + 1")
  })

  test("script run parses pure JXA", () => {
    const action = parseMacosCommand(["macos", "script", "run", "--jxa", "1 + 1"]) as Record<string, unknown>
    expect(action.type).toBe("macos_script_run")
    expect(action.jxa).toBe("1 + 1")
    expect(action.bundleId).toBeUndefined()
  })

  test("script run parses bundle-targeted JXA", () => {
    const action = parseMacosCommand([
      "macos", "script", "run",
      "--bundle", "com.apple.finder",
      "--jxa", "target.name()"
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_script_run")
    expect(action.bundleId).toBe("com.apple.finder")
    expect(action.jxa).toBe("target.name()")
  })

  test("script run parses JXA argv", () => {
    const action = parseMacosCommand([
      "macos", "script", "run",
      "--jxa", "run = argv => argv.join('|')",
      "--args", "[\"alpha\",\"beta\"]"
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_script_run")
    expect(action.args).toEqual(["alpha", "beta"])
  })

  test("script run parses JavaScriptCore inline source", () => {
    const action = parseMacosCommand(["macos", "script", "run", "--jsc", "1 + 1"]) as Record<string, unknown>
    expect(action.type).toBe("macos_script_run")
    expect(action.jsc).toBe("1 + 1")
    expect(action.bundleId).toBeUndefined()
  })

  test("script run parses JavaScriptCore argv", () => {
    const action = parseMacosCommand([
      "macos", "script", "run",
      "--jsc", "run = argv => argv.join('|')",
      "--args", "[\"alpha\",\"beta\"]"
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_script_run")
    expect(action.jsc).toBe("run = argv => argv.join('|')")
    expect(action.args).toEqual(["alpha", "beta"])
  })

  // help advertises `tree --max-chars` but the parser
  // used to drop it. These lock the fix so the drift cannot regress.
  test("tree --max-chars is forwarded to the bridge", () => {
    const action = parseMacosCommand(["macos", "tree", "--app", "Finder", "--max-chars", "1000"]) as Record<string, unknown>
    expect(action.type).toBe("macos_tree")
    expect(action.maxChars).toBe(1000)
  })

  test("tree without --max-chars defaults to 50000", () => {
    const action = parseMacosCommand(["macos", "tree", "--app", "Finder"]) as Record<string, unknown>
    expect(action.type).toBe("macos_tree")
    expect(action.maxChars).toBe(50000)
  })

  test("tree still forwards app/pid/filter/depth alongside max-chars", () => {
    const action = parseMacosCommand([
      "macos", "tree", "--pid", "4242", "--filter", "all", "--depth", "5", "--max-chars", "20000",
    ]) as Record<string, unknown>
    expect(action.pid).toBe(4242)
    expect(action.filter).toBe("all")
    expect(action.depth).toBe(5)
    expect(action.maxChars).toBe(20000)
  })

  // traversal-bound flags reach the bridge (which clamps them).
  test("tree forwards --max-nodes and --max-ms when present", () => {
    const action = parseMacosCommand([
      "macos", "tree", "--app", "Finder", "--max-nodes", "500", "--max-ms", "3000",
    ]) as Record<string, unknown>
    expect(action.maxNodes).toBe(500)
    expect(action.maxMs).toBe(3000)
  })

  test("tree omits max-nodes/max-ms when absent (bridge applies defaults)", () => {
    const action = parseMacosCommand(["macos", "tree", "--app", "Finder"]) as Record<string, unknown>
    expect(action.maxNodes).toBeUndefined()
    expect(action.maxMs).toBeUndefined()
  })

  // find/focused/windows now forward --pid (previously dropped).
  test("find forwards --pid and traversal bounds", () => {
    const action = parseMacosCommand([
      "macos", "find", "Save", "--pid", "77", "--max-nodes", "800",
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_find")
    expect(action.query).toBe("Save")
    expect(action.pid).toBe(77)
    expect(action.maxNodes).toBe(800)
  })

  test("focused and windows forward --pid", () => {
    const f = parseMacosCommand(["macos", "focused", "--pid", "88"]) as Record<string, unknown>
    expect(f.type).toBe("macos_focused")
    expect(f.pid).toBe(88)
    const w = parseMacosCommand(["macos", "windows", "--pid", "99"]) as Record<string, unknown>
    expect(w.type).toBe("macos_windows")
    expect(w.pid).toBe(99)
  })

  // PhotosDomain casts size with `as? Int` — a string forward is silently
  // dropped and the resize/encode branch becomes unreachable (#187).
  test("photos export forwards --size as an int and --format as a string", () => {
    const action = parseMacosCommand([
      "macos", "photos", "export", "ABC/L0/001", "--out", "/tmp/x.png", "--size", "400", "--format", "png",
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_photos")
    expect(action.size).toBe(400)
    expect(action.format).toBe("png")
    expect(action.out).toBe("/tmp/x.png")
  })

  test("photos thumbnail forwards --size as an int", () => {
    const action = parseMacosCommand([
      "macos", "photos", "thumbnail", "ABC/L0/001", "--size", "512",
    ]) as Record<string, unknown>
    expect(action.type).toBe("macos_photos")
    expect(action.size).toBe(512)
  })
})
