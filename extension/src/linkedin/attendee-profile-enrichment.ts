import { fetchLinkedInEventAttendeesById } from "./professional-event-api"
import { fetchLinkedInCommentsByPostId, fetchLinkedInReactionsByPostId } from "./ugc-post-social-api"
import { fetchLinkedInJson } from "./voyager-api-client"

export type LinkedInAttendeeEnrichment = {
  userId: string | null
  profileUrl: string | null
  profileSlug: string | null
  fullName: string | null
  firstName: string | null
  lastName: string | null
  headline: string | null
  location: string | null
  about: string | null
  followerCount: number | null
  currentExperience: Array<{ title: string | null; company: string | null; companyId: string | null }>
  companyDetails: Array<{ id: string; name: string; headquarter: { city?: string; country?: string; geographicArea?: string; line1?: string; line2?: string; postalCode?: string; description?: string } | null; websiteUrl?: string | null; followerCount?: number | null }>
  recentActivity: Array<{ postId: string; caption: string | null; numLikes: number | null; numComments: number | null }>
}

export async function fetchLinkedInUserProfileById(userId: string): Promise<Record<string, any> | null> {
  return await fetchLinkedInJson(`https://www.linkedin.com/voyager/api/identity/profiles/${userId}/profileView`) as Record<string, any> | null
}

export async function fetchLinkedInProfileCardsByUserId(userId: string): Promise<Record<string, any> | null> {
  return await fetchLinkedInJson(`https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(profileUrn:urn%3Ali%3Afsd_profile%3A${userId})&&queryId=voyagerIdentityDashProfileCards.839ec4cbe3e3c8c7c0b797846b3f1e8a`) as Record<string, any> | null
}

export async function fetchLinkedInCompanyDetails(companyIds: string[]): Promise<Record<string, any> | null> {
  if (!companyIds.length) return null
  const formatted = companyIds.map(id => `urn%3Ali%3Afsd_company%3A${id}`)
  return await fetchLinkedInJson(`https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(companyUrns:List(${formatted.join(',')}))&queryId=voyagerOrganizationDashCompanies.40ca6d38ebc1b50aa46eb5d9ee4b55b8`) as Record<string, any> | null
}

export async function fetchLinkedInCompanyWebsiteByUniversalName(universalName: string): Promise<Record<string, any> | null> {
  return await fetchLinkedInJson(`https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(universalName:${universalName})&queryId=voyagerOrganizationDashCompanies.1164a39ce57e74d426483681eeb51d02`) as Record<string, any> | null
}

function parseProfileBasics(data: Record<string, any> | null, userId: string) {
  const profile = data?.included?.find((item: any) => item.$type === 'com.linkedin.voyager.identity.profile.Profile')
  if (!profile) {
    return {
      userId,
      fullName: null,
      firstName: null,
      lastName: null,
      headline: null,
      location: null,
      about: null,
      followerCount: null
    }
  }
  const firstName = profile.firstName || null
  const lastName = profile.lastName || null
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || null
  const locationParts = [profile.geoLocationName, profile.geoCountryName].filter(Boolean)
  return {
    userId,
    fullName,
    firstName,
    lastName,
    headline: profile.headline || null,
    location: locationParts.length ? locationParts.join(', ') : (profile.locationName || null),
    about: profile.summary || profile.about || null,
    followerCount: typeof profile.followersCount === 'number' ? profile.followersCount : null
  }
}

function parseExperience(cards: Record<string, any> | null): Array<{ title: string | null; company: string | null; companyId: string | null }> {
  const results: Array<{ title: string | null; company: string | null; companyId: string | null }> = []
  const included = Array.isArray(cards?.included) ? cards!.included : []
  for (const item of included) {
    if (!String(item?.entityUrn || '').includes(',EXPERIENCE,')) continue
    const components = item?.topComponents?.[1]?.components?.fixedListComponent?.components || []
    for (const component of components) {
      const entity = component?.components?.entityComponent
      const companyLogoUrn = entity?.image?.attributes?.[0]?.detailData?.['*companyLogo'] || ''
      const companyId = companyLogoUrn ? String(companyLogoUrn).split(':').pop() || null : null
      let title = entity?.titleV2?.text?.text || null
      let company = entity?.subtitle?.text || null
      const promotedCompany = entity?.subComponents?.components?.[0]?.components?.entityComponent?.titleV2?.text?.text
      const promotedTitle = entity?.subComponents?.components?.[0]?.components?.entityComponent?.titleV2?.text?.accessibilityText
      if (promotedCompany) company = String(promotedCompany).split(' · ')[0]
      if (promotedTitle) title = promotedTitle
      if (company) company = String(company).split(' · ')[0]
      results.push({ title, company, companyId })
    }
  }
  return results
}

