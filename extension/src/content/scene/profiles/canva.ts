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

export const canvaProfile: SceneProfile = {
  name: "canva",
  autoDetect: false,

  detect(): boolean {
    return false
  },

  list(opts) {
    return discoverAdaptiveSceneObjects({ type: opts?.type, profileName: "canva" })
  },

  resolve(id: string) {
    return resolveAdaptiveSceneTarget(id)
  },

  selected() {
    return selectedAdaptiveScene()
  },

  zoom(): number {
    const all = Array.from(document.querySelectorAll('[style*="scale"]')) as HTMLElement[]
    for (const el of all) {
      const m = (el.style.transform || "").match(/scale\(([\d.]+)\)/)
      if (m) {
        const s = parseFloat(m[1])
        if (s > 0 && s < 10) return s
      }
    }
    return 1
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
    return describeAdaptiveProfile("canva", [
      "Optional adapter alias",
      "Delegates to capability-driven discovery instead of vendor-specific ids"
    ])
  }
}
