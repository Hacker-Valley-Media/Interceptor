// Windows stub for os-input — OS-level input not yet implemented on Windows

export async function osClick(
  screenX: number,
  screenY: number,
  button: "left" | "right" = "left",
  clickCount: number = 1
): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: "os_click not supported on Windows" }
}

export async function osKey(
  key: string,
  modifiers: string[] = []
): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: "os_key not supported on Windows" }
}

export async function osType(text: string): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: "os_type not supported on Windows" }
}

export async function osMove(
  points: Array<{ x: number; y: number }>,
  durationMs: number = 100
): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: "os_move not supported on Windows" }
}

export function generateBezierPath(
  fromX: number, fromY: number,
  toX: number, toY: number,
  steps: number = 20
): Array<{ x: number; y: number }> {
  return [{ x: fromX, y: fromY }, { x: toX, y: toY }]
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
