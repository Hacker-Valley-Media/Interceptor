import { describe, test, expect } from "bun:test"
import { parseSceneCommand } from "../cli/commands/scene"

describe("interceptor scene CLI parser", () => {
  test("scene profile returns the right action", async () => {
    const a = await parseSceneCommand(["scene", "profile"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_profile")
    expect(a!.verbose).toBeFalsy()
  })

  test("scene profile --verbose flags verbose", async () => {
    const a = await parseSceneCommand(["scene", "profile", "--verbose"], false)
    expect(a).not.toBeNull()
    expect(a!.verbose).toBe(true)
  })

  test("scene list --type shape filters", async () => {
    const a = await parseSceneCommand(["scene", "list", "--type", "shape"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_list")
    expect(a!.filter).toBe("shape")
  })

  test("scene click requires id", async () => {
    const a = await parseSceneCommand(["scene", "click", "LBabcdef01234567"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_click")
    expect(a!.id).toBe("LBabcdef01234567")
  })

  test("scene click --os sets os flag", async () => {
    const a = await parseSceneCommand(["scene", "click", "LBabcdef01234567", "--os"], false)
    expect(a).not.toBeNull()
    expect(a!.os).toBe(true)
  })

  test("scene text with --with-html flag", async () => {
    const a = await parseSceneCommand(["scene", "text", "--with-html"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_text")
    expect(a!.withHtml).toBe(true)
  })

  test("scene insert joins text arguments", async () => {
    const a = await parseSceneCommand(["scene", "insert", "hello", "from", "interceptor"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_insert")
    expect(a!.text).toBe("hello from interceptor")
  })

  test("scene slide list returns slide_list action", async () => {
    const a = await parseSceneCommand(["scene", "slide", "list"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_slide_list")
  })

  test("scene slide goto takes a numeric index", async () => {
    const a = await parseSceneCommand(["scene", "slide", "goto", "5"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_slide_goto")
    expect(a!.index).toBe(5)
  })

  test("scene slide <n> is shorthand for goto <n>", async () => {
    const a = await parseSceneCommand(["scene", "slide", "7"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_slide_goto")
    expect(a!.index).toBe(7)
  })

  test("scene notes with --slide override", async () => {
    const a = await parseSceneCommand(["scene", "notes", "--slide", "3"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_notes")
    expect(a!.slideIndex).toBe(3)
  })

  test("scene render requires id", async () => {
    const a = await parseSceneCommand(["scene", "render", "page-0"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_render")
    expect(a!.id).toBe("page-0")
  })

  test("scene zoom returns scene_zoom action", async () => {
    const a = await parseSceneCommand(["scene", "zoom"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_zoom")
  })

  test("scene selected returns scene_selected action", async () => {
    const a = await parseSceneCommand(["scene", "selected"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_selected")
  })

  test("scene hit takes comma coordinates", async () => {
    const a = await parseSceneCommand(["scene", "hit", "400,500"], false)
    expect(a).not.toBeNull()
    expect(a!.type).toBe("scene_hit")
    expect(a!.x).toBe(400)
    expect(a!.y).toBe(500)
  })

  test("scene --profile override propagates", async () => {
    const a = await parseSceneCommand(["scene", "list", "--profile", "canva"], false)
    expect(a).not.toBeNull()
    expect(a!.profile).toBe("canva")
  })
})