function parseCompanyDetails(data: Record<string, any> | null): Array<{ id: string; name: string; headquarter: { city?: string; country?: string; geographicArea?: string; line1?: string; line2?: string; postalCode?: string; description?: string } | null; websiteUrl?: string | null; followerCount?: number | null }> {
  const included = Array.isArray(data?.included) ? data!.included : []
  const companies: Array<{ id: string; name: string; headquarter: { city?: string; country?: string; geographicArea?: string; line1?: string; line2?: string; postalCode?: string; description?: string } | null; websiteUrl?: string | null; followerCount?: number | null }> = []
  for (const item of included) {
    if (item?.$type !== 'com.linkedin.voyager.dash.organization.Company') continue
    companies.push({
      id: String(item.entityUrn || '').split(':').pop() || '',
      name: item.name || '',
      headquarter: item.headquarter ? {
        city: item.headquarter.address?.city,
        country: item.headquarter.address?.country,
        geographicArea: item.headquarter.address?.geographicArea,
        line1: item.headquarter.address?.line1,
        line2: item.headquarter.address?.line2,
        postalCode: item.headquarter.address?.postalCode,
        description: item.headquarter.description
      } : null,
      websiteUrl: item.websiteUrl || null,
      followerCount: typeof item.followerCount === 'number' ? item.followerCount : null
    })
  }
  return companies
}

function parseRecentActivity(data: Record<string, any> | null): Array<{ postId: string; caption: string | null; numLikes: number | null; numComments: number | null }> {
  const included = Array.isArray(data?.included) ? data!.included : []
  const posts: Array<{ postId: string; caption: string | null; numLikes: number | null; numComments: number | null }> = []
  for (const item of included) {
    if (item?.$type !== 'com.linkedin.voyager.dash.search.EntityResultViewModel') continue
    if (!String(item.trackingUrn || '').startsWith('urn:li:activity:')) continue
    const postId = String(item.trackingUrn).split(':').pop() || ''
    const counts = included.find((candidate: any) => candidate?.$type === 'com.linkedin.voyager.dash.feed.SocialActivityCounts' && String(candidate.preDashEntityUrn || '').includes(postId))
    posts.push({
      postId,
      caption: item.summary?.text || null,
      numLikes: typeof counts?.numLikes === 'number' ? counts.numLikes : null,
      numComments: typeof counts?.numComments === 'number' ? counts.numComments : null
    })
  }
  return posts
}

export async function enrichLinkedInAttendee(attendee: { userId: string | null; profileUrl: string | null; profileSlug: string | null; fullName: string | null; firstName: string | null; lastName: string | null; headline: string | null }): Promise<LinkedInAttendeeEnrichment> {
  if (!attendee.userId) {
    return {
      userId: attendee.userId,
      profileUrl: attendee.profileUrl,
      profileSlug: attendee.profileSlug,
      fullName: attendee.fullName,
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      headline: attendee.headline,
      location: null,
      about: null,
      followerCount: null,
      currentExperience: [],
      companyDetails: [],
      recentActivity: []
    }
  }

  const [profileView, profileCards, profileSearch] = await Promise.all([
    fetchLinkedInUserProfileById(attendee.userId),
    fetchLinkedInProfileCardsByUserId(attendee.userId),
    fetchLinkedInJson(`https://www.linkedin.com/voyager/api/graphql?variables=(start:0,origin:ENTITY_SEARCH_HOME_HISTORY,query:(keywords:Security,flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:heroEntityKey,value:List(urn%3Ali%3Afsd_profile%3A${attendee.userId})),(key:resultType,value:List(ALL))),includeFiltersInResponse:false))&queryId=voyagerSearchDashClusters.f0c4f21d8a526c4a5dd0ae253c9b6e02`) as Promise<Record<string, any> | null>
  ])

  const basics = parseProfileBasics(profileView, attendee.userId)
  const currentExperience = parseExperience(profileCards)
  const uniqueCompanyIds = Array.from(new Set(currentExperience.map(item => item.companyId).filter(Boolean))) as string[]
  const companyDetails = parseCompanyDetails(await fetchLinkedInCompanyDetails(uniqueCompanyIds))
  const recentActivity = parseRecentActivity(profileSearch)

  return {
    userId: attendee.userId,
    profileUrl: attendee.profileUrl,
    profileSlug: attendee.profileSlug,
    fullName: basics.fullName || attendee.fullName,
    firstName: basics.firstName || attendee.firstName,
    lastName: basics.lastName || attendee.lastName,
    headline: basics.headline || attendee.headline,
    location: basics.location,
    about: basics.about,
    followerCount: basics.followerCount,
    currentExperience,
    companyDetails,
    recentActivity
  }
}
