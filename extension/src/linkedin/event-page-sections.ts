import { isLinkedInNoiseText, isVisibleElement, visibleText } from "./event-page-visible-text"

export function findLinkedInEventRoot(title: string): Element | null {
  const heading = Array.from(document.querySelectorAll("h1")).find(el => visibleText(el) === title)
  if (!heading) return document.querySelector("main")
  let current: Element | null = heading
  let best: { element: Element; score: number } | null = null
  while (current && current !== document.body) {
    const text = visibleText(current)
    if (text) {
      let score = 0
      if (text.includes(title)) score += 40
      if (/Event by/i.test(text)) score += 20
      if (/attendees?/i.test(text)) score += 15
      if (/Add to calendar/i.test(text)) score += 10
      if (/Close your conversation|Reply to conversation|Page inboxes/i.test(text)) score -= 80
      if (!best || score > best.score) best = { element: current, score }
    }
    current = current.parentElement
  }
  return best?.element || document.querySelector("main")
}

export function extractEventByName(lines: string[]): string | null {
  for (const line of lines) {
    const inline = line.match(/Event by\s+(.+?)(?:\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),|\s+Add to calendar|\s+Attendee profile images|$)/i)
    if (inline?.[1]) return inline[1].trim()
  }
  const eventByIndex = lines.findIndex(line => /^event by$/i.test(line) || /^event by\s+/i.test(line))
  if (eventByIndex !== -1) {
    const sameLine = lines[eventByIndex].replace(/^event by\s*/i, "").trim()
    if (sameLine && !/^event by$/i.test(sameLine)) return sameLine
    if (lines[eventByIndex + 1]) return lines[eventByIndex + 1]
  }
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^event by$/i.test(lines[i]) && lines[i + 1]) return lines[i + 1]
  }
  const labeled = lines.find(line => /^hosted by\s+/i.test(line) || /^by\s+[A-Z]/.test(line))
  if (labeled) return labeled.replace(/^(hosted by|by)\s+/i, "").trim()
  return null
}

export function extractDisplayedDate(lines: string[]): string | null {
  const line = lines.find(item => /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/.test(item))
  if (line) {
    const exact = line.match(/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}\s*[AP]M\s*-\s*\d{1,2}:\d{2}\s*[AP]M(?:\s*\([^)]*\))?)/i)
    if (exact?.[1]) return exact[1].trim()
    return line
  }
  const timeEl = document.querySelector("time")
  const timeText = visibleText(timeEl)
  if (timeText) return timeText
  return null
}

export function extractAttendeeSummary(lines: string[]): { text: string | null; totalCount: number | null; names: string[] } {
  let summary = lines.find(line => /attendees?/i.test(line) && (/other attendees?/i.test(line) || /^[A-Z].*attendees?/i.test(line))) || null
  if (summary) {
    const exact = summary.match(/([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,3}\s+and\s+\d[\d,]*\s+other attendees?)/)
    if (exact?.[1]) summary = exact[1]
  }
  if (!summary) return { text: null, totalCount: null, names: [] }
  const otherMatch = summary.match(/and\s+(\d[\d,]*)\s+other attendees?/i)
  const prefix = summary.split(/\sand\s+\d[\d,]*\s+other attendees?/i)[0] || ""
  const names = prefix.split(/,| and /).map(part => part.trim()).filter(part => /^[A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){0,3}$/.test(part))
  const otherCount = otherMatch ? parseInt(otherMatch[1].replace(/,/g, ""), 10) : 0
  const totalCount = otherMatch ? otherCount + names.length : null
  return { text: summary, totalCount, names }
}

function isMeaningfulImage(img: HTMLImageElement): boolean {
  const src = img.currentSrc || img.src || ""
  if (!src) return false
  if (/^data:image\/gif;base64,R0lGODlhAQABA/i.test(src)) return false
  if (/transparent|spacer|pixel/i.test(src)) return false
  const rect = img.getBoundingClientRect()
  return rect.width >= 40 && rect.height >= 40
}

export function extractMeaningfulThumbnail(root: Element | null): string | null {
  const direct = document.querySelector("#ember33")
  if (direct instanceof HTMLImageElement && isMeaningfulImage(direct)) return direct.currentSrc || direct.src || null
  const scope = root || document.body
  const images = Array.from(scope.querySelectorAll("img"))
    .filter(img => isVisibleElement(img) && isMeaningfulImage(img as HTMLImageElement)) as HTMLImageElement[]
  images.sort((a, b) => {
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return rb.width * rb.height - ra.width * ra.height
  })
  return images[0] ? images[0].currentSrc || images[0].src || null : null
}

export function extractDetailsText(root: Element | null, eventTitle: string): string | null {
  const text = visibleText(root || document.body)
  const lines = text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
  const start = lines.findIndex(line => line === eventTitle)
  const end = lines.findIndex(line => /^Other events for you$/i.test(line))
  const slice = lines.slice(start >= 0 ? start + 1 : 0, end >= 0 ? end : lines.length)
    .filter(line => !/^Add to calendar$/i.test(line))
    .filter(line => !/^Attendee profile images$/i.test(line))
    .filter(line => !/^Boost$/i.test(line))
    .filter(line => !/^(Details|Comments|Networking|Analytics)$/i.test(line))
    .filter(line => !isLinkedInNoiseText(line))
  const joined = slice.join(" ").replace(/\s+/g, " ").trim()
  return joined || null
}
