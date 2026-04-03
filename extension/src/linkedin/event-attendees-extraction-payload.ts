import { buildLinkedInEventAttendeeOverrideRules } from "./event-attendees-request-override"
import { enrichLinkedInAttendee } from "./attendee-profile-enrichment"

export function buildLinkedInAttendeeCliPayload(input: {
  eventId: string | null
  pageUrl: string
  modalOpened: boolean
  totalCount: number | null
  batchesLoaded: number
  overrideRules: Array<{ urlPattern: string; queryAddOrReplace: Record<string, string | number | boolean> }>
  rows: Array<{ profileUrl: string | null; profileSlug: string | null; fullName: string | null; firstName: string | null; lastName: string | null; connectionDegree: string | null; headline: string | null; rowText: string; userId: string | null }>
  enrichments: Array<Awaited<ReturnType<typeof enrichLinkedInAttendee>>>
}) {
  return {
    eventId: input.eventId,
    pageUrl: input.pageUrl,
    attendeeRequestOverride: {
      enabled: true,
      targetBatchSize: 50,
      rules: input.overrideRules
    },
    attendeeCollection: {
      modalOpened: input.modalOpened,
      totalCount: input.totalCount,
      batchesLoaded: input.batchesLoaded,
      extractedRowCount: input.rows.length
    },
    attendees: input.enrichments.map((enrichment, index) => ({
      row: input.rows[index],
      profile: enrichment
    }))
  }
}
