const IS_WIN = process.platform === "win32"
const IS_MAC = process.platform === "darwin"

const stub = {
  osClick: async () => ({ success: false, error: "OS input not supported on this platform" }),
  osKey: async () => ({ success: false, error: "OS input not supported on this platform" }),
  osType: async () => ({ success: false, error: "OS input not supported on this platform" }),
  osMove: async () => ({ success: false, error: "OS input not supported on this platform" }),
  generateBezierPath: () => [],
  translateCoords: (x: number, y: number) => ({ x, y }),
}

const mod = IS_WIN
  ? await import("./os-input-win")
  : IS_MAC
    ? await import("./os-input")
    : stub

export const { osClick, osKey, osType, osMove, generateBezierPath, translateCoords } = mod
