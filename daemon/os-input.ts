import { dlopen, FFIType } from "bun:ffi"

const CG_PATH = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"

const cg = dlopen(CG_PATH, {
  CGEventCreateMouseEvent: {
    args: [FFIType.ptr, FFIType.i32, FFIType.f64, FFIType.f64, FFIType.i32],
    returns: FFIType.ptr,
  },
  CGEventCreateKeyboardEvent: {
    args: [FFIType.ptr, FFIType.u16, FFIType.bool],
    returns: FFIType.ptr,
  },
  CGEventPost: {
    args: [FFIType.i32, FFIType.ptr],
    returns: FFIType.void,
  },
  CGEventPostToPid: {
    args: [FFIType.i32, FFIType.ptr],
    returns: FFIType.void,
  },
  CGEventSetFlags: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.void,
  },
  CGEventSetIntegerValueField: {
    args: [FFIType.ptr, FFIType.u32, FFIType.i64],
    returns: FFIType.void,
  },
  CGEventKeyboardSetUnicodeString: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.void,
  },
  CGEventSourceCreate: {
    args: [FFIType.i32],
    returns: FFIType.ptr,
  },
  CFRelease: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
})

const kCGHIDEventTap = 0
const kCGSessionEventTap = 1
const kCGAnnotatedSessionEventTap = 2

const kCGEventSourceStateHIDSystemState = 1
const kCGEventSourceStateCombinedSessionState = 0

const kCGEventLeftMouseDown = 1
const kCGEventLeftMouseUp = 2
const kCGEventRightMouseDown = 3
const kCGEventRightMouseUp = 4
const kCGEventMouseMoved = 5
const kCGEventLeftMouseDragged = 6
const kCGEventRightMouseDragged = 7
const kCGEventKeyDown = 10
const kCGEventKeyUp = 11
const kCGEventScrollWheel = 22

const kCGMouseButtonLeft = 0
const kCGMouseButtonRight = 1
const kCGMouseButtonCenter = 2

const kCGEventFlagMaskShift = 0x00020000
const kCGEventFlagMaskControl = 0x00040000
const kCGEventFlagMaskAlternate = 0x00080000
const kCGEventFlagMaskCommand = 0x00100000

const kCGMouseEventClickState = 1

let eventSource: number | null = null

function getSource(): number | null {
  if (!eventSource) {
    eventSource = Number(sym.CGEventSourceCreate(kCGEventSourceStateCombinedSessionState))
    if (!eventSource) return null
  }
  return eventSource
}

const sym = cg.symbols as Record<string, (...args: any[]) => any>

function createMouseEvent(type: number, x: number, y: number, button: number = kCGMouseButtonLeft): number | null {
  const src = getSource()
  const event = Number(sym.CGEventCreateMouseEvent(src, type, x, y, button))
  return event || null
}

function createKeyboardEvent(keyCode: number, keyDown: boolean): number | null {
  const src = getSource()
  const event = Number(sym.CGEventCreateKeyboardEvent(src, keyCode, keyDown))
  return event || null
}

function postEvent(event: number, tap: number = kCGHIDEventTap) {
  sym.CGEventPost(tap, event)
}

function releaseEvent(event: number) {
  sym.CFRelease(event)
}

