# Step 3: Interpret the Results

## Output Structure

The `slop linkedin event` command returns a single JSON payload with these top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | string | LinkedIn event ID from URL |
| `pageUrl` | string | Full event URL |
| `title` | string | Event title |
| `organizerName` | string | "Event By" name |
| `thumbnail` | string | Thumbnail image URL |
| `displayedDateText` | string | Raw date string from DOM |
| `startTimeIso` | string | ISO 8601 start time with timezone |
| `endTimeIso` | string | ISO 8601 end time |
| `timeZone` | string | IANA timezone (e.g., "America/Chicago") |
| `attendeeCount` | number | Total attendees |
| `attendeeNames` | string[] | List of attendee display names |
| `attendeeSummaryText` | string | "Vadim Rachinskiy and 246 other attendees" |
| `linkedPostText` | string | The LinkedIn post connected to the event |
| `posterName` | string | Who posted it |
| `posterFollowerCount` | number | Poster's follower count |
| `likes` | number | Total reactions on the post |
| `reposts` | number | Repost count |
| `comments` | number | Comment count |
| `threadedComments` | number | Threaded comment count |
| `detailsText` | string | Event details tab content |
| `validation` | object | Cross-validation results (true/false/null per field) |
| `sources` | object | Debug info: DOM data, network logs, API endpoints used |

## Validation Object

Each field in `validation` is:
- `true` — API data matches what's on screen
- `false` — mismatch detected (investigate)
- `null` — one or both sources missing (couldn't validate)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `attendeeCount` is null | LinkedIn may lazy-load attendees — scroll or use `slop linkedin attendees` for deep extraction |
| `posterFollowerCount` is null | Follower count only visible in DOM, not always in API |
| `startTimeIso` wrong | Check `displayedDateText` for the raw string; timezone parsing may have edge cases |
| `validation.postMatchesScreen: false` | Post text can differ between API (full) and DOM (truncated) |
