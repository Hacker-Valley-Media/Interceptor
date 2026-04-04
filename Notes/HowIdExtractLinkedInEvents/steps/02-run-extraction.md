# Step 2: Run the Extraction Command

## Command
```bash
slop linkedin event "https://www.linkedin.com/events/7440080609596682240/?viewAsMember=true" --json
```

## What This Single Command Does (Internally)

### Phase A: Network Capture
1. Enables Chrome debugger on the tab (`Network.enable`)
2. Captures all network traffic matching `linkedin.com`, `voyager`, `graphql`, `event`
3. Records request URLs, methods, response bodies, status codes

### Phase B: Page Load & DOM Stabilization
1. Navigates to the URL if not already there
2. Waits 2.5s for initial load
3. Runs `wait_stable` (800ms debounce, 6s timeout) — waits for DOM mutations to stop

### Phase C: DOM Extraction
Content script extracts from the live DOM:
- `<h1>` → title
- Event organizer name from the "Event By" section
- Displayed date text + parsed ISO timestamps with timezone
- Attendee count + names from the attendee summary
- Thumbnail image URL
- Linked post: text, poster name, follower count, engagement (likes/reposts/comments)
- Details tab text

### Phase D: Direct API Calls (from extension context)
Using the session's LinkedIn CSRF token:
1. `voyager/api/events/dash/professionalEvents` — full event details JSON
2. `voyagerSearchDashClusters` GraphQL — paginated attendee list (up to 250)
3. `voyagerSocialDashReactions` GraphQL — reaction users for the linked post
4. `voyagerSocialDashComments` GraphQL — comment items

### Phase E: Cross-Validation
Every field is sourced from BOTH network/API AND DOM, then validated:
- `titleMatchesScreen` — API title vs DOM `<h1>`
- `organizerMatchesScreen` — API organizer vs DOM organizer name
- `attendeeCountMatchesScreen` — API count vs DOM count
- `postMatchesScreen` — API post text vs DOM post text
- `posterMatchesScreen` — API poster vs DOM poster name
- `detailsMatchScreen` — API details vs DOM details text