function setEventFlags(event: number, flags: number) {
  sym.CGEventSetFlags(event, flags)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export async function osClick(
  screenX: number,
  screenY: number,
  button: "left" | "right" = "left",
  clickCount: number = 1
): Promise<{ success: boolean; error?: string }> {
  try {
    const isRight = button === "right"
    const cgButton = isRight ? kCGMouseButtonRight : kCGMouseButtonLeft
    const downType = isRight ? kCGEventRightMouseDown : kCGEventLeftMouseDown
    const upType = isRight ? kCGEventRightMouseUp : kCGEventLeftMouseUp

    const moveEvent = createMouseEvent(kCGEventMouseMoved, screenX, screenY)
    if (!moveEvent) return { success: false, error: "failed to create mouse move event" }
    postEvent(moveEvent)
    releaseEvent(moveEvent)

    await sleep(10)

    for (let click = 0; click < clickCount; click++) {
      const downEvent = createMouseEvent(downType, screenX, screenY, cgButton)
      if (!downEvent) return { success: false, error: "failed to create mousedown event" }
      sym.CGEventSetIntegerValueField(downEvent, kCGMouseEventClickState, click + 1)
      postEvent(downEvent)
      releaseEvent(downEvent)

      await sleep(5)

      const upEvent = createMouseEvent(upType, screenX, screenY, cgButton)
      if (!upEvent) return { success: false, error: "failed to create mouseup event" }
      sym.CGEventSetIntegerValueField(upEvent, kCGMouseEventClickState, click + 1)
      postEvent(upEvent)
      releaseEvent(upEvent)

      if (click < clickCount - 1) await sleep(50)
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

const KEY_MAP: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19,
  "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
  "-": 27, "8": 28, "0": 29, "]": 30, o: 31, u: 32, "[": 33, i: 34,
  p: 35, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43,
  "/": 44, n: 45, m: 46, ".": 47, "`": 50, " ": 49,
  Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117,
  Home: 115, End: 119, PageUp: 116, PageDown: 121,
  ArrowUp: 126, ArrowDown: 125, ArrowLeft: 123, ArrowRight: 124,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
}

function modifiersToFlags(modifiers: string[]): number {
  let flags = 0
  for (const mod of modifiers) {
    const m = mod.toLowerCase()
    if (m === "shift") flags |= kCGEventFlagMaskShift
    else if (m === "control" || m === "ctrl") flags |= kCGEventFlagMaskControl
    else if (m === "alt" || m === "option") flags |= kCGEventFlagMaskAlternate
    else if (m === "meta" || m === "command" || m === "cmd") flags |= kCGEventFlagMaskCommand
  }
  return flags
}

export async function osKey(
  key: string,
  modifiers: string[] = []
): Promise<{ success: boolean; error?: string }> {
  try {
    const keyCode = KEY_MAP[key] ?? KEY_MAP[key.toLowerCase()]
    if (keyCode === undefined) {
      return { success: false, error: `unknown key: ${key}` }
    }

    const flags = modifiersToFlags(modifiers)

    if (flags) {
      for (const mod of modifiers) {
        const modKey = mod.toLowerCase()
        let modCode: number | undefined
        if (modKey === "shift") modCode = 56
        else if (modKey === "control" || modKey === "ctrl") modCode = 59
        else if (modKey === "alt" || modKey === "option") modCode = 58
        else if (modKey === "meta" || modKey === "command" || modKey === "cmd") modCode = 55
        if (modCode !== undefined) {
          const modDown = createKeyboardEvent(modCode, true)
          if (modDown) {
            setEventFlags(modDown, flags)
            postEvent(modDown)
            releaseEvent(modDown)
          }
        }
      }
      await sleep(5)
    }

    const downEvent = createKeyboardEvent(keyCode, true)
    if (!downEvent) return { success: false, error: "failed to create keydown event" }
    if (flags) setEventFlags(downEvent, flags)
    postEvent(downEvent)
    releaseEvent(downEvent)

    await sleep(5)

    const upEvent = createKeyboardEvent(keyCode, false)
    if (!upEvent) return { success: false, error: "failed to create keyup event" }
    if (flags) setEventFlags(upEvent, flags)
    postEvent(upEvent)
    releaseEvent(upEvent)

    if (flags) {
      await sleep(5)
      for (const mod of [...modifiers].reverse()) {
        const modKey = mod.toLowerCase()
        let modCode: number | undefined
        if (modKey === "shift") modCode = 56
        else if (modKey === "control" || modKey === "ctrl") modCode = 59
        else if (modKey === "alt" || modKey === "option") modCode = 58
        else if (modKey === "meta" || modKey === "command" || modKey === "cmd") modCode = 55
        if (modCode !== undefined) {
          const modUp = createKeyboardEvent(modCode, false)
          if (modUp) {
            postEvent(modUp)
            releaseEvent(modUp)
          }
        }
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function osType(text: string): Promise<{ success: boolean; error?: string }> {
  try {
    for (const char of text) {
      const keyCode = KEY_MAP[char] ?? KEY_MAP[char.toLowerCase()]

      if (keyCode !== undefined) {
        const needsShift = char !== char.toLowerCase() && char === char.toUpperCase() && /[a-zA-Z]/.test(char)
        const flags = needsShift ? kCGEventFlagMaskShift : 0

        if (needsShift) {
          const shiftDown = createKeyboardEvent(56, true)
          if (shiftDown) { setEventFlags(shiftDown, flags); postEvent(shiftDown); releaseEvent(shiftDown) }
        }

        const down = createKeyboardEvent(keyCode, true)
        if (!down) continue
        if (flags) setEventFlags(down, flags)
        postEvent(down)
        releaseEvent(down)

        await sleep(3)

        const up = createKeyboardEvent(keyCode, false)
        if (up) { if (flags) setEventFlags(up, flags); postEvent(up); releaseEvent(up) }

        if (needsShift) {
          const shiftUp = createKeyboardEvent(56, false)
          if (shiftUp) { postEvent(shiftUp); releaseEvent(shiftUp) }
        }
      } else {
        const down = createKeyboardEvent(0, true)
        if (!down) continue
        const encoded = new Uint16Array([char.charCodeAt(0)])
        sym.CGEventKeyboardSetUnicodeString(down, 1, encoded)
        postEvent(down)
        releaseEvent(down)

        await sleep(3)

        const up = createKeyboardEvent(0, false)
        if (up) {
          sym.CGEventKeyboardSetUnicodeString(up, 1, encoded)
          postEvent(up)
          releaseEvent(up)
        }
      }

      await sleep(8)
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function osMove(
  points: Array<{ x: number; y: number }>,
  durationMs: number = 100
): Promise<{ success: boolean; error?: string }> {
  try {
    if (points.length === 0) return { success: false, error: "empty path" }

    const stepDelay = points.length > 1 ? durationMs / (points.length - 1) : 0

    for (const point of points) {
      const moveEvent = createMouseEvent(kCGEventMouseMoved, point.x, point.y)
      if (!moveEvent) continue
      postEvent(moveEvent)
      releaseEvent(moveEvent)
      if (stepDelay > 0) await sleep(stepDelay)
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

function bezierInterpolate(
  start: { x: number; y: number },
  end: { x: number; y: number },
  steps: number
): Array<{ x: number; y: number }> {
  const cpX = (start.x + end.x) / 2 + (Math.random() - 0.5) * Math.abs(end.x - start.x) * 0.3
  const cpY = (start.y + end.y) / 2 + (Math.random() - 0.5) * Math.abs(end.y - start.y) * 0.3
  const points: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const x = u * u * start.x + 2 * u * t * cpX + t * t * end.x
    const y = u * u * start.y + 2 * u * t * cpY + t * t * end.y
    points.push({ x: Math.round(x), y: Math.round(y) })
  }
  return points
}

export function generateBezierPath(
  fromX: number, fromY: number,
  toX: number, toY: number,
  steps: number = 20
): Array<{ x: number; y: number }> {
  return bezierInterpolate({ x: fromX, y: fromY }, { x: toX, y: toY }, steps)
}

export function translateCoords(
  pageX: number,
  pageY: number,
  windowBounds: { left: number; top: number; width: number; height: number },
  chromeUiHeight: number = 88
): { screenX: number; screenY: number } {
  return {
    screenX: windowBounds.left + pageX,
    screenY: windowBounds.top + chromeUiHeight + pageY
  }
}
