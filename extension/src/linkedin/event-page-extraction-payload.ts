import { fetchLinkedInEventAttendeesById, fetchLinkedInEventDetailsById } from "./professional-event-api"
import { extractEventDataFromParsed, extractPostDataFromParsed, pickBestParsedResponse, validateValue } from "./event-page-captured-response-scoring"
import { extractFollowerCountFromText, extractPostIdFromLogs, fetchLinkedInCommentsByPostId, fetchLinkedInReactionsByPostId } from "./ugc-post-social-api"
import { extractLinkedInEventId, LinkedInCapturedNetworkEntry } from "./linkedin-shared-types"

function extractPosterFollowerCount(visibleText: string | null, posterName: string | null): number | null {
  if (!visibleText || !posterName) return null
  const escaped = posterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const idx = visibleText.search(new RegExp(escaped, "i"))
  if (idx === -1) return null
  const after = visibleText.slice(idx, idx + 500)
  const match = after.match(/(\d[\d,]*)\s+[Ff]ollowers?/)
  return match ? parseInt(match[1].replace(/,/g, ""), 10) : null
}

export async function buildLinkedInEventExtractionPayload(targetUrl: string, dom: Record<string, any>, logs: LinkedInCapturedNetworkEntry[]) {
  const eventId = extractLinkedInEventId(targetUrl)
  const eventParsed = pickBestParsedResponse(logs, { title: dom.title, organizerName: dom.organizerName, eventId }, "event")
  const postParsed = pickBestParsedResponse(logs, { postText: dom.post?.text, posterName: dom.post?.posterName, eventId }, "post")
  const directEventJson = eventId ? await fetchLinkedInEventDetailsById(eventId) : null
  const directAttendees = eventId ? await fetchLinkedInEventAttendeesById(eventId) : []
  const eventData = directEventJson ? extractEventDataFromParsed(directEventJson, dom) : eventParsed ? extractEventDataFromParsed(eventParsed.parsed, dom) : null
  const postData = postParsed && /ugcPost|social|reaction|comment/i.test(postParsed.entry.url) ? extractPostDataFromParsed(postParsed.parsed, dom) : null
  const postId = dom.ugcPostId || extractPostIdFromLogs(logs, dom.post?.text || postData?.postText || null)
  const reactionUsers = postId ? await fetchLinkedInReactionsByPostId(postId) : []
  const commentItems = postId ? await fetchLinkedInCommentsByPostId(postId) : []
  const attendeeNames = directAttendees.length
    ? directAttendees.map(item => item.display_name)
    : eventData?.attendeeNames?.length
      ? eventData.attendeeNames
      : dom.attendeeNamesFromScreen || []
  const attendeeCount = directAttendees.length > 0
    ? directAttendees.length
    : (eventData?.attendeeCount ?? dom.attendeeCountFromScreen ?? null)
  const startTimeIso = dom.startTimeIso || (eventData?.startTimeIso && !eventData.startTimeIso.startsWith("1970-") ? eventData.startTimeIso : null)
  const endTimeIso = dom.endTimeIso || eventData?.endTimeIso || null
  const likes = reactionUsers.length > 0
    ? reactionUsers.length
    : (postData?.likes ?? dom.post?.engagement?.likes ?? null)
  const comments = commentItems.length > 0
    ? commentItems.length
    : (postData?.comments ?? dom.post?.engagement?.comments ?? null)
  const repostsFromPreview = dom.visibleTextPreview ? (dom.visibleTextPreview.match(/(\d[\d,]*)\s+reposts?/i)?.[1] ? parseInt(dom.visibleTextPreview.match(/(\d[\d,]*)\s+reposts?/i)![1].replace(/,/g, ""), 10) : null) : null
  const reposts = postData?.reposts ?? dom.post?.engagement?.reposts ?? repostsFromPreview ?? null
  return {
    eventId,
    pageUrl: targetUrl,
    title: eventData?.title || dom.title || null,
    organizerName: eventData?.organizerName || dom.organizerName || null,
    thumbnail: dom.thumbnail || null,
    displayedDateText: dom.displayedDateText || null,
    startTimeIso,
    endTimeIso,
    timeZone: dom.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    attendeeCount,
    attendeeNames,
    attendeeSummaryText: dom.attendeeSummary?.text || null,
    linkedPostText: postData?.postText || dom.post?.text || null,
    posterName: postData?.posterName || dom.post?.posterName || null,
    posterFollowerCount: extractPosterFollowerCount(dom.visibleTextPreview, dom.post?.posterName || dom.organizerName) ?? postData?.followerCount ?? extractFollowerCountFromText(dom.post?.followerCountText) ?? null,
    likes,
    reposts,
    comments,
    threadedComments: comments,
    detailsText: eventData?.detailsText || dom.detailsText || null,
    validation: {
      titleMatchesScreen: validateValue(eventData?.title, dom.title),
      organizerMatchesScreen: validateValue(eventData?.organizerName, dom.organizerName),
      attendeeCountMatchesScreen: validateValue((eventData?.attendeeCount ?? (directAttendees.length > 0 ? directAttendees.length : null)), dom.attendeeCountFromScreen),
      postMatchesScreen: validateValue(postData?.postText, dom.post?.text),
      posterMatchesScreen: validateValue(postData?.posterName, dom.post?.posterName),
      detailsMatchScreen: validateValue(eventData?.detailsText, dom.detailsText)
    },
    sources: {
      dom,
      network: {
        capturedRequestCount: logs.length,
        matchedEventUrl: eventParsed?.entry.url || null,
        matchedPostUrl: postParsed?.entry.url || null,
        derivedPostId: postId,
        recentUrls: logs.slice(-15).map(entry => ({ url: entry.url, method: entry.method, status: entry.status, resourceType: entry.resourceType }))
      },
      directApi: {
        usedEventDetailsEndpoint: !!directEventJson,
        usedAttendeesEndpoint: directAttendees.length > 0,
        usedReactionsEndpoint: reactionUsers.length > 0,
        usedCommentsEndpoint: commentItems.length > 0
      }
    }
  }
}
