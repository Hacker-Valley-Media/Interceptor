/**
 * cli/commands/screenshot.ts — screenshot, canvas, capture
 */

type Action = { type: string; [key: string]: unknown }

export function parseScreenshotCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "screenshot": {
      if (filtered.includes("--background")) {
        const bgAction: Action = { type: "screenshot_background" }
        if (filtered.includes("--format")) bgAction.format = filtered[filtered.indexOf("--format") + 1]
        if (filtered.includes("--quality")) bgAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
        return bgAction
      }
      const ssAction: Action = { type: "screenshot" }
      if (filtered.includes("--save")) ssAction.save = true
      if (filtered.includes("--format")) ssAction.format = filtered[filtered.indexOf("--format") + 1]
      if (filtered.includes("--quality")) ssAction.quality = parseInt(filtered[filtered.indexOf("--quality") + 1])
      if (filtered.includes("--full")) ssAction.full = true
      if (filtered.includes("--clip")) {
        const clipParts = filtered[filtered.indexOf("--clip") + 1].split(",").map(Number)
        ssAction.clip = { x: clipParts[0], y: clipParts[1], width: clipParts[2], height: clipParts[3] }
      }
      if (filtered.includes("--element")) ssAction.element = parseInt(filtered[filtered.indexOf("--element") + 1])
      return ssAction
    }

    case "canvas":
      switch (filtered[1]) {
        case "list":
          return { type: "canvas_list" }
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
          console.error("error: unknown canvas subcommand. Use: list, read, diff")
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
