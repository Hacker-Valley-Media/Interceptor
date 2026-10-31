/**
 * cli/commands/screenshot.ts — screenshot, canvas, capture
 */
import { existsSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import { normalizeArgsSplit } from "../normalize"
import { normalizeRefArg } from "../parse"

type Action = { type: string; [key: string]: unknown }

const OUT_FORMATS: Record<string, string> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" }

/**
 * `screenshot --out <path>` writes there. The path stays
 * in the CLI (cli/index.ts strips `out` before sending); the format follows
 * the file extension, and a missing folder is an error before any capture.
 */
export function screenshotOut(filtered: string[], format: string | undefined): { out: string; format: string } | undefined {
  const idx = filtered.indexOf("--out")
  if (idx === -1) return undefined
  const raw = filtered[idx + 1]
  if (!raw || raw.startsWith("--")) throw new Error("screenshot --out requires a file path, e.g. --out ./page.png")
  const out = resolve(raw)
  const inferred = OUT_FORMATS[extname(out).toLowerCase()]
  if (!inferred) throw new Error(`screenshot --out must end in .png, .jpg, .jpeg or .webp (got '${raw}')`)
  if (format && format !== inferred && !(format === "jpg" && inferred === "jpeg")) {
    throw new Error(`screenshot --out '${raw}' is a ${inferred} file but --format is '${format}'; drop --format or change the extension`)
  }
  if (!existsSync(dirname(out))) throw new Error(`screenshot --out: folder '${dirname(out)}' does not exist`)
  return { out, format: inferred }
}

export function parseScreenshotCommand(filtered: string[], positionalCount?: number): Action {
  const normalized = positionalCount === undefined ? normalizeArgsSplit(filtered) : { argv: filtered, positionalCount }
  filtered = normalized.argv
  const cmd = filtered[0]

  switch (cmd) {
    case "screenshot": {
      if (normalized.positionalCount > 0) {
        throw new Error("screenshot does not accept positional arguments; pass the file with --out <path>, or use --save for an automatically named image in the current directory.")
      }
      const formatFlag = filtered.includes("--format") ? filtered[filtered.indexOf("--format") + 1] : undefined
      const outTarget = screenshotOut(filtered, formatFlag)
      if (filtered.includes("--background")) {
        const bgAction: Action = { type: "screenshot_background" }
        if (formatFlag) bgAction.format = formatFlag
        if (filtered.includes("--quality")) bgAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
        if (filtered.includes("--save")) bgAction.save = true
        if (outTarget) Object.assign(bgAction, { save: true, out: outTarget.out, format: outTarget.format })
        return bgAction
      }
      const ssAction: Action = { type: "screenshot" }
      if (filtered.includes("--save")) ssAction.save = true
      if (formatFlag) ssAction.format = formatFlag
      if (outTarget) Object.assign(ssAction, { save: true, out: outTarget.out, format: outTarget.format })
      if (filtered.includes("--quality")) ssAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
      if (filtered.includes("--full")) ssAction.full = true
      if (filtered.includes("--pixel")) ssAction.pixel = true
      // Forbid the DOM-render → pixel auto-fallback. The pixel path borrows tab
      // focus and scrolls the page (both restored) — callers mid-interaction can
      // refuse those side effects and take the DOM-render error instead.
      if (filtered.includes("--no-fallback")) ssAction.no_fallback = true
      if (filtered.includes("--scale")) ssAction.scale = parseFloat(filtered[filtered.indexOf("--scale") + 1])
      if (filtered.includes("--selector")) {
        ssAction.selector = filtered[filtered.indexOf("--selector") + 1]
      }
      if (filtered.includes("--region")) {
        const rp = filtered[filtered.indexOf("--region") + 1].split(",").map(Number)
        ssAction.region = { x: rp[0], y: rp[1], width: rp[2], height: rp[3] }
      }
      if (filtered.includes("--clip")) {
        // --clip is a deprecated alias for --region (preserved for backward compat)
        const clipParts = filtered[filtered.indexOf("--clip") + 1].split(",").map(Number)
        ssAction.clip = { x: clipParts[0], y: clipParts[1], width: clipParts[2], height: clipParts[3] }
      }
      if (filtered.includes("--element")) ssAction.element = parseInt(filtered[filtered.indexOf("--element") + 1])
      if (filtered.includes("--ref")) ssAction.ref = normalizeRefArg(filtered[filtered.indexOf("--ref") + 1])
      if (filtered.includes("--target-max-long-edge")) {
        const raw = filtered[filtered.indexOf("--target-max-long-edge") + 1]
        const parsed = parseInt(raw)
        if (Number.isFinite(parsed) && parsed > 0) ssAction.target_max_long_edge = parsed
      }
      return ssAction
    }

    case "ocr": {
      // interceptor ocr "<css-selector>" | <ref> | --element N | --region X,Y,W,H
      // Renders the target via the native screenshot path, then OCRs it with the
      // bundled Tesseract engine (offline, cross-platform, no Mac, no agent).
      const a: Action = { type: "ocr" }
      const pos = filtered[1]
      if (pos && !pos.startsWith("--")) {
        const ref = normalizeRefArg(pos)
        if (/^e\d/.test(ref)) a.ref = ref
        else a.selector = pos
      }
      if (filtered.includes("--selector")) a.selector = filtered[filtered.indexOf("--selector") + 1]
      if (filtered.includes("--ref")) a.ref = normalizeRefArg(filtered[filtered.indexOf("--ref") + 1])
      if (filtered.includes("--element")) a.element = parseInt(filtered[filtered.indexOf("--element") + 1])
      if (filtered.includes("--region")) {
        const rp = filtered[filtered.indexOf("--region") + 1].split(",").map(Number)
        a.region = { x: rp[0], y: rp[1], width: rp[2], height: rp[3] }
      }
      if (filtered.includes("--scale")) a.scale = parseFloat(filtered[filtered.indexOf("--scale") + 1])
      if (filtered.includes("--target-max-long-edge")) {
        const parsed = parseInt(filtered[filtered.indexOf("--target-max-long-edge") + 1])
        if (Number.isFinite(parsed) && parsed > 0) a.target_max_long_edge = parsed
      }
      return a
    }

    case "canvas":
      switch (filtered[1]) {
        case "list":
          return { type: "canvas_list" }
        case "status": {
          const a: Action = { type: "canvas_status" }
          if (filtered.includes("--limit")) a.limit = parseInt(filtered[filtered.indexOf("--limit") + 1])
          return a
        }
        case "log": {
          const a: Action = { type: "canvas_log" }
          const maybeIndex = filtered[2]
          if (maybeIndex && !maybeIndex.startsWith("--")) a.canvasIndex = parseInt(maybeIndex)
          if (filtered.includes("--kind")) {
            const raw = filtered[filtered.indexOf("--kind") + 1]
            a.kinds = raw.split(",").map((s) => s.trim()).filter(Boolean)
          }
          if (filtered.includes("--limit")) a.limit = parseInt(filtered[filtered.indexOf("--limit") + 1])
          return a
        }
        case "objects": {
          const a: Action = { type: "canvas_objects" }
          const maybeIndex = filtered[2]
          if (maybeIndex && !maybeIndex.startsWith("--")) a.canvasIndex = parseInt(maybeIndex)
          if (filtered.includes("--kind")) a.kind = filtered[filtered.indexOf("--kind") + 1]
          if (filtered.includes("--limit")) a.limit = parseInt(filtered[filtered.indexOf("--limit") + 1])
          return a
        }
        case "model": {
          const a: Action = { type: "canvas_model" }
          if (filtered.includes("--limit")) a.limit = parseInt(filtered[filtered.indexOf("--limit") + 1])
          return a
        }
        case "routes": {
          const a: Action = { type: "canvas_routes" }
          if (filtered.includes("--filter")) a.filter = filtered[filtered.indexOf("--filter") + 1]
          if (filtered.includes("--limit")) a.limit = parseInt(filtered[filtered.indexOf("--limit") + 1])
          return a
        }
        case "ocr": {
          const idx = parseInt(filtered[2] || "")
          if (Number.isNaN(idx)) {
            console.error("error: interceptor canvas ocr requires a canvas index")
            process.exit(1)
          }
          const a: Action = { type: "canvas_ocr", canvasIndex: idx }
          if (filtered.includes("--region")) {
            const rp = filtered[filtered.indexOf("--region") + 1].split(",").map(Number)
            a.region = { x: rp[0], y: rp[1], width: rp[2], height: rp[3] }
          }
          return a
        }
        case "read": {
          const crAction: Action = { type: "canvas_read", canvasIndex: parseInt(filtered[2]) }
          if (filtered.includes("--format")) crAction.format = filtered[filtered.indexOf("--format") + 1]
          if (filtered.includes("--quality")) crAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
          if (filtered.includes("--webgl")) crAction.webgl = true
          if (filtered.includes("--region")) {
            const rp = filtered[filtered.indexOf("--region") + 1].split(",").map(Number)
            crAction.region = { x: rp[0], y: rp[1], width: rp[2], height: rp[3] }
          }
          return crAction
        }
        case "diff": {
          const cdAction: Action = { type: "canvas_diff", image1: filtered[2], image2: filtered[3] }
          if (filtered.includes("--threshold")) cdAction.threshold = parseInt(filtered[filtered.indexOf("--threshold") + 1])
          if (filtered.includes("--image")) cdAction.returnImage = true
          return cdAction
        }
        default:
          console.error("error: unknown canvas subcommand. Use: list, status, log, objects, model, routes, ocr, read, diff")
          process.exit(1)
      }
      break

    case "capture":
      switch (filtered[1]) {
        case "start":
          return { type: "capture_start" }
        case "frame": {
          const cfAction: Action = { type: "capture_frame" }
          if (filtered.includes("--format")) cfAction.format = filtered[filtered.indexOf("--format") + 1]
          if (filtered.includes("--quality")) cfAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
          return cfAction
        }
        case "stop":
          return { type: "capture_stop" }
        default:
          console.error("error: unknown capture subcommand. Use: start, frame, stop")
          process.exit(1)
      }
      break

    default:
      console.error(`error: unknown screenshot command '${cmd}'`)
      process.exit(1)
  }
  throw new Error("unreachable")
}
