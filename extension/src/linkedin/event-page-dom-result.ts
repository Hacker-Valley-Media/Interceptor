export type LinkedInEventDomResult = {
  title: string
  organizerName: string | null
  displayedDateText: string | null
  startTimeIso: string | null
  endTimeIso: string | null
  timeZone: string | null
  attendeeSummary: { text: string | null; totalCount: number | null; names: string[] }
  attendeeCountFromScreen: number | null
  attendeeNamesFromScreen: string[]
  thumbnail: string | null
  detailsText: string | null
  post: {
    text: string | null
    posterName: string | null
    followerCountText: string | null
    engagement: { likes: number | null; reposts: number | null; comments: number | null; threadedComments: number | null }
  }
  visibleTextPreview: string
}
