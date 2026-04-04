# Manage Attendees Flow

## How It Works

### Step 1: Click Manage → Manage Attendees
The event page shows a "Manage" button (visible to event organizers). Clicking it reveals "Manage attendees" which opens a modal.

```
slop tree | grep -i manage
# [e19] button "Manage" expanded=false
# [e20] button "Manage attendees" role="button"

slop click e19   # Open dropdown
slop click e20   # Open modal
```

### Step 2: Modal Shows Attendee List
The modal shows attendees with "Send message" buttons and a "Show more results" button at the bottom.

```
slop tree | grep -i "attendee\|show more"
# [e117] tab "Attendees" role="tab" selected
# [e120] button "Send message to Gadissa Ayyansa attendee"
# [e149] button "Show more results"
```

### Step 3: The 20→50 Override (CDP)
LinkedIn's default attendee page size is 20. The override rules in `event-attendees-request-override.ts` change this to 50:

```typescript
// In buildLinkedInEventAttendeeOverrideRules():
{
  urlPattern: `*voyager/api/graphql*eventAttending*${eventId}*`,
  queryAddOrReplace: { count: 50 }
}
```

This uses CDP `Fetch.enable` to intercept the graphql request BEFORE it reaches LinkedIn's server and rewrites the `count` parameter from 20 to 50. The server returns 50 results instead of 20, so each "Show more" click loads 2.5x more attendees.

### Step 4: Pagination
The extraction clicks "Show more results" up to 10 times, collecting attendees from the modal DOM each time. Combined with the 50-per-page override, this captures up to 500 attendees from the modal.

### Step 5: API Fallback
In parallel, `fetchLinkedInEventAttendeesById` calls the voyager API directly from the extension context (not the page), fetching up to 250 attendees in pages of 50. These are merged with modal results.

## Current Status
- The 20→50 override IS coded and functional
- The override requires CDP `Fetch.enable` (causes yellow infobanner)
- The modal click flow works via slop's synthetic click events
- API direct fetch provides up to 250 attendees as a fallback

## Future: Passive Override Without CDP
Could potentially use `chrome.declarativeNetRequest` to modify the count parameter without CDP. This would avoid the debugger attachment entirely. The rule would be:
```json
{
  "action": {
    "type": "redirect",
    "redirect": { "transform": { "queryTransform": { "addOrReplaceParams": [{"key": "count", "value": "50"}] } } }
  }
}
```
This is a PRD-12 candidate.
