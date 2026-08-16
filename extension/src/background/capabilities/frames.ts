import { sendToContentScript } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

type FrameTreeEntry = {
  frameId: number
  parentFrameId: number
  url: string
  opaque?: true
  error?: string
  tree?: string
  text?: string
}

type FindTextMatch = {
  start: number
  end: number
  matchedText: string
  snippet: string
  frameId?: number
}

type FindElementMatch = {
  refId: string
  role: string
  name: string
  score: number
  frameId?: number
}

type FindSection<T> = {
  total: number
  returned: number
  truncated: boolean
  matches: T[]
  scannedCharacters?: number
  scanTruncated?: boolean
}

export async function handleFrameActions(
  action: { type: string; [key: string]: unknown },
  tabId: number,
  sendFrame: typeof sendToContentScript = sendToContentScript
): Promise<ActionResult> {
  if (action.type === "frames_list") {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    return {
      success: true,
      data: frames?.map(f => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId }))
    }
  }

  if (action.type === "frames_read_tree") {
    const depth = (action.depth as number) || 15
    const filter = (action.filter as string) || "interactive"
    const maxChars = (action.maxChars as number) || 50000
    const includeStyle = action.includeStyle === true
    const treeFormat: "verbose" | "compact" = action.treeFormat === "compact" ? "compact" : "verbose"
    const includeText = action.includeText === true
    const targetFrameId = typeof action.frameId === "number" ? action.frameId : undefined
    const targetIndex = typeof action.index === "number" ? action.index : undefined
    const targetRef = typeof action.ref === "string" ? action.ref : undefined

    let frames: chrome.webNavigation.GetAllFrameResultDetails[] | undefined
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId }) || undefined
    } catch (err) {
      return { success: false, error: `getAllFrames failed: ${(err as Error).message}` }
    }
    if (!frames || !frames.length) {
      return { success: true, data: { frames: [] }, tabId }
    }
    const frameList = targetFrameId === undefined
      ? frames
      : frames.filter((frame) => frame.frameId === targetFrameId)

    const results: FrameTreeEntry[] = await Promise.all(frameList.map(async (f) => {
      const entry: FrameTreeEntry = {
        frameId: f.frameId,
        parentFrameId: f.parentFrameId,
        url: f.url
      }
      try {
        const treeAction: { type: string; [key: string]: unknown } = {
          type: "get_a11y_tree",
          depth,
          filter,
          maxChars,
          includeStyle,
          frameId: f.frameId
        }
        if (targetIndex !== undefined) treeAction.index = targetIndex
        if (targetRef) treeAction.ref = targetRef
        const treeResp = await sendFrame(
          tabId,
          treeAction,
          f.frameId
        ) as { success: boolean; error?: string; data?: unknown }
        if (!treeResp.success) {
          entry.opaque = true
          entry.error = treeResp.error || "unreachable frame"
        } else {
          const raw = typeof treeResp.data === "string" ? treeResp.data : ""
          entry.tree = f.frameId === 0
            ? raw
            : raw.replace(/\[e(\d+)\]/g, `[e${f.frameId}_$1]`)
        }
        if (includeText) {
          const textAction: { type: string; [key: string]: unknown } = { type: "extract_text", frameId: f.frameId }
          if (targetIndex !== undefined) textAction.index = targetIndex
          if (targetRef) textAction.ref = targetRef
          const textResp = await sendFrame(
            tabId,
            textAction,
            f.frameId
          ) as { success: boolean; data?: unknown }
          if (textResp.success && typeof textResp.data === "string") {
            entry.text = textResp.data
          }
        }
      } catch (err) {
        entry.opaque = true
        entry.error = (err as Error).message || "injection failed"
      }
      return entry
    }))

    return { success: true, data: { frames: results }, tabId }
  }

  if (action.type === "frames_find") {
    const query = String(action.query || "").trim()
    if (!query) return { success: false, error: "find requires a non-empty query" }
    const limit = typeof action.limit === "number" ? Math.max(0, Math.floor(action.limit)) : 10
    const role = typeof action.role === "string" ? action.role : ""
    const mode = role
      ? "elements"
      : action.mode === "text" || action.mode === "elements"
        ? action.mode
        : "hybrid"

    let frames: chrome.webNavigation.GetAllFrameResultDetails[] | undefined
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId }) || undefined
    } catch (err) {
      return { success: false, error: `getAllFrames failed: ${(err as Error).message}` }
    }
    if (!frames?.length) {
      return { success: true, data: { query, mode, frames: [] }, tabId }
    }

    const perFrameResults = await Promise.all(frames.map(async (frame) => {
      const frameMeta: { frameId: number; parentFrameId: number; url: string; opaque?: true; error?: string } = {
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url
      }
      const result = {
        frameMeta,
        textMatches: [] as FindTextMatch[],
        elementMatches: [] as FindElementMatch[],
        textTotal: 0,
        elementTotal: 0,
        scannedCharacters: 0,
        scanTruncated: false
      }
      try {
        const response = await sendFrame(tabId, {
          type: "find_element",
          query,
          role,
          mode,
          // Per-frame output is bounded. Every frame still reports its full
          // totals, and the aggregate applies the global category limit below.
          limit,
          frameId: frame.frameId
        }, frame.frameId) as { success: boolean; error?: string; data?: unknown }
        if (!response.success || !response.data || typeof response.data !== "object") {
          frameMeta.opaque = true
          frameMeta.error = response.error || "unreachable frame"
          return result
        }
        const data = response.data as { text?: FindSection<FindTextMatch>; elements?: FindSection<FindElementMatch> }
        if (data.text) {
          result.textTotal = data.text.total
          result.scannedCharacters = data.text.scannedCharacters || 0
          result.scanTruncated = data.text.scanTruncated === true
          result.textMatches = data.text.matches.map(match => ({ ...match, frameId: frame.frameId }))
        }
        if (data.elements) {
          result.elementTotal = data.elements.total
          for (const match of data.elements.matches) {
            const refId = frame.frameId === 0
              ? match.refId
              : match.refId.replace(/^e(\d+)$/, `e${frame.frameId}_$1`)
            result.elementMatches.push({ ...match, refId, frameId: frame.frameId })
          }
        }
      } catch (err) {
        frameMeta.opaque = true
        frameMeta.error = (err as Error).message || "injection failed"
      }
      return result
    }))

    const frameResults = perFrameResults.map(result => result.frameMeta)
    const textMatches: FindTextMatch[] = []
    const elementMatches: FindElementMatch[] = []
    let textTotal = 0
    let elementTotal = 0
    let scannedCharacters = 0
    let scanTruncated = false
    for (const result of perFrameResults) {
      textTotal += result.textTotal
      elementTotal += result.elementTotal
      scannedCharacters += result.scannedCharacters
      scanTruncated ||= result.scanTruncated
      textMatches.push(...result.textMatches)
      elementMatches.push(...result.elementMatches)
    }

    const data: Record<string, unknown> = { query, mode, frames: frameResults }
    if (mode !== "elements") {
      const matches = textMatches.slice(0, limit)
      data.text = {
        total: textTotal,
        returned: matches.length,
        truncated: textTotal > matches.length,
        scannedCharacters,
        scanTruncated,
        matches
      }
    }
    if (mode !== "text") {
      const matches = elementMatches.slice(0, limit)
      data.elements = {
        total: elementTotal,
        returned: matches.length,
        truncated: elementTotal > matches.length,
        matches
      }
    }
    return { success: true, data, tabId }
  }

  return { success: false, error: `unknown frame action: ${action.type}` }
}
