type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleCanvasActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "canvas_list": {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const canvases = Array.from(document.querySelectorAll("canvas"))
          function walkShadowRoots(root: Element | ShadowRoot): HTMLCanvasElement[] {
            const found: HTMLCanvasElement[] = []
            const children = Array.from(root.children)
            for (const child of children) {
              if (child.tagName === "CANVAS") found.push(child as HTMLCanvasElement)
              const shadow = (child as any).shadowRoot
              if (shadow) found.push(...walkShadowRoots(shadow))
              found.push(...walkShadowRoots(child))
            }
            return found
          }
          const shadowCanvases = walkShadowRoots(document.body)
          const all = [...new Set([...canvases, ...shadowCanvases])]
          return all.map((c, i) => {
            const rect = c.getBoundingClientRect()
            let contextType = "none"
            try {
              if (c.getContext("2d")) contextType = "2d"
              else if (c.getContext("webgl2")) contextType = "webgl2"
              else if (c.getContext("webgl")) contextType = "webgl"
              else if (c.getContext("bitmaprenderer")) contextType = "bitmaprenderer"
            } catch {}
            const style = getComputedStyle(c)
            const hidden = style.display === "none" || style.visibility === "hidden" || (c.width === 0 && c.height === 0)
            return {
              index: i, width: c.width, height: c.height,
              cssWidth: rect.width, cssHeight: rect.height, x: rect.x, y: rect.y,
              contextType, hidden, id: c.id || undefined, className: c.className || undefined
            }
          })
        }
      })
      return { success: true, data: results[0]?.result ?? [] }
    }

    case "canvas_read": {
      const canvasIdx = action.canvasIndex as number
      const fmt = (action.format as string) === "png" ? "image/png" : "image/jpeg"
      const qual = (action.quality as number) || 0.5
      const region = action.region as { x: number; y: number; width: number; height: number } | undefined
      const isWebgl = action.webgl as boolean | undefined

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [canvasIdx, fmt, qual, region ?? null, isWebgl ?? false],
        func: (idx: number, format: string, quality: number, reg: { x: number; y: number; width: number; height: number } | null, webgl: boolean) => {
          const canvases = Array.from(document.querySelectorAll("canvas"))
          const c = canvases[idx]
          if (!c) return { success: false, error: `no canvas at index ${idx}` }
          try {
            if (reg) {
              const ctx = c.getContext("2d")
              if (!ctx) return { success: false, error: "canvas has no 2d context for region read" }
              const data = ctx.getImageData(reg.x, reg.y, reg.width, reg.height)
              const tmpCanvas = document.createElement("canvas")
              tmpCanvas.width = reg.width; tmpCanvas.height = reg.height
              const tmpCtx = tmpCanvas.getContext("2d")!
              tmpCtx.putImageData(data, 0, 0)
              return { success: true, data: tmpCanvas.toDataURL(format, quality) }
            }
            if (webgl) {
              const gl = c.getContext("webgl2") || c.getContext("webgl")
              if (!gl) return { success: false, error: "canvas has no webgl context" }
              const pixels = new Uint8Array(c.width * c.height * 4)
              gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
              const tmpCanvas = document.createElement("canvas")
              tmpCanvas.width = c.width; tmpCanvas.height = c.height
              const tmpCtx = tmpCanvas.getContext("2d")!
              const imageData = tmpCtx.createImageData(c.width, c.height)
              for (let row = 0; row < c.height; row++) {
                const srcOff = row * c.width * 4
                const dstOff = (c.height - 1 - row) * c.width * 4
                imageData.data.set(pixels.subarray(srcOff, srcOff + c.width * 4), dstOff)
              }
              tmpCtx.putImageData(imageData, 0, 0)
              return { success: true, data: tmpCanvas.toDataURL(format, quality) }
            }
            return { success: true, data: c.toDataURL(format, quality) }
          } catch (e: any) {
            if (e.message?.includes("tainted")) return { success: false, error: "canvas is tainted (cross-origin content)" }
            return { success: false, error: e.message }
          }
        }
      })
      const res = results[0]?.result as { success: boolean; error?: string; data?: string } | undefined
      if (!res) return { success: false, error: "no result from canvas read" }
      if (!res.success) return { success: false, error: res.error }
      const dataUrl = res.data!
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)
      if (sizeBytes > 800 * 1024) {
        return { success: true, data: { dataUrl, size: sizeBytes, warning: "Response exceeds 800KB — consider JPEG or smaller region" } }
      }
      return { success: true, data: { dataUrl, size: sizeBytes } }
    }
  }
  return { success: false, error: `unknown canvas action: ${action.type}` }
}
