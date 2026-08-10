# Personal-data domains (PRD-66)

Seven bridge domains for the user's calendar, reminders, contacts, photos, location, music, and biometric confirmation. Every domain is TCC-gated; the bridge ships the matching `Info.plist` usage strings (see `scripts/build-bridge.sh`).

| Domain | Framework | TCC strings |
|---|---|---|
| `auth` | LocalAuthentication | `NSFaceIDUsageDescription` |
| `calendar` | EventKit (events) | `NSCalendarsFullAccessUsageDescription`, `NSCalendarsWriteOnlyAccessUsageDescription`, `NSCalendarsUsageDescription` |
| `reminders` | EventKit (reminders) | `NSRemindersFullAccessUsageDescription`, `NSRemindersUsageDescription` |
| `contacts` | Contacts | `NSContactsUsageDescription` (+ `com.apple.developer.contacts.notes` entitlement for `note`) |
| `photos` | PhotoKit | `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription` |
| `location` | CoreLocation | `NSLocationUsageDescription`, `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription` |
| `music` | MusicKit | `NSAppleMusicUsageDescription` |

## Auth (LocalAuthentication, macOS 10.10+)

```bash
interceptor macos auth status
interceptor macos auth confirm "<reason>" [--policy biometry|any|biometry-or-watch]
   [--fallback-title "..."] [--cancel-title "..."] [--reuse <seconds>]
interceptor macos auth invalidate
interceptor macos auth domain-state
```

Per-call biometric confirmation is the canonical safety primitive — pair with destructive `interceptor macos *` actions to gate them on a Touch ID tap.

## Calendar (EventKit events)

```bash
interceptor macos calendar status
interceptor macos calendar request --level full|write
interceptor macos calendar list | default | sources
interceptor macos calendar create-calendar --title "..." --type local --color "#ff0000"
interceptor macos calendar delete-calendar <id>
interceptor macos calendar events --start <ISO8601> --end <ISO8601> [--calendar <id>]
interceptor macos calendar event <id>
interceptor macos calendar create --title "..." --start <ISO8601> --end <ISO8601>
   [--calendar <id>] [--all-day] [--location "..."] [--notes "..."]
   [--alarm <relative-offset|absolute-iso>] [--alarm ...]
   [--recurrence-frequency daily|weekly|monthly|yearly --recurrence-interval N]
interceptor macos calendar update <id> [...same fields...] [--span this|future]
interceptor macos calendar delete <id> [--span this|future]
interceptor macos calendar move <id> --to <target-calendar-id>
interceptor macos calendar refresh-sources | reset | tail
```

