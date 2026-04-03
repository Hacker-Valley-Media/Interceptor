import { extractLinkedInEventId } from "./linkedin-shared-types"

export type LinkedInAttendeeRequestOverrideRule = {
  urlPattern: string
  queryAddOrReplace: Record<string, string | number | boolean>
}

export function buildLinkedInEventAttendeeOverrideRules(eventUrlOrId: string): LinkedInAttendeeRequestOverrideRule[] {
  const eventId = extractLinkedInEventId(eventUrlOrId) || eventUrlOrId
  return [
    {
      urlPattern: `*voyager/api/graphql*eventAttending*${eventId}*`,
      queryAddOrReplace: { count: 50 }
    },
    {
      urlPattern: "*voyager/api/graphql*eventAttending*",
      queryAddOrReplace: { count: 50 }
    }
  ]
}
