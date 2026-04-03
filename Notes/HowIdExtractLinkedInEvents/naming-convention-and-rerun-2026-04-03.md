# LinkedIn Naming Convention + Rerun — 2026-04-03

## Why I changed the naming

Ron called out that generic names like `dom-date.ts` and `dom-post.ts` are too vague for where this is headed.

That was correct.

For LinkedIn work, the filenames should reflect:
- the LinkedIn page concept being parsed
- the LinkedIn endpoint family being called
- the LinkedIn object/model being extracted
- the exact role the file plays in the extraction pipeline

So I shifted away from generic DOM/API labels and toward LinkedIn-specific names.

## Current LinkedIn file map

### Page extraction / visible page concepts
- `extension/src/linkedin/event-page-visible-text.ts`
- `extension/src/linkedin/event-scheduled-time-range.ts`
- `extension/src/linkedin/event-page-sections.ts`
- `extension/src/linkedin/event-post-social-card.ts`
- `extension/src/linkedin/event-page-dom-result.ts`
- `extension/src/linkedin/event-page-dom-extraction.ts`

### Captured-response / API parsing concepts
- `extension/src/linkedin/linkedin-shared-types.ts`
- `extension/src/linkedin/linkedin-normalized-json-parsing.ts`
- `extension/src/linkedin/voyager-api-client.ts`
- `extension/src/linkedin/professional-event-api.ts`
- `extension/src/linkedin/ugc-post-social-api.ts`
- `extension/src/linkedin/event-page-captured-response-scoring.ts`
- `extension/src/linkedin/event-page-extraction-payload.ts`

### Compatibility shims left in place
These old names now only re-export the more specific modules:
- `dom-text.ts`
- `dom-date.ts`
- `dom-page.ts`
- `dom-post.ts`
- `dom-types.ts`
- `dom.ts`
- `api-client.ts`
- `event-api.ts`
- `social-api.ts`
- `json-parsing.ts`
- `shared.ts`
- `extract.ts`

That keeps the codebase usable while moving the real logic to specific LinkedIn names.

## Reference repo grounding via gh CLI

Ron asked me to use `gh` for the reference repo instead of direct web fetch.

What I pulled from `ronaldeddings/linkedin-extension`:
- `src/utils/Events/GetEventDetailsByID.ts`
- `src/utils/Events/GetEventAttendeesByID.ts`
- `src/utils/GetCommentsFromPosts.ts`
- `src/utils/GetLikesFromPosts.ts`
- `src/pages/Content/index.ts`
- `src/inject.ts`

Key useful findings:
- LinkedIn event details endpoint:
  - `/voyager/api/events/dash/professionalEvents?...eventIdentifier=<eventId>&q=eventIdentifier`
- LinkedIn attendees endpoint:
  - GraphQL `voyagerSearchDashClusters...` with `eventAttending` query param
  - the repo uses `count=50`
- LinkedIn reactions endpoint:
  - GraphQL `voyagerSocialDashReactions...`
- LinkedIn comments endpoint:
  - GraphQL `voyagerSocialDashComments...`
- The reference repo also monkeypatches XHR/fetch in page context to observe LinkedIn API traffic.

## What I added to slop-browser from that direction

### 1. Direct LinkedIn event API fetch support
The extractor now uses known LinkedIn event endpoints for:
- event details
- attendees (up to 50/page and loops)

### 2. Generic request overwrite capability
I added a generic request-rewrite command path:
- `slop network override on '<json>'`
- `slop network override off`

Live command verification:
- `./dist/slop --ws --tab 1729153354 network override on '[{"urlPattern":"*voyager/api/graphql*eventAttending*","queryAddOrReplace":{"count":50}}]' --json`
- `./dist/slop --ws --tab 1729153354 network override off --json`

Both returned success.

This is the foundation for exactly what Ron described: overriding request params such as `count` when a site only shows 20 but the backend accepts 50.

## Live rerun result after the naming cleanup + fixes

Live tab used:
- `1729153354`

### Improved fields
- `title`: correct
- `organizerName`: correct
- `thumbnail`: now meaningful event media URL, not placeholder gif
- `displayedDateText`: correct
- `startTimeIso`: now populated from screen parse with timezone offset
- `attendeeSummaryText`: now correctly trimmed to `Vadim Rachinskiy and 248 other attendees`
- `attendeeCount`: `249` (1 visible + 248 others)
- `attendeeNames`: now populated from direct attendee API fetch
- `posterName`: now `Hacker Valley Media`

### Still wrong / incomplete
- `endTimeIso` is still mixed-source and inconsistent (`2026-04-07T16:00:00.000Z` instead of a clean local-offset pair)
- `linkedPostText` is still the event header block, not the actual post body beginning with `AI is entering the SOC...`
- `posterFollowerCount` came back null in the final rerun even though the page visibly shows `11,135 followers`
- `likes`, `reposts`, `comments`, `threadedComments` are still null in the final rerun
- `matchedPostUrl` is still locking onto the wrong captured endpoint in some cases

### Screen/state evidence from rerun
I reran the live extraction and captured fresh page state.

One screenshot attempt failed with:
- `tabCapture failed: Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.`

So for this rerun, the extraction JSON + page state were the evidence, not a fresh successful screenshot.

## Current honest status

The LinkedIn extraction is meaningfully better than the first live run, but it is still not complete.

### Working now
- event title
- organizer name
- displayed date text
- start ISO timestamp fallback from screen
- attendee summary normalization
- direct attendee API pull
- meaningful thumbnail selection
- request override command path

### Not solved yet
- exact post body extraction
- consistent end timestamp normalization
- follower count reliability
- reactions/reposts/comments/threaded comments from the correct source
- stronger post-endpoint matching

## Next best follow-up work

1. Tighten `event-post-social-card` extraction so it starts after the author metadata block and before engagement controls.
2. Add a dedicated `event-post-engagement-summary` parser instead of relying on generic post card text.
3. Use the derived post URN to actively fetch reactions/comments when the page does not preload them.
4. Normalize end timestamp source selection to avoid mixed local/UTC formatting.
5. Add a LinkedIn-specific override preset/helper for attendee/search count rewriting.