`request --level write` creates events without revealing other calendars (per Apple's docs). On macOS < 14, `request` falls back to legacy `requestAccess(to:)`.

## Reminders (EventKit reminders)

```bash
interceptor macos reminders status
interceptor macos reminders request                           # full-access only (no writeOnly per Apple docs)
interceptor macos reminders lists | default
interceptor macos reminders all --list <id>
interceptor macos reminders incomplete --list <id> [--due-start <ISO> --due-end <ISO>]
interceptor macos reminders completed --list <id> --since <ISO> --until <ISO>
interceptor macos reminders create --title "..." --list <id>
   [--due <ISO>] [--start <ISO>] [--priority high|medium|low|none]
   [--notes "..."] [--url "..."]
interceptor macos reminders update <id> [...]
interceptor macos reminders complete <id> | uncomplete <id>
interceptor macos reminders delete <id>
```

## Contacts

```bash
interceptor macos contacts status
interceptor macos contacts request
interceptor macos contacts containers | default-container
interceptor macos contacts groups [--container <id>]
interceptor macos contacts group <id>
interceptor macos contacts group-create --name "..." [--container <id>]
interceptor macos contacts group-update <id> --name "..."
interceptor macos contacts group-delete <id>
interceptor macos contacts group-add-member <id> --contact <contact-id>
interceptor macos contacts group-remove-member <id> --contact <contact-id>
interceptor macos contacts list [--container <id>] [--group <id>] [--limit N --offset N]
interceptor macos contacts contact <id>
interceptor macos contacts me
interceptor macos contacts find "<query>" | --email <addr> | --phone <num>
interceptor macos contacts create --given "Alice" --family "Smith"
   [--organization "..."] [--email work:alice@example.com,home:a@y.com]
   [--phone mobile:+1-555-1234,work:+1-555-9999]
   [--postal home:"1 Apple Park Way;Cupertino;CA;95014;USA"]
   [--birthday YYYY-MM-DD] [--note "..."] [--container <id>]
interceptor macos contacts update <id> [...]
interceptor macos contacts delete <id>
interceptor macos contacts vcard <id>
interceptor macos contacts import-vcard <path>
interceptor macos contacts current-token
interceptor macos contacts changes --since <token>
```

The `note` field requires Apple's `com.apple.developer.contacts.notes` entitlement. The bridge sets `note: null` and a structured `requires_entitlement: "..."` field on responses when the entitlement isn't present.

## Photos (PhotoKit)

```bash
interceptor macos photos status
interceptor macos photos request --level readwrite|addonly
interceptor macos photos albums [--type smart|album|moment]
interceptor macos photos album <id>
interceptor macos photos album-create --name "..."
interceptor macos photos album-delete <id> | album-rename <id> --name "..."
interceptor macos photos assets [--album <id>] [--media image|video|audio]
   [--subtype panorama|screenshot|hdr|livePhoto]
   [--since <ISO> --until <ISO>] [--favorite] [--hidden] [--burst]
   [--limit N --offset N]
interceptor macos photos asset <id>
interceptor macos photos export <id> [--size N] [--format jpeg|png] --out <path>
interceptor macos photos export-video <id> --out <path>
interceptor macos photos export-live <id> --out <path-prefix>
interceptor macos photos thumbnail <id> [--size N] [--out <path>]
interceptor macos photos favorite <id> --on|--off
interceptor macos photos hide <id> --on|--off
interceptor macos photos delete <id>[,<id>...]
interceptor macos photos add-to-album --album <id> --asset <id>[,...]
interceptor macos photos remove-from-album --album <id> --asset <id>[,...]
interceptor macos photos import --file <path> [--album <id>]
interceptor macos photos import-video --file <path> [--album <id>]
interceptor macos photos current-token
interceptor macos photos changes --token <opaque-base64>
```

The Photos predicate vocabulary follows Apple's documented allowed keys (`PHFetchOptions.md`); the bridge rejects unsupported keys with a structured error.

## Location (CoreLocation)

```bash
interceptor macos location status
interceptor macos location request --level whenInUse|always
interceptor macos location request-temporary-accuracy --purpose <Info.plist-key>
interceptor macos location current
interceptor macos location monitor start [--accuracy best|nearest|tenmeters|hundredmeters|kilometer]
interceptor macos location monitor stop | tail
interceptor macos location significant start | stop
interceptor macos location visits start | stop
interceptor macos location heading start | stop          # heading is iOS-only on macOS; structured note
interceptor macos location geocode "<address>" [--region lat,lng,radius] [--locale <bcp47>]
interceptor macos location reverse <lat,lng> [--locale <bcp47>]
interceptor macos location distance --from lat,lng --to lat,lng
interceptor macos location postal-geocode '<json-postal>'
```

`current` uses `CLLocationManager.requestLocation()` (one-shot) so the bridge doesn't keep a live session running between calls.

## Music (MusicKit)

```bash
interceptor macos music status
interceptor macos music request                                    # MusicAuthorization.request
interceptor macos music subscription                                # MusicSubscription.current
interceptor macos music search "<term>" [--types song,album,artist,playlist,curator,genre]
   [--top] [--limit N --offset N]
interceptor macos music search-suggest "<partial>"
interceptor macos music charts | recommendations
interceptor macos music library --type song|album|artist|playlist|track [--limit N]
interceptor macos music library-search "<term>" [--types ...]
interceptor macos music song <id> | album <id> | artist <id> | playlist <id>
interceptor macos music play --song <id> | --album <id> | --playlist <id>
interceptor macos music pause | resume | stop | next | previous
interceptor macos music seek --time <seconds>
interceptor macos music queue
interceptor macos music repeat off|one|all
interceptor macos music shuffle off|songs
interceptor macos music now-playing
```

`ApplicationMusicPlayer` plays *inside the bridge process* and does not move Music.app's state. To control Music.app's system-wide playback, route through the existing `interceptor macos intent dispatch --bundle com.apple.Music --script '...'` Apple Events path. `now-playing` includes a structured note explaining the split.
