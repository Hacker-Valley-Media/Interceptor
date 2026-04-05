import { sendToContentScript, sendNetDirect, waitForTabLoad } from "./content-bridge"
import { buildLinkedInEventExtractionPayload } from "../linkedin/event-page-extraction-payload"
import { buildLinkedInAttendeeCliPayload } from "../linkedin/event-attendees-extraction-payload"
import { buildLinkedInEventAttendeeOverrideRules } from "../linkedin/event-attendees-request-override"
import { enrichLinkedInAttendee } from "../linkedin/attendee-profile-enrichment"
import { extractLinkedInEventId, normalizeText } from "../linkedin/linkedin-shared-types"
import { fetchLinkedInEventAttendeesById } from "../linkedin/professional-event-api"
import type { LinkedInCapturedNetworkEntry } from "../linkedin/linkedin-shared-types"

async function getLinkedInCsrfTokenFromPassiveCapture(tabId?: number): Promise<string | null> {
  if (!tabId) return null
  try {
    const result = await sendNetDirect(tabId, {
      type: "get_captured_headers", filter: "linkedin.com"
    }) as { success: boolean; data?: Array<{ headers: Record<string, string> }> }
    if (!result.success || !result.data) return null
    for (let i = result.data.length - 1; i >= 0; i--) {
      const csrf = result.data[i].headers["csrf-token"]
      if (csrf) return csrf.replace(/^"|"$/g, "")
    }
  } catch {}
  return null
}

export async function buildLinkedInEventExtraction(
  tabId: number,
  action: { type: string; [key: string]: unknown }
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  const currentTab = await chrome.tabs.get(tabId)
  const targetUrl = (action.url as string | undefined) || currentTab.url || ""
  if (!targetUrl) return { success: false, error: "linkedin event extraction requires a URL or active tab URL" }
  if (currentTab.url !== targetUrl) {
    await chrome.tabs.update(tabId, { url: targetUrl })
    await waitForTabLoad(tabId, 20000)
  }
  const waitMs = (action.waitMs as number) || 500
  await new Promise(resolve => setTimeout(resolve, waitMs))
  await sendToContentScript(tabId, { type: "wait_stable", ms: 800, timeout: 6000 })
  const domResult = await sendToContentScript(tabId, { type: "linkedin_event_dom" }) as {
    success: boolean; data?: Record<string, unknown>; error?: string
  }
  if (!domResult.success || !domResult.data) {
    return { success: false, error: domResult.error || "failed to extract LinkedIn DOM data" }
  }
  const netResult = await sendNetDirect(tabId, { type: "get_net_log", filter: "linkedin.com" }) as {
    success: boolean
    data?: Array<{ url: string; method: string; status: number; body: string; type: string; timestamp: number; tabUrl: string }>
    error?: string
  }
  const passiveEntries = (netResult.success && netResult.data) ? netResult.data : []
  const logs: LinkedInCapturedNetworkEntry[] = passiveEntries.map((e, i) => ({
    tabId,
    requestId: `passive-${i}`,
    url: e.url,
    method: e.method,
    timestamp: e.timestamp,
    status: e.status,
    mimeType: e.url.includes("json") || e.body?.startsWith("{") || e.body?.startsWith("[")
      ? "application/json"
      : undefined,
    responseBody: e.body
  }))
  return {
    success: true,
    data: await buildLinkedInEventExtractionPayload(
      targetUrl,
      domResult.data as Record<string, any>,
      logs
    )
  }
}

export async function buildLinkedInAttendeesExtraction(
  tabId: number,
  action: { type: string; [key: string]: unknown }
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  const currentTab = await chrome.tabs.get(tabId)
  const targetUrl = (action.url as string | undefined) || currentTab.url || ""
  if (!targetUrl) return { success: false, error: "linkedin attendee extraction requires a URL or active tab URL" }

  const eventId = extractLinkedInEventId(targetUrl)
  if (!eventId) return { success: false, error: "could not derive LinkedIn event ID from URL" }

  const overrideRules = buildLinkedInEventAttendeeOverrideRules(targetUrl)
  await sendNetDirect(tabId, { type: "set_net_overrides", rules: overrideRules })

  if (currentTab.url !== targetUrl) {
    await chrome.tabs.update(tabId, { url: targetUrl })
    await waitForTabLoad(tabId, 20000)
  }

  const waitMs = (action.waitMs as number) || 500
  await new Promise(resolve => setTimeout(resolve, waitMs))
  await sendToContentScript(tabId, { type: "wait_stable", ms: 800, timeout: 6000 })

  const openResult = await sendToContentScript(tabId, { type: "linkedin_attendees_open" }) as {
    success: boolean; data?: { opened?: boolean }; error?: string
  }
  const modalOpened = !!(openResult.success && openResult.data?.opened)

  const modalRows = new Map<string, any>()
  let totalCount: number | null = null
  let batchesLoaded = 0
  if (modalOpened) {
    batchesLoaded = 1
    for (let i = 0; i < 10; i++) {
      const snapshot = await sendToContentScript(tabId, { type: "linkedin_attendees_snapshot" }) as {
        success: boolean
        data?: { isOpen: boolean; totalCount: number | null; rows: any[]; showMoreVisible: boolean }
        error?: string
      }
      if (!snapshot.success || !snapshot.data?.isOpen) break
      totalCount = snapshot.data.totalCount ?? totalCount
      for (const row of snapshot.data.rows || []) {
        const key = row.profileUrl || row.fullName || `${row.rowText}-${modalRows.size}`
        if (!modalRows.has(key)) modalRows.set(key, row)
      }
      if (!snapshot.data.showMoreVisible) break
      const showMore = await sendToContentScript(tabId, { type: "linkedin_attendees_show_more" }) as {
        success: boolean; data?: { clicked?: boolean }; error?: string
      }
      if (!showMore.success || !showMore.data?.clicked) break
      batchesLoaded += 1
      await new Promise(resolve => setTimeout(resolve, 1100))
    }
  }

  const apiAttendees = await fetchLinkedInEventAttendeesById(eventId, Math.max(totalCount || 0, 250))
  const modalRowsList = Array.from(modalRows.values())
  const mergedRows = apiAttendees.map(attendee => {
    const modalMatch = modalRowsList.find(
      row => normalizeText(row.fullName) === normalizeText(attendee.display_name)
    )
    const fullName = modalMatch?.fullName || attendee.display_name || null
    const nameParts = fullName ? fullName.trim().split(/\s+/) : []
    return {
      profileUrl: modalMatch?.profileUrl || null,
      profileSlug: modalMatch?.profileSlug || null,
      fullName,
      firstName: modalMatch?.firstName || (nameParts[0] || null),
      lastName: modalMatch?.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : null),
      connectionDegree: modalMatch?.connectionDegree || null,
      headline: modalMatch?.headline || attendee.headline || null,
      rowText: modalMatch?.rowText || "",
      userId: attendee.user_id || null
    }
  })

  const enrichLimit = (action.enrichLimit as number | undefined) || mergedRows.length
  const enrichTargets = mergedRows.slice(0, enrichLimit)
  const enrichments: Awaited<ReturnType<typeof enrichLinkedInAttendee>>[] = []
  for (const row of enrichTargets) {
    enrichments.push(await enrichLinkedInAttendee(row))
  }

  await sendNetDirect(tabId, { type: "clear_net_overrides" })

  return {
    success: true,
    data: buildLinkedInAttendeeCliPayload({
      eventId,
      pageUrl: targetUrl,
      modalOpened,
      totalCount,
      batchesLoaded,
      overrideRules,
      rows: enrichTargets,
      enrichments
    })
  }
}
