import { fetchLinkedInJson } from "./voyager-api-client"

export async function fetchLinkedInEventDetailsById(eventId: string): Promise<unknown | null> {
  const url = `https://www.linkedin.com/voyager/api/events/dash/professionalEvents?decorationId=com.linkedin.voyager.dash.deco.events.ProfessionalEventDetailPage-49&eventIdentifier=${eventId}&q=eventIdentifier`
  return await fetchLinkedInJson(url)
}

export async function fetchLinkedInEventAttendeesById(eventId: string, maxCount = 250): Promise<Array<{ user_id: string; display_name: string; headline: string }>> {
  const pageSize = 50
  let start = 0
  const attendees: Array<{ user_id: string; display_name: string; headline: string }> = []
  while (start < maxCount) {
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=(count:${pageSize},start:${start},origin:EVENT_PAGE_CANNED_SEARCH,query:(flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:eventAttending,value:List(${eventId})),(key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))&&queryId=voyagerSearchDashClusters.a789a8e572711844816fa31872de1e2f`
    const json = await fetchLinkedInJson(url) as Record<string, any> | null
    const included = Array.isArray(json?.included) ? json!.included : []
    const pageAttendees = included
      .filter(item => item?.$type === "com.linkedin.voyager.dash.search.EntityResultViewModel")
      .map(item => {
        const entityUrn = item.entityUrn || ""
        const match = String(entityUrn).match(/fsd_profile:([^,)]+)/)
        return {
          user_id: match?.[1] || "",
          display_name: item?.image?.accessibilityText || "",
          headline: item?.primarySubtitle?.text || ""
        }
      })
      .filter(item => item.user_id && item.display_name)
    if (!pageAttendees.length) break
    attendees.push(...pageAttendees)
    if (pageAttendees.length < pageSize) break
    start += pageSize
  }
  return attendees
}
