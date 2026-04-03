import { isLinkedInNoiseText, isVisibleElement, visibleText } from "./event-page-visible-text"

export function extractEngagementCounts(text: string): { likes: number | null; reposts: number | null; comments: number | null; threadedComments: number | null } {
  const lines = text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
  const numberFor = (pattern: RegExp): number | null => {
    const match = text.replace(/\s+/g, " ").match(pattern)
    return match ? parseInt(match[1].replace(/,/g, ""), 10) : null
  }
  let likes = numberFor(/(\d[\d,]*)\s+(?:likes?|reactions?)/i)
  if (!likes) {
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d+$/.test(lines[i]) && /others|reactions?/i.test(lines[i + 1])) {
        likes = parseInt(lines[i], 10)
        break
      }
    }
  }
  const comments = numberFor(/(\d[\d,]*)\s+comments?/i)
  return {
    likes,
    reposts: numberFor(/(\d[\d,]*)\s+(?:reposts?|shares?)/i),
    comments,
    threadedComments: comments
  }
}

function extractPostTextFromLines(lines: string[], eventTitle: string, organizerName: string | null): string | null {
  const visibilityIndex = lines.findIndex(line => /Visible to anyone/i.test(line))
  const metadataEndIndex = visibilityIndex !== -1 ? visibilityIndex : lines.findIndex(line => /followers?|week|weeks|day|days|hour|hours|minute|minutes/i.test(line))
  const startIndex = metadataEndIndex !== -1 ? metadataEndIndex + 1 : lines.findIndex(line => line.length > 25 && line !== eventTitle && !/followers?|Visible to anyone|week|weeks|day|days|hour|hours|minute|minutes/i.test(line))
  if (startIndex === -1 || startIndex >= lines.length) return null
  const parts: string[] = []
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    if (/^\d+$/.test(line) || /^\d+\s+repost/i.test(line) || /^Reactions?$/i.test(line) || /^Like$/i.test(line) || /^Comment$/i.test(line) || /^Repost$/i.test(line) || /^Send$/i.test(line) || /^Add a comment/i.test(line) || /^Other events for you$/i.test(line) || isLinkedInNoiseText(line)) break
    if (organizerName && line === organizerName && parts.length) continue
    parts.push(line)
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim()
  return text || null
}

export function extractLinkedInPostCard(eventTitle: string, organizerName: string | null, root: Element | null): { text: string | null; posterName: string | null; followerCountText: string | null; engagement: { likes: number | null; reposts: number | null; comments: number | null; threadedComments: number | null } } {
  const containers = Array.from((root || document.body).querySelectorAll("article, [role='article'], section, div"))
    .filter(el => isVisibleElement(el))
    .map(el => {
      const text = visibleText(el)
      let score = 0
      if (isLinkedInNoiseText(text)) score -= 200
      if (organizerName && text.includes(organizerName)) score += 40
      if (text.includes(eventTitle)) score += 20
      if (/followers?/i.test(text)) score += 25
      if (/Like|Comment|Repost|Send|repost|reactions?/i.test(text)) score += 25
      if (/Visible to anyone/i.test(text)) score += 120
      if (/Add to calendar|Attendee profile images|Reach up to 120,000 more impressions/i.test(text)) score -= 40
      if (text.length > 200) score += 10
      return { text, score }
    })
    .filter(item => item.score > 20)
    .sort((a, b) => b.score - a.score)

  const best = containers[0]
  if (!best) {
    return { text: null, posterName: organizerName, followerCountText: null, engagement: { likes: null, reposts: null, comments: null, threadedComments: null } }
  }

  const lines = best.text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
  const followerCountText = lines.find(line => /followers?/i.test(line)) || null
  const postText = extractPostTextFromLines(lines, eventTitle, organizerName)
  const posterName = organizerName || lines.find(line => /^[A-Z][A-Za-z0-9&.'’\-]+(?:\s+[A-Z][A-Za-z0-9&.'’\-]+){0,4}$/.test(line) && line !== eventTitle && !/followers?/i.test(line)) || null
  return {
    text: postText,
    posterName,
    followerCountText,
    engagement: extractEngagementCounts(best.text)
  }
}
