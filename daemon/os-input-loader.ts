const IS_WIN = process.platform === "win32"

const mod = IS_WIN
  ? await import("./os-input-win")
  : await import("./os-input")

export const { osClick, osKey, osType, osMove, generateBezierPath, translateCoords } = mod
