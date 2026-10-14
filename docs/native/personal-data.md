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

A recurring event's rows from `events` name each occurrence: the id ends in `@<unix seconds of that occurrence's original start>` on macOS and Windows (Linux has its own occurrence id). Pass that id to `delete --span this` to remove only that occurrence, or `--span future` to end the series before it. The plain series id (from `create` or `event`) still names the whole series. Windows and Linux refuse `update` and `move` of one occurrence instead of applying them to the series.

Apple's write-only grant permits event creation without reading the calendar store. Mutations require full access for its exact calendar identity and independent save readback, so a write-only grant alone does not satisfy the mutation preflight. On macOS before 14, explicit `request` uses legacy `requestAccess(to:)`. Consent is requested only by `request` and requires the installed app's purpose string.

Calendar validates all 17 selectors, exact fields, explicit calendar scope, real ISO8601 instants and ranges within 1461 days. Pages require integer limits 1..1000 and offsets 0..10000. Invalid calendar IDs never broaden queries. Updates apply supplied alarms and recurrence fields. Saves and deletes require native readback. One request per domain remains admitted until native completion or reminder fetch cancellation resolves, including after a 55-second deadline. A hung SDK call can still occupy that admission.

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

Reminders validates all 12 selectors and exact list/item identities. Only explicit `request` invokes consent. Native due/start components use Gregorian UTC with a timezone, and native fetch cancellation retains its real token. A null native fetch result fails. Creation, updates, completion and deletion use independent native store readback.

`interceptor desktop calendar` and `reminders` use the Windows appointment and task stores and Linux Evolution Data Server. Windows writes go to calendars and lists Interceptor owns; Linux item IDs bind the native source UID and component UID. Windows tasks have no URL field. What differs per host is listed in [the desktop bridge guide](../desktop-bridge.md).

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
interceptor macos contacts list [--container <id> | --group <id>] [--limit N --offset N] [--keys id,givenName,...]
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

Contacts source now validates every selector before native calls. Paging requires integer limits 1..1000 and offsets 0..10000. Import requires an absolute regular-file path, at most 256 KiB and 1..100 complete cards. History returns actual native events and a canonical base64 token; unknown events or a requested limit that would discard events fail without advancing the token. Full dates use `YYYY-MM-DD`; a native birthday without a year uses `--MM-DD`. Input birthdays still require a complete actual date within years 1..9999. Images are bounded and identify the encoded MIME type. Mutations do not request consent implicitly or replay after an unknown native outcome.

`interceptor desktop contacts` uses the Windows ContactStore and Linux EDS. Windows writes are limited to lists Interceptor owns, and Windows Contacts has no groups; Linux groups are native distribution lists. Projection keys without a native mapping refuse. See [the desktop bridge guide](../desktop-bridge.md).

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

Photos now validates every selector before native work. `assets` defaults to limit 100, accepts limits 1..1000 and offsets 0..10000, and applies an exact album scope. `--where` accepts up to eight documented scalar comparisons joined by ` AND `, for example `--where 'pixelWidth >= 1024 AND isFavorite == true'`. Boolean comparisons require `==` or `!=`; dates require quoted ISO8601 instants. Unsupported predicate keys and programs fail with a structured error.

The current source uses public `addedDate` only on macOS26, verifies actual mutation readback, imports image and video through the correct native resource request, exports actual paired Live Photo resources and enumerates native persistent history. Outputs are private and exclusive, and never replace an existing file. Raw resource exports preserve their actual UTI, including video, while explicit JPEG/PNG conversion reports encoded dimensions. Full read/write authorization is required for independent readback; explicit `request --level addonly` can request that narrower native grant but does not qualify later reads or mutations needing readback. Builds, native behavior and current installed qualification remain pending. Portable library behavior and dependency requirements are recorded in `docs/desktop-bridge.md`.

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
interceptor macos music library --kind song|album|artist|playlist|track [--limit N --offset N]
   [--filter "<text>" --sort title|artistName|name --ascending --include-tracks]
interceptor macos music library-search "<term>" [--types song,album,artist,playlist]
   [--limit N --top --include-tracks]
interceptor macos music play --song <id> | --album <id> | --playlist <id>
interceptor macos music pause | resume | stop | next | previous
interceptor macos music seek --time <seconds>
interceptor macos music queue
interceptor macos music repeat off|one|all
interceptor macos music shuffle off|songs
interceptor macos music now-playing [--include-system]
```

`--type` remains an alias for the library kind; it no longer overwrites the operation type. Supplying both aliases refuses. Limits are 1..100, offsets 0..10000 and seek positions 0..604800 seconds. Album and playlist track expansion uses actual library relationships. Catalog commands remain outside the public surface because the bridge has no MusicKit catalog team key.

`ApplicationMusicPlayer` plays inside the bridge process. `now-playing --include-system` adds a read-only Music.app snapshot through PID-addressed Apple Events. It requires existing Automation consent and never prompts, launches or activates Music. Separate Music.app controls remain on the existing intent surface. On Windows and Linux, play, pause, next, previous, seek, repeat and shuffle go through the system player; no music library ships there (see `docs/desktop-bridge.md`).

## Share (AppKit)

`share services [--for <absolute-path>]` enumerates actual services without sending. The `airdrop`, `email`, `message`, `reading-list`, `desktop-picture`, `named`, `text` and `url` selectors require content. Named/string/URL requests require an exact `--service`; recipient aliases cannot be combined. Unknown or misplaced fields refuse before native calls.

On the Mac, share observes actual native sharing completion, retains delegates and catches native perform exceptions in Objective-C. A native composer or share sheet may display UI. Timeout reports unknown outcome, retains unresolved native admission and never replays content. Windows and Linux use the native backends described in `docs/desktop-bridge.md`.
