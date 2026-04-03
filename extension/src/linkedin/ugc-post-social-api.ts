import { fetchLinkedInJson } from "./voyager-api-client"
import { LinkedInCapturedNetworkEntry, normalizeText } from "./linkedin-shared-types"

export function extractFollowerCountFromText(text?: string | null): number | null {
  if (!text) return null
  const match = text.match(/(\d[\d,]*)\s+followers?/i)
  return match ? parseInt(match[1].replace(/,/g, ""), 10) : null
}

export function extractPostIdFromLogs(entries: LinkedInCapturedNetworkEntry[], postText: string | null): string | null {
  const clue = normalizeText(postText).slice(0, 80)
  for (const entry of entries) {
    if (!entry.responseBody) continue
    const body = entry.responseBody
    if (clue && !normalizeText(body).includes(clue)) continue
    const match = body.match(/urn:li:ugcPost:(\d{6,})/)
    if (match) return match[1]
  }
  for (const entry of entries) {
    const match = (entry.responseBody || "").match(/urn:li:ugcPost:(\d{6,})/)
    if (match) return match[1]
  }
  return null
}

export async function fetchLinkedInReactionsByPostId(postId: string, maxCount = 100): Promise<Array<{ user_id: string; display_name: string; headline?: string }>> {
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${maxCount},start:0,threadUrn:${encodeURIComponent(`urn:li:ugcPost:${postId}`)})&&queryId=voyagerSocialDashReactions.9c8a84d441790b2edf06110ed28b675c`
  const json = await fetchLinkedInJson(url) as Record<string, any> | null
  const included = Array.isArray(json?.included) ? json!.included : []
  return included
    .filter(item => item?.$type === "com.linkedin.voyager.dash.social.Reaction")
    .map(item => ({
      user_id: String(item.preDashActorUrn || "").split(":").pop() || "",
      display_name: item?.reactorLockup?.title?.text || "",
      headline: item?.reactorLockup?.subtitle?.text || undefined
    }))
    .filter(item => item.user_id)
}

export async function fetchLinkedInCommentsByPostId(postId: string, maxCount = 100): Promise<Array<{ comment_id: string; user_id: string; comment_text: string }>> {
  const encodedPostId = encodeURIComponent(`urn:li:ugcPost:${postId}`)
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:${maxCount},numReplies:100,socialDetailUrn:urn%3Ali%3Afsd_socialDetail%3A%28${encodedPostId}%2C${encodedPostId}%2Curn%3Ali%3AhighlightedReply%3A-%29,sortOrder:RELEVANCE,start:0)&&queryId=voyagerSocialDashComments.053c2a505a15e5561b6df67b905d056a`
  const json = await fetchLinkedInJson(url) as Record<string, any> | null
  const included = Array.isArray(json?.included) ? json!.included : []
  return included
    .filter(item => item?.$type === "com.linkedin.voyager.dash.social.Comment")
    .map(item => ({
      comment_id: item.urn || "",
      user_id: String(item?.commenter?.actor?.["*profileUrn"] || item?.commenter?.actor?.["*companyUrn"] || "").split(":").pop() || "",
      comment_text: item?.commentary?.text || ""
    }))
    .filter(item => item.comment_id)
}
