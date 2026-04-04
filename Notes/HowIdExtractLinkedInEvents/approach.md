# How I'd Extract LinkedIn Events

## Goal

Extract structured event data from a LinkedIn event page with zero manual intervention. One command → full dataset validated against what's on screen.

## The Command

```bash
slop linkedin event "https://www.linkedin.com/events/<eventId>/?viewAsMember=true"
```

This single command does everything. No sub-agents. No multi-step orchestration.

## What It Extracts

| Data Point | Source | Validation |
|------------|--------|------------|
| Title | DOM `<h1>` + Voyager API | Cross-checked |
| Event organizer name | DOM section parsing + API | Cross-checked |
| Thumbnail | DOM `<img>` in event hero | DOM only |
| Date/time (ISO w/ timezone) | DOM displayed text → parsed to ISO | DOM date text → `parseDisplayedDateRangeToIso()` |
| Attendee count | API paginated search endpoint | Cross-checked with DOM "X attendees" text |
| Attendee names | API search endpoint (up to 250) | Merged with modal if available |
| Linked post text | DOM social card + API network capture | Cross-checked |
| Poster name | DOM + API | Cross-checked |
| Poster follower count | DOM text parsing (`"X followers"`) + API | Best of both |
| Likes count | Voyager reactions API (`voyagerSocialDashReactions`) | Falls back to DOM |
| Reposts | DOM engagement counters | DOM only |
| Comments | Voyager comments API (`voyagerSocialDashComments`) | Falls back to DOM |
| Threaded comments | Same as comments (API returns full threads) | API |
| Event details text | DOM details section | DOM + API fallback |

## Architecture: 4-Layer Extraction

### Layer 1: Network Capture (CDP Debugger)

Before navigating, the extension attaches the Chrome debugger to the tab and enables `Network.enable`. This captures all Voyager API responses as the page loads — the same JSON LinkedIn's own frontend consumes.

**Why this matters:** LinkedIn's DOM is heavily obfuscated (Ember.js, dynamic class names, `ember33`-style IDs). The API responses contain clean, structured JSON with exact field names. Network capture gives us the raw data before LinkedIn's frontend transforms it.

**Captured patterns:**
- `voyager/api/events/dash/professionalEvents` — event details
- `voyagerSocialDashReactions` — reaction/like data
- `voyagerSocialDashComments` — comment threads
- `ugcPost` / `activity` / `feed` URLs — post content

### Layer 2: Direct API Calls (Voyager REST)

After page load, the extension makes authenticated Voyager API calls using the user's session cookies (JSESSIONID for CSRF token):

1. **Event details:** `GET /voyager/api/events/dash/professionalEvents?eventIdentifier={eventId}`
2. **Attendees (paginated):** `GET /voyager/api/graphql?variables=(count:50,start:0,...)` — pages through all attendees in batches of 50
3. **Reactions:** `GET /voyager/api/graphql?...voyagerSocialDashReactions...` — all users who reacted
4. **Comments:** `GET /voyager/api/graphql?...voyagerSocialDashComments...` — full comment threads

These are the same endpoints LinkedIn's own frontend uses. The extension runs in the browser context with the user's cookies, so authentication is automatic.

### Layer 3: DOM Extraction (Content Script)

The content script parses the visible page:

- `<h1>` for title
- Section-based parsing for organizer name, date, attendees summary
- Post social card extraction (text, poster, follower count, engagement)
- Details tab text content
- Date string parsing → ISO timestamp with timezone detection

This is the "truth from the screen" — what the user actually sees.

### Layer 4: Cross-Validation

Every extracted field is validated by comparing network/API data against DOM data:

```json
"validation": {
  "titleMatchesScreen": true,
  "organizerMatchesScreen": true,
  "attendeeCountMatchesScreen": true,
  "postMatchesScreen": true,
  "posterMatchesScreen": true,
  "detailsMatchScreen": null
}
```

`true` = network matches DOM. `false` = mismatch (investigate). `null` = one source unavailable.

## Why This Design

1. **Network capture is most reliable** — API JSON is structured, typed, and doesn't change with UI redesigns
2. **DOM extraction is the visual truth** — what the user sees on screen, used to validate API data
3. **Direct API calls fill gaps** — network capture may miss responses that loaded before we started capturing; direct calls guarantee coverage
4. **Validation catches drift** — if LinkedIn changes their API schema, validation failures tell us immediately

## Key Implementation Files

| File | Purpose |
|------|---------|
| `extension/src/linkedin/event-page-extraction-payload.ts` | Main orchestrator — builds final payload |
| `extension/src/linkedin/event-page-dom-extraction.ts` | Content script DOM parsing |
| `extension/src/linkedin/event-page-sections.ts` | Section-level DOM selectors |
| `extension/src/linkedin/event-page-captured-response-scoring.ts` | Network response matching + scoring |
| `extension/src/linkedin/professional-event-api.ts` | Direct Voyager API calls (event + attendees) |
| `extension/src/linkedin/ugc-post-social-api.ts` | Post reactions + comments API |
| `extension/src/linkedin/voyager-api-client.ts` | Authenticated fetch with CSRF token |
| `extension/src/linkedin/event-scheduled-time-range.ts` | Date string → ISO parsing |
| `extension/src/linkedin/event-post-social-card.ts` | Post card DOM extraction |
| `extension/src/background.ts` | `buildLinkedInEventExtraction()` — network capture + routing |
