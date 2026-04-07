export type SceneObjectType = "image" | "shape" | "text" | "group" | "page" | "slide" | "embed" | "unknown"

export interface SceneRect {
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
}

export interface SceneDocCoord {
  x: number
  y: number
  w: number
  h: number
}

export interface SceneObject {
  id: string
  type: SceneObjectType
  rect: SceneRect
  doc?: SceneDocCoord
  text?: string
  extras?: Record<string, unknown>
}

export interface SceneSelection {
  has: boolean
  label?: string
  id?: string
  text?: string
  extras?: Record<string, unknown>
}

export interface SceneText {
  text: string
  html?: string
  length: number
}

export interface SceneRenderResult {
  id: string
  width: number
  height: number
  dataUrl: string
  format: "png" | "jpeg"
}

export interface SceneSlideInfo {
  index: number
  id: string
  rect: SceneRect
  blobUrl?: string
  current?: boolean
}

export interface SceneProfile {
  name: string
  detect(): boolean
  list?(opts?: { type?: string }): SceneObject[]
  resolve?(id: string): Element | null
  selected?(): SceneSelection
  zoom?(): number
  text?(opts?: { withHtml?: boolean }): SceneText | null
  writeAtCursor?(text: string): { success: boolean; error?: string }
  cursorTo?(opts: { x: number; y: number }): { success: boolean; error?: string }
  render?(id: string): Promise<SceneRenderResult | null>
  slides?(): SceneSlideInfo[]
  slideCurrent?(): SceneSlideInfo | null
  slideGoto?(index: number): { success: boolean; error?: string }
  notes?(slideIndex?: number): string | null
  hitTest?(x: number, y: number): SceneObject | null
}

export interface SceneEngineResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  profile?: string
}
