# LinkedIn Event Extraction Methodology

## Date: 2026-04-04

## Flow

```
1. slop tab new "https://www.linkedin.com/events/<ID>/?viewAsMember=true"
2. inject-net.ts (MAIN world, document_start) patches fetch/XHR on the page
3. Page loads — all API calls passively captured in content.ts ring buffer
4. slop linkedin event <url> triggers:
   a. DOM extraction: title, organizer, date, attendee summary, thumbnail, post card, details
   b. Content script queries passive net buffer for captured responses
   c. DOM extraction scrapes ugcPostId from page innerHTML (urn:li:ugcPost:NNNN)
   d. Direct API calls from extension context:
      - fetchLinkedInEventDetailsById (voyager event details)
      - fetchLinkedInEventAttendeesById (voyager graphql search, max 250)
      - fetchLinkedInReactionsByPostId (if ugcPostId found)
      - fetchLinkedInCommentsByPostId (if ugcPostId found)
   e. DOM post card extraction: poster name, follower count, engagement counts
   f. Fallback extraction from visibleTextPreview for reposts, poster followers
   g. Validation: compare network/API data against screen DOM
```

## Data Sources & Priority

| Field | Primary Source | Fallback | Fallback 2 |
|-------|---------------|----------|------------|
| title | Direct API (voyager event details) | DOM h1 | — |
| organizerName | Direct API | DOM "Event by" pattern | — |
| startTimeIso / endTimeIso | DOM date parsing → ISO | API parsed dates | — |
| timeZone | DOM Intl.DateTimeFormat | — | — |
| attendeeCount | Direct API (capped 250) | DOM "and N other attendees" | Passive capture |
| attendeeNames | Direct API (graphql search, 250 max) | Passive capture | DOM screen names |
| thumbnail | DOM #ember33 img | Largest visible img in event root | — |
| posterName | DOM post card extraction | organizer name | — |
| posterFollowerCount | visibleTextPreview (poster-specific match) | Post card followerCountText | — |
| likes | Reactions API (exact user list) | DOM engagement regex | Passive capture |
| reposts | DOM engagement regex | visibleTextPreview "N repost" | — |
| comments | Comments API (exact items) | DOM engagement regex | — |
| ugcPostId | DOM innerHTML `urn:li:ugcPost:NNNN` | Passive capture body scan | — |
| detailsText | DOM details tab click → visible text | — | — |

## Key Findings

### ugcPostId from DOM (Critical Discovery)
LinkedIn embeds `urn:li:ugcPost:NNNN` in the page HTML. The content script (ISOLATED world) can scan `document.body.innerHTML` for this pattern. This eliminated the need for CDP network capture to find the post URN — it was always in the DOM.

### Passive Capture Catches Real-time Traffic Only
The inject-net.ts script patches `fetch()` and `XMLHttpRequest` at `document_start`, so it catches all JS-initiated requests. However, LinkedIn SSR (server-side rendered) data is embedded in the initial HTML, not fetched via JS. This means the main event/post data isn't in passive capture — it's in the DOM. The passive capture catches real-time updates (messaging, presence, subscriptions).

### Post Card Container Scoring Is Fragile
LinkedIn event pages have complex DOM with the event header, the linked post, and the details section all nested. The post card extractor needs heavy penalty scoring for event header elements ("Add to calendar", "Attendee profile images", "Manage", "Boost") and heavy bonus for post-specific markers ("Visible to anyone", "N weeks ago", "followers").

### posterFollowerCount Resolution
The poster's follower count must be extracted from the visibleTextPreview using a poster-name-anchored search (find posterName, then match the FIRST `N followers` within 500 chars). Without this anchor, the extraction picks up speaker follower counts from the details section.

### Manage Attendees Modal (20→50 Override)
The `buildLinkedInEventAttendeeOverrideRules` function creates CDP `Fetch.enable` rules that intercept graphql attendee requests and rewrite `count: 20` to `count: 50`. This requires CDP debugger attachment. The modal can be opened by:
1. Click "Manage" button (e19)
2. Click "Manage attendees" (e20)
3. Modal opens with attendee list + "Show more results" button

### What Requires CDP vs What Doesn't

| Feature | CDP Required | Why |
|---------|-------------|-----|
| Event extraction | ❌ No | DOM + direct API calls |
| Passive network capture | ❌ No | inject-net.ts MAIN world |
| Attendee list (basic) | ❌ No | Direct API graphql search |
| Attendee list (20→50 override) | ✅ Yes | Fetch.enable intercepts requests |
| Network request rewriting | ✅ Yes | Only CDP can modify in-flight requests |

## Test Results (Event 7440080609596682240)

```
✅ title: Would You Let AI Run Your SOC?
✅ organizer: Hacker Valley Media
✅ thumbnail: https://media.licdn.com/dms/image/v2/D5624AQGfhw9m4P4wcA/...
✅ date: Tue, Apr 7, 2026, 11:00 AM - 12:00 PM (your local time)
✅ startISO: 2026-04-07T11:00:00-05:00
✅ endISO: 2026-04-07T12:00:00-05:00
✅ timezone: America/Chicago
✅ attendeeCount: 250 (API cap; screen shows 254)
✅ attendeeNames: 250 names from API
✅ posterName: Hacker Valley Media
✅ posterFollowers: 11,143
✅ likes: 7 (from reactions API)
✅ reposts: 1 (from visibleTextPreview)
⚪ comments: 0 (genuinely no comments on this post)
✅ ugcPostId: 7440080611656171520
✅ detailsText: Full event description with speaker info
```

## Files Changed During This Session

| File | Change |
|------|--------|
| `extension/src/inject-net.ts` | NEW — MAIN world fetch/XHR monkey-patch |
| `extension/src/content.ts` | Added passive net buffer + header capture |
| `extension/src/background.ts` | Added net_log/clear/headers, sendNetDirect, CSRF from passive capture, LinkedIn extraction uses passive capture |
| `extension/src/linkedin/event-page-dom-result.ts` | Added ugcPostId field |
| `extension/src/linkedin/event-page-dom-extraction.ts` | Added extractUgcPostIdFromDom() |
| `extension/src/linkedin/event-page-extraction-payload.ts` | ugcPostId fallback, posterFollowerCount from preview, reposts from preview |
| `extension/src/linkedin/event-post-social-card.ts` | Better container scoring, followerCount regex, likes regex fallback |
| `extension/manifest.json` | inject-net.js MAIN world at document_start |
| `scripts/build.sh` | Added inject-net.ts build |
| `cli/index.ts` | Added slop net log/clear/headers commands |
