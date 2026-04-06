# Step 1: Open the LinkedIn Event Page

## Command
```bash
slop tab new "https://www.linkedin.com/events/7440080609596682240/?viewAsMember=true"
sleep 3
```

## What Happens
- Opens a new tab in the slop group
- Navigates to the LinkedIn event page
- The `?viewAsMember=true` query param ensures we see the member view with full attendee info

## Wait
LinkedIn SPAs are heavy — 3s minimum for initial render. The extraction command itself does additional DOM stability checks.
