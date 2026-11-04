/**
 * daemon/ios/tree.ts — parse WebDriverAgent's `/source?format=json` snapshot into
 * a ref-registered element tree, mirroring the macOS AccessibilityDomain output
 * (`[e<n>] role "label" value="…"`, indented by depth).
 *
 * Each ref stores the node's frame (rect). Actuation (click/type/scroll/drag) is
 * a deterministic COORDINATE operation at the frame center via WDA's tap/drag
 * endpoints — this sidesteps WDA element-handle staleness (the ref-stability
 * concern): refs are re-minted on every `tree` read and resolve to coordinates,
 * never to opaque server-side element ids that expire.
 *
 * Pure (no I/O) so it is unit tested directly against fixture snapshots.
 */

import type { IosNativeTarget } from "../../shared/ios-automation"

export type IosRect = { x: number; y: number; width: number; height: number }

/** What a ref resolves to: enough to actuate and to `inspect`. */
export type IosElementRef = {
  ref: string
  type: string
  label: string
  name?: string
  value?: string
  enabled: boolean
  frame: IosRect
  target?: IosNativeTarget
  placeholder?: string
  selected?: boolean
  focused?: boolean
}

/** A WDA `/source?format=json` node (XCUIElement snapshot serialization). */
export type WdaSourceNode = {
  type?: string
  label?: string | null
  name?: string | null
  value?: string | null
  rawIdentifier?: string | null
  isEnabled?: boolean | string
  isVisible?: boolean | string
  rect?: { x?: number; y?: number; width?: number; height?: number }
  children?: WdaSourceNode[]
  // WDA variants sometimes nest under different keys; tolerate both.
  [k: string]: unknown
}

/** Mints stable-within-a-walk refs (`e1`, `e2`, …) and resolves them back. */
export class IosRefRegistry {
  private refs = new Map<string, IosElementRef>()
  private counter = 0

  clear(): void {
    this.refs.clear()
    this.counter = 0
  }

  register(el: Omit<IosElementRef, "ref">): IosElementRef {
    this.counter += 1
    const ref = `e${this.counter}`
    const entry: IosElementRef = { ref, ...el }
    this.refs.set(ref, entry)
    return entry
  }

  resolve(ref: string): IosElementRef | undefined {
    return this.refs.get(ref)
  }

  all(): IosElementRef[] {
    return [...this.refs.values()]
  }
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1"
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v)
}

function normalizeRect(rect: WdaSourceNode["rect"]): IosRect {
  return {
    x: Number(rect?.x) || 0,
    y: Number(rect?.y) || 0,
    width: Number(rect?.width) || 0,
    height: Number(rect?.height) || 0,
  }
}

/** Strip the leading `XCUIElementType` so `XCUIElementTypeButton` → `button`. */
export function displayRole(type: string | undefined): string {
  const t = type || "Other"
  return t.replace(/^XCUIElementType/, "").toLowerCase() || "other"
}

const INTERACTIVE_TYPES = new Set([
  "Button", "TextField", "SecureTextField", "TextView", "Switch", "Slider",
  "Cell", "Link", "SearchField", "MenuItem", "Key", "Picker", "PickerWheel",
  "Tab", "SegmentedControl", "Stepper", "CheckBox", "RadioButton", "Toggle",
  "DatePicker", "PageIndicator",
])
const LANDMARK_TYPES = new Set([
  "NavigationBar", "TabBar", "Table", "CollectionView", "ScrollView",
  "Window", "Sheet", "Alert", "Toolbar", "Other", "Application",
])

function bareType(type: string | undefined): string {
  return (type || "Other").replace(/^XCUIElementType/, "")
}

export type FormatTreeOptions = {
  /** "interactive" | "all" | "full" — mirrors AccessibilityDomain filters. Default "all". */
  filter?: string
  maxDepth?: number
  maxChars?: number
}

/**
 * Walk a WDA source snapshot, registering refs and producing the indented text
 * tree. Returns the text plus the populated registry (caller clears it first).
 */
export function formatWdaTree(
  root: WdaSourceNode | undefined,
  registry: IosRefRegistry,
  opts: FormatTreeOptions = {},
): string {
  const filter = opts.filter ?? "all"
  const maxDepth = opts.maxDepth ?? 60
  const maxChars = opts.maxChars ?? 40_000
  let out = ""

  const walk = (node: WdaSourceNode | undefined, depth: number): void => {
    if (!node || depth > maxDepth || out.length > maxChars) return
    const type = bareType(node.type)
    const label = asStr(node.label ?? "")
    const name = asStr(node.name ?? node.rawIdentifier ?? "")
    const value = type === "SecureTextField" ? "" : asStr(node.value ?? "")
    const enabled = node.isEnabled === undefined ? true : asBool(node.isEnabled)
    const frame = normalizeRect(node.rect)

    const interactive = INTERACTIVE_TYPES.has(type)
    const landmark = LANDMARK_TYPES.has(type)
    let include: boolean
    switch (filter) {
      case "interactive": include = interactive; break
      case "all": include = interactive || landmark || !!label || !!value; break
      default: include = true // "full"
    }

    if (include) {
      const entry = registry.register({
        type,
        label: label || name,
        name: name || undefined,
        value: value || undefined,
        enabled,
        frame,
        target: node.target as IosNativeTarget | undefined,
        placeholder: asStr(node.placeholderValue) || undefined,
        selected: node.isSelected === true,
        focused: node.hasFocus === true,
      })
      const indent = "  ".repeat(Math.max(0, depth))
      let line = `${indent}[${entry.ref}] ${displayRole(node.type)}`
      const shown = label || name
      if (shown) line += ` "${shown}"`
      if (value && value !== shown) line += ` value="${value}"`
      if (!enabled) line += " (disabled)"
      if (node.isSelected === true) line += " (selected)"
      if (node.hasFocus === true) line += " (focused)"
      if (node.placeholderValue) line += ` placeholder=${JSON.stringify(asStr(node.placeholderValue))}`
      out += line + "\n"
    }

    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) walk(child, depth + 1)
  }

  walk(root, 0)
  return out.trimEnd()
}

/** Find matching elements for `ios find` (query substring + optional role). */
export function findInTree(
  registry: IosRefRegistry,
  query: string,
  roleFilter?: string,
  maxMatches = 25,
): Array<{ ref: string; role: string; name: string; value?: string; frame: IosRect }> {
  const q = query.toLowerCase()
  const role = roleFilter?.toLowerCase()
  const out: Array<{ ref: string; role: string; name: string; value?: string; frame: IosRect }> = []
  for (const el of registry.all()) {
    if (out.length >= maxMatches) break
    const dRole = displayRole(`XCUIElementType${el.type}`)
    const hay = `${el.label} ${el.name ?? ""} ${el.value ?? ""}`.toLowerCase()
    if (!hay.includes(q)) continue
    if (role && !dRole.includes(role)) continue
    out.push({ ref: el.ref, role: dRole, name: el.label, value: el.value, frame: el.frame })
  }
  return out
}

/** Center point of a ref's frame — the coordinate used for taps/drags. */
export function frameCenter(el: IosElementRef): { x: number; y: number } {
  return { x: Math.round(el.frame.x + el.frame.width / 2), y: Math.round(el.frame.y + el.frame.height / 2) }
}
