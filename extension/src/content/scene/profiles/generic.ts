import type { SceneProfile } from "../types"
import {
  cursorToAdaptiveScene,
  describeAdaptiveProfile,
  discoverAdaptiveSceneObjects,
  hitTestAdaptiveScene,
  readFocusedWritableText,
  resolveAdaptiveSceneTarget,
  selectedAdaptiveScene,
  writeToFocusedWritableSurface
} from "../adaptive"

export const genericProfile: SceneProfile = {
  name: "generic",

  detect(): boolean {
    return true
  },

  list(opts): ReturnType<typeof discoverAdaptiveSceneObjects> {
    return discoverAdaptiveSceneObjects({ type: opts?.type, profileName: "generic" })
  },

  resolve(id: string) {
    return resolveAdaptiveSceneTarget(id)
  },

  selected() {
    return selectedAdaptiveScene()
  },

  text() {
    return readFocusedWritableText()
  },

  writeAtCursor(text: string) {
    return writeToFocusedWritableSurface(text)
  },

  cursorTo(opts: { x: number; y: number }) {
    return cursorToAdaptiveScene(opts.x, opts.y)
  },

  hitTest(x: number, y: number) {
    return hitTestAdaptiveScene(x, y)
  },

  describe() {
    return describeAdaptiveProfile("generic", [
      "Capability-driven fallback profile",
      "Uses semantics, geometry, focus, and writable-surface detection"
    ])
  }
}
