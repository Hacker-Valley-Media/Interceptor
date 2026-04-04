# Bugs Fixed During Testing — 2026-04-04

## Bug 1: `sendToContentScript` wrapping breaks net buffer queries
**Symptom:** `slop net log` returned "unknown action type: get_net_log"
**Cause:** `sendToContentScript` wraps messages as `{type: "execute_action", action: {...}}` but the net buffer handlers in content.ts listen for `msg.type === "get_net_log"` at the top level.
**Fix:** Added `sendNetDirect()` helper in background.ts that sends messages directly without the wrapper. Used for all `get_net_log`, `clear_net_log`, `get_captured_headers` calls.

## Bug 2: `derivedPostId` null — UGC post ID not in passive capture
**Symptom:** `likes`, `reposts`, `comments` all null because no post ID to query APIs
**Cause:** LinkedIn SSR embeds the UGC post URN in HTML, not in XHR/fetch calls that inject-net.ts intercepts. The passive capture only catches dynamic API calls, not the initial page render data.
**Fix:** Added `extractUgcPostIdFromDom()` in `event-page-dom-extraction.ts` that scans `document.body.innerHTML` for `urn:li:ugcPost:(\d{6,})` and also checks `data-urn` / `data-activity-urn` attributes.

## Bug 3: `posterFollowerCount` showed wrong follower count
**Symptom:** Returned 24,727 (Ron's personal count) instead of 11,143 (Hacker Valley Media)
**Cause:** `followerCountText` from the post card container included the event details/speakers section. The first `\d+\s+followers` match in that text was Ron's speaker bio, not the company page.
**Fix:** Added `extractPosterFollowerCount()` that searches for the first followers count AFTER the poster name in the visible text. Prioritized this over the generic `extractFollowerCountFromText`.

## Bug 4: `likes` null — engagement regex didn't match LinkedIn's format
**Symptom:** `extractEngagementCounts` returned null for likes
**Cause:** LinkedIn renders reaction counts as "7\nYash Gorasiya and 6 others" — separate lines. The regex `(\d+)\s+(?:likes?|reactions?)` doesn't match. The fallback `^\d+$` followed by `others|reactions?` should catch it but the post card container wasn't scoping to include that section.
**Fix:** Added a new fallback pattern: `(\d+)\s+[A-Z].*?and\s+(\d+)\s+others?` which matches the "7 Yash Gorasiya and 6 others" format.

## Bug 5: `reposts` null — post card container too narrow
**Symptom:** "1 repost" visible on screen but not captured
**Cause:** The repost count button `[e37]` is outside the post card container's DOM scope.
**Fix:** Added fallback extraction from `visibleTextPreview` in the payload builder: `(\d+)\s+reposts?`.

## Bug 6: Post card container scoring too aggressive with penalties
**Symptom:** Post card found the event header ("Event by Hacker Valley Media") instead of the actual social post below
**Cause:** The scoring function penalized "Add to calendar" and "Attendee profile images" but the penalty (-40) was offset by the organizer name bonus (+40). Also, the "Reach up to 120,000" text was hardcoded and didn't match "130,000".
**Fix:** Increased penalties (-60/-80), added minimum text length requirement (score -50 for <100 chars), boosted "weeks ago"/"days ago" temporal indicators (+40), fixed dynamic impression count regex, and only penalized Manage+Boost when "Visible to anyone" is absent.

## Bug 7: Trusted Types collision on LinkedIn
**Symptom:** `slop eval` failed with "Policy 'slop-eval' disallowed"
**Cause:** LinkedIn's CSP restricts Trusted Type policy creation. inject-net.ts creates "slop-net" policy, then when `evaluate` action tries "slop-eval", LinkedIn blocks it.
**Fix:** Added fallback policy name with timestamp suffix, and graceful degradation to raw eval if policy creation fails entirely.
