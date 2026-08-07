#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

export const WINDOWS_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const

export type IcoFrame = { width: number; height: number; bitCount: number; bytes: number; offset: number }

export function readIcoFrames(buffer: Buffer): IcoFrame[] {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("invalid ICO header")
  }
  const count = buffer.readUInt16LE(4)
  if (count === 0 || buffer.length < 6 + count * 16) throw new Error("invalid ICO directory")
  const frames: IcoFrame[] = []
  for (let index = 0; index < count; index++) {
    const base = 6 + index * 16
    const width = buffer[base] || 256
    const height = buffer[base + 1] || 256
    const bitCount = buffer.readUInt16LE(base + 6)
    const bytes = buffer.readUInt32LE(base + 8)
    const offset = buffer.readUInt32LE(base + 12)
    if (width !== height || bytes === 0 || offset < 6 + count * 16 || offset + bytes > buffer.length) {
      throw new Error(`invalid ICO frame ${index}`)
    }
    frames.push({ width, height, bitCount, bytes, offset })
  }
  return frames
}

export function validateWindowsIcon(buffer: Buffer): void {
  const frames = readIcoFrames(buffer)
  const sizes = frames.map(frame => frame.width)
  if (sizes.join(",") !== WINDOWS_ICON_SIZES.join(",")) {
    throw new Error(`ICO sizes must be exactly ${WINDOWS_ICON_SIZES.join(",")}; got ${sizes.join(",")}`)
  }
  for (const frame of frames) {
    if (frame.bitCount !== 32) throw new Error(`ICO ${frame.width}px frame must declare 32 bits`)
    const signature = buffer.subarray(frame.offset, frame.offset + 8).toString("hex")
    if (signature !== "89504e470d0a1a0a") throw new Error(`ICO ${frame.width}px frame must be PNG-compressed`)
    const colorType = buffer[frame.offset + 25]
    if (colorType !== 6) throw new Error(`ICO ${frame.width}px PNG must be RGBA (color type 6)`)
  }
}

function makeIco(images: Array<{ size: number; png: Buffer }>): Buffer {
  const headerBytes = 6 + images.length * 16
  const totalBytes = headerBytes + images.reduce((sum, image) => sum + image.png.length, 0)
  const output = Buffer.alloc(totalBytes)
  output.writeUInt16LE(0, 0)
  output.writeUInt16LE(1, 2)
  output.writeUInt16LE(images.length, 4)

  let offset = headerBytes
  images.forEach((image, index) => {
    const base = 6 + index * 16
    output[base] = image.size === 256 ? 0 : image.size
    output[base + 1] = image.size === 256 ? 0 : image.size
    output[base + 2] = 0
    output[base + 3] = 0
    output.writeUInt16LE(1, base + 4)
    output.writeUInt16LE(32, base + 6)
    output.writeUInt32LE(image.png.length, base + 8)
    output.writeUInt32LE(offset, base + 12)
    image.png.copy(output, offset)
    offset += image.png.length
  })
  return output
}

export function generateWindowsIcon(source: string, destination: string): void {
  const scratch = mkdtempSync(resolve(tmpdir(), "interceptor-windows-icon-"))
  try {
    const images = WINDOWS_ICON_SIZES.map(size => {
      const pngPath = resolve(scratch, `${size}.png`)
      const result = Bun.spawnSync([
        "ffmpeg", "-v", "error", "-y", "-i", source,
        "-vf", `scale=${size}:${size}:flags=lanczos,format=rgba`,
        "-frames:v", "1", pngPath,
      ], { stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) {
        throw new Error(`ffmpeg failed for ${size}px: ${result.stderr.toString().trim()}`)
      }
      return { size, png: readFileSync(pngPath) }
    })
    const ico = makeIco(images)
    validateWindowsIcon(ico)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, ico, { mode: 0o644 })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const source = resolve(process.argv[2] || "Interceptor Logo Square.png")
  const destination = resolve(process.argv[3] || "assets/windows/interceptor.ico")
  try {
    generateWindowsIcon(source, destination)
    console.log(destination)
  } catch (error) {
    console.error(`error: ${(error as Error).message}`)
    process.exit(1)
  }
}
