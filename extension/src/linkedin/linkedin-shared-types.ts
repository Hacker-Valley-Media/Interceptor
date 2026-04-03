export type LinkedInCapturedNetworkEntry = {
  tabId: number
  requestId: string
  url: string
  method: string
  resourceType?: string
  timestamp: number
  status?: number
  mimeType?: string
  requestHeaders?: Record<string, unknown>
  responseHeaders?: Record<string, unknown>
  requestPostData?: string
  responseBody?: string
  errorText?: string
}

export function normalizeText(value?: string | null): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase()
}

export function extractLinkedInEventId(url?: string | null): string | null {
  if (!url) return null
  return url.match(/\/events\/(\d+)/)?.[1] || null
}

export function isNoiseLinkedInUrl(url: string): boolean {
  return /messaging|policy\/notices|realtimeFrontendSubscriptions|presenceStatuses|deliveryAcknowledgements|seenReceipts|quickReplies|psettings|DVyeH0l6|tracking/i.test(url)
}
