import { parseDisplayedDateRangeToIso } from "./event-scheduled-time-range"
import { extractLinkedInPostCard } from "./event-post-social-card"
import { LinkedInEventDomResult } from "./event-page-dom-result"
import { extractAttendeeSummary, extractDetailsText, extractDisplayedDate, extractEventByName, extractMeaningfulThumbnail, findLinkedInEventRoot } from "./event-page-sections"
import { isVisibleElement, visibleText } from "./event-page-visible-text"

export async function extractLinkedInEventDom(waitForDomStable: (debounceMs?: number, timeoutMs?: number) => Promise<{ stable: boolean; elapsed: number; mutations: number }>, dispatchClickSequence: (el: Element, atX?: number, atY?: number) => void): Promise<LinkedInEventDomResult> {
  const title = visibleText(document.querySelector("h1")) || document.title
  const eventRoot = findLinkedInEventRoot(title)
  const eventScope = eventRoot && visibleText(eventRoot).length > 500 ? eventRoot : (document.querySelector("main") || document.body)
  const rootText = visibleText(eventScope)
  const lines = rootText.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
  const visibleTextPreview = lines.join("\n").slice(0, 12000)
  const organizerName = extractEventByName(lines)
  const displayedDateText = extractDisplayedDate(lines)
  const attendeeSummary = extractAttendeeSummary(lines)
  const parsedDateRange = parseDisplayedDateRangeToIso(displayedDateText)
  const thumbnail = extractMeaningfulThumbnail(eventScope)
  const detailsTab = Array.from(document.querySelectorAll("button, a, [role='tab']")).find(el => isVisibleElement(el) && /^details$/i.test(visibleText(el))) as HTMLElement | undefined
  if (detailsTab) {
    dispatchClickSequence(detailsTab)
    await waitForDomStable(500, 3000)
  }
  const detailsText = extractDetailsText(eventScope, title)
  const post = extractLinkedInPostCard(title, organizerName, eventScope)
  const ugcPostId = extractUgcPostIdFromDom()
  return {
    title,
    organizerName,
    displayedDateText,
    startTimeIso: parsedDateRange.startTimeIso,
    endTimeIso: parsedDateRange.endTimeIso,
    timeZone: parsedDateRange.timeZone,
    attendeeSummary,
    attendeeCountFromScreen: attendeeSummary.totalCount,
    attendeeNamesFromScreen: attendeeSummary.names,
    thumbnail,
    detailsText,
    post,
    visibleTextPreview,
    ugcPostId
  }
}

function extractUgcPostIdFromDom(): string | null {
  const html = document.body.innerHTML
  const match = html.match(/urn:li:ugcPost:(\d{6,})/)
  if (match) return match[1]
  const dataUrns = document.querySelectorAll("[data-urn], [data-activity-urn]")
  for (const el of dataUrns) {
    const urn = el.getAttribute("data-urn") || el.getAttribute("data-activity-urn") || ""
    const urnMatch = urn.match(/ugcPost:(\d{6,})/)
    if (urnMatch) return urnMatch[1]
  }
  return null
}
