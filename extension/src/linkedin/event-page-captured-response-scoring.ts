import { collectIsoCandidates, collectNumberCandidates, collectStringCandidates, pickBestNumber, pickBestString, tryParseJsonBody } from "./linkedin-normalized-json-parsing"
import { extractFollowerCountFromText } from "./ugc-post-social-api"
import { isNoiseLinkedInUrl, LinkedInCapturedNetworkEntry, normalizeText } from "./linkedin-shared-types"

export function pickBestParsedResponse(entries: LinkedInCapturedNetworkEntry[], clues: { title?: string | null; organizerName?: string | null; postText?: string | null; posterName?: string | null; eventId?: string | null }, mode: "event" | "post"): { entry: LinkedInCapturedNetworkEntry; parsed: unknown } | null {
  const parsedEntries = entries
    .filter(entry => !isNoiseLinkedInUrl(entry.url))
    .map(entry => ({ entry, parsed: tryParseJsonBody(entry.responseBody) }))
    .filter(item => item.parsed !== null) as Array<{ entry: LinkedInCapturedNetworkEntry; parsed: unknown }>
  let best: { entry: LinkedInCapturedNetworkEntry; parsed: unknown; score: number } | null = null
  for (const item of parsedEntries) {
    const haystack = normalizeText(item.entry.responseBody)
    let score = 0
    if (mode === "event") {
      if (/voyager\/api\/events\/dash\/professionalevents/i.test(item.entry.url)) score += 120
      if (clues.eventId && item.entry.url.includes(clues.eventId)) score += 60
      if (clues.title && haystack.includes(normalizeText(clues.title))) score += 35
      if (clues.organizerName && haystack.includes(normalizeText(clues.organizerName))) score += 20
      if (/events|event/i.test(item.entry.url)) score += 15
    } else {
      if (/voyagerSocialDash(Reactions|Comments)|socialDetailUrn|ugcPost|comment|reaction/i.test(item.entry.url)) score += 100
      if (clues.postText && haystack.includes(normalizeText(clues.postText).slice(0, 80))) score += 45
      if (clues.posterName && haystack.includes(normalizeText(clues.posterName))) score += 20
      if (/comment|social|feed|activity|update|ugc|share/i.test(item.entry.url)) score += 20
    }
    if (item.entry.status && item.entry.status >= 200 && item.entry.status < 300) score += 5
    if (item.entry.mimeType?.includes("json")) score += 5
    if (!best || score > best.score) best = { ...item, score }
  }
  return best ? { entry: best.entry, parsed: best.parsed } : null
}

export function extractEventDataFromParsed(parsed: unknown, dom: Record<string, any>) {
  const titleCandidates = collectStringCandidates(parsed, ["title", "name", "headline", "eventname"])
  const organizerCandidates = collectStringCandidates(parsed, ["organizer", "owner", "host", "author", "actor", "name", "fullname", "displayname"])
  const descriptionCandidates = collectStringCandidates(parsed, ["description", "details", "summary", "about", "body"])
  const attendeeNameCandidates = collectStringCandidates(parsed, ["attendee", "member", "participant", "name", "fullname", "displayname"])
  const attendeeCountCandidates = collectNumberCandidates(parsed, ["attendeecount", "membercount", "participantcount", "totalattendees", "totalmembers", "count"])
  const dateCandidates = collectIsoCandidates(parsed, ["start", "end", "time", "date"])
  return {
    title: pickBestString(titleCandidates, dom.title),
    organizerName: pickBestString(organizerCandidates, dom.organizerName),
    startTimeIso: dateCandidates[0] || null,
    endTimeIso: dateCandidates[1] || null,
    attendeeCount: pickBestNumber(attendeeCountCandidates, dom.attendeeCountFromScreen),
    attendeeNames: attendeeNameCandidates
      .map(candidate => candidate.value)
      .filter(value => /^[A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){0,3}$/.test(value))
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 25),
    detailsText: pickBestString(descriptionCandidates, dom.detailsText, normalizeText(dom.detailsText).slice(0, 80))
  }
}

export function extractPostDataFromParsed(parsed: unknown, dom: Record<string, any>) {
  const textCandidates = collectStringCandidates(parsed, ["commentary", "text", "message", "description", "body"])
  const posterCandidates = collectStringCandidates(parsed, ["author", "actor", "owner", "name", "fullname", "displayname"])
  const followerCountCandidates = collectNumberCandidates(parsed, ["followercount", "followerscount"])
  const reactionCountCandidates = collectNumberCandidates(parsed, ["reactioncount", "likecount", "likes", "reaction"])
  const commentCountCandidates = collectNumberCandidates(parsed, ["commentcount", "commentscount", "comments"])
  const repostCountCandidates = collectNumberCandidates(parsed, ["repostcount", "sharecount", "shares", "reposts"])
  return {
    postText: pickBestString(textCandidates, dom.post?.text, normalizeText(dom.post?.text).slice(0, 80)),
    posterName: pickBestString(posterCandidates, dom.post?.posterName),
    followerCount: pickBestNumber(followerCountCandidates, extractFollowerCountFromText(dom.post?.followerCountText)),
    likes: pickBestNumber(reactionCountCandidates, dom.post?.engagement?.likes),
    comments: pickBestNumber(commentCountCandidates, dom.post?.engagement?.comments),
    reposts: pickBestNumber(repostCountCandidates, dom.post?.engagement?.reposts)
  }
}

export function validateValue(networkValue: unknown, domValue: unknown): boolean | null {
  if (networkValue === undefined || networkValue === null || domValue === undefined || domValue === null) return null
  if (typeof networkValue === "number" && typeof domValue === "number") return networkValue === domValue
  const left = normalizeText(String(networkValue))
  const right = normalizeText(String(domValue))
  if (!left || !right) return null
  return left === right || left.includes(right) || right.includes(left)
}
