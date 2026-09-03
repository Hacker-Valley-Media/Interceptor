# macOS Command Catalog

Full surface for `interceptor macos *`. Reference doc — load when you need flag-level detail. For task procedures, see `workflows/`. For the background-first contract that governs all input verbs, see `background-first.md`.

## Compound

```bash
interceptor macos open "Finder"                # Tree + windows (background-first)
interceptor macos open "Finder" --activate     # Explicit foregrounding
interceptor macos read --app "Mail"            # AX tree; another app stays focused
interceptor macos act <ref>                    # Click + wait + updated tree (AX press)
interceptor macos act <ref> "hello"            # AX value-set (no focus change)
interceptor macos inspect                      # Tree + apps + frontmost info
```

### Self-update rules

- Run `interceptor update`. Inspect `outcome`, `selectedVersion`, and `phase`.
- If `outcome` is `checking`, run `interceptor update status`.
- If `outcome` is `update_available`, run `interceptor macos read --app interceptor-bridge`, then act on **Install Update**.
- After download, read the changed alert for a fresh ref, then act on **Install and Relaunch**.
- When macOS requests administrator authentication and the operator stored a secret for it, fill it: `interceptor macos authdialog status` to see the prompt, then `interceptor macos authdialog fill --secret <name> --submit`. With no stored secret, stop and tell the user which secret to register.

## Apps + Windows

```bash
interceptor macos apps
interceptor macos windows --app "Brave Browser"
interceptor macos app activate "Brave Browser"  # FOCUS CHANGE — only when user asks
interceptor macos app hide / unhide / quit "X"
interceptor macos app move "Brave Browser" 0 0
interceptor macos app resize "Brave Browser" 1440 900
interceptor macos frontmost
interceptor macos move <ref> --width N --height M
interceptor macos resize <ref> --width N --height M
```

`resize`/`move` return `{frame, requested, clamped, clampedTo}`. Refs churn after geometry changes — refresh from `windows`.

## Tree + Find + Focused

```bash
interceptor macos tree --app "X"                # Auto-wakes Electron via AXManualAccessibility
interceptor macos tree --app "X" --filter interactive --depth 6
interceptor macos tree --app "X" --filter all|labels
interceptor macos find "Save" --app "X"
interceptor macos find "Send" --app "X" --role button
interceptor macos focused --app "X"
interceptor macos value <ref>
interceptor macos action <ref>
interceptor macos inspect <ref>
interceptor macos menu --app "X"
```

## Input (click / type / keys / scroll / drag)

Refs route to AX first (no focus change). `--app`/`--pid` flagged input routes via `CGEvent.postToPid`. Bare positional input follows frontmost.

```bash
interceptor macos click <ref>                       # AX press
interceptor macos click 100,200 --app "TextEdit"    # postToPid
interceptor macos type <ref> "..."                  # AX value-set (text roles)
interceptor macos type "..." --app "X"
interceptor macos keys "Meta+S" --app "X"
interceptor macos keys "Meta+A" --pid 1234
interceptor macos scroll down 400 --app "Mail" --times 5 --interval-ms 80
interceptor macos drag 100,100 200,200 --app "X"
```

OS-level escalation (for HID-source-state checks; follows frontmost):

```bash
interceptor macos type "..." --os
interceptor macos keys "..." --os
```

## Secret vault + admin prompts

Credentials live in the macOS keychain and are delivered by name. The daemon resolves the value after logging the action (name only), checks the secret's target allowlist against the real target, and hands the value to one delivery leg. Values never appear on argv, in logs, events, monitor transcripts, MCP results, or diagnose output.

```bash
interceptor macos secret register <name> [--gate none|touchid|biometry] [--target sudo|macos:<bundleId>|browser:<host>|ios|any]... [--reuse <s>]
                                                    # native box: secure field + confirm; default gate none (unattended)
interceptor macos secret set <name> --stdin         # headless: value from stdin (hidden TTY prompt without --stdin)
interceptor macos secret list                       # names, gates, targets, release counts
interceptor macos secret status                     # backend + Touch ID availability
interceptor macos secret rm <name>
interceptor macos secret unlock <name> --for 30m    # one OS prompt now; releases inside the window skip the prompt
interceptor macos secret lock [<name>]
interceptor macos secret reveal <name>              # human read-back: always OS-gated, TTY only, refused under --json / MCP

interceptor macos type [<ref>] --secret <name> [--app X]     # deliver into a native field (target: macos:<bundleId>)
interceptor macos sudo --secret <name> [--keep] -- installer -pkg X.pkg -target /   # sudo -S stdin (target: sudo)
interceptor macos authdialog status                 # is a SecurityAgent prompt up? shape: touchid | password
interceptor macos authdialog fill --secret <name> [--submit]  # presses "Use Password" on a Touch ID sheet, types, submits
```

Rules: `--secret` and literal text are mutually exclusive. Never ask the user to paste a password into chat; ask them to run `secret register`. A `target_denied` error means the secret's allowlist does not include this app or host; do not work around it by retargeting.

## Capture + Screenshot

```bash
interceptor macos screenshot --app "X" --save --target-max-long-edge 1568
interceptor macos screenshot --window <ref>
interceptor macos screenshot --region X,Y,W,H
interceptor macos capture start | status | frame | stop
interceptor macos stream start | list | frame | stop
interceptor macos display
```

CGS captures occluded / minimized / cross-Space windows. Avoid `--mode display` for app-specific captures.

## OSA Scripts + Apple Events

```bash
interceptor macos script run --jxa '<jxa>'
interceptor macos script run --jxa '<jxa>' --args '["a","b"]'
interceptor macos script run --bundle <id> --jxa '<jxa>'
interceptor macos script run --jsc '<javascript-core>'
interceptor macos script run --jsc 'run = argv => argv.join("|")' --args '["a","b"]'
interceptor macos script run --jsc 'host.sqlite("/tmp/example.sqlite", "select 1")' --jsc-host sqlite
interceptor macos script run --jsc 'host.sh("pwd").stdout' --jsc-host shell
interceptor macos script run --script '<applescript>'
interceptor macos intent dispatch --script 'tell application id "<id>" to <verb>'
interceptor macos intent dispatch --bundle <id> --jxa '<jxa>'
interceptor macos intent warmup com.brave.Browser com.apple.mail com.apple.Notes
```

Never include `activate` unless the user asked for foregrounding. `--javascript` is a deprecated alias for `--jxa`; `--jsc` is plain JavaScriptCore in the bridge and cannot use `--bundle` or JXA's `Application(...)`. Add `--jsc-host [all|fs,sqlite,shell,osa,env]` only when native host access is explicitly needed; `--jsc-unsafe-native` aliases `--jsc-host all`. First Apple Events dispatch per app prompts for consent.

## Vision + Speech + NLP + AI

```bash
interceptor macos vision text|faces|hands|bodies
interceptor macos listen
interceptor macos vad
interceptor macos sounds
interceptor macos audio output
interceptor macos audio input start --save
interceptor macos audio input stop

interceptor macos nlp entities|language|sentiment|tokens|similar|embed
interceptor macos ai status|prompt|session                # macOS 26+
interceptor macos sensitive check|monitor
```

## Log Query (OSLog)

```bash
interceptor macos log query --predicate '<NSPredicate>'
interceptor macos log query --predicate 'subsystem == "com.apple.WindowServer"'
```

Runs against `OSLogStore.local()` — system-wide.

## File System

```bash
interceptor macos fs read <path>
interceptor macos fs write <path> <content>
interceptor macos fs search --scope home|workspace|granted|<absolute-path>
interceptor macos files watch --watch-path <p>
```

Unresolvable scopes return an explicit error.

## URL Fetch

```bash
interceptor macos url get <url>
interceptor macos url post <url> --body '...'
```

## Notifications + Personal Data

```bash
interceptor macos notifications tail | log | post | schedule-* | cancel | dismiss | pending | delivered | categories | badge

interceptor macos calendar status|list|events|create|update|delete|move
interceptor macos reminders status|all|incomplete|completed|create|complete|uncomplete|delete
interceptor macos contacts status|list|find|create|update|delete|vcard|changes
interceptor macos photos status|albums|assets|export|thumbnail|favorite|delete|import|changes
interceptor macos location status|current|geocode|reverse|distance|monitor
interceptor macos music search|library|play|pause|now-playing|...
interceptor macos maps search|directions|eta|complete|reverse|mapitem-open
interceptor macos share services|airdrop|email|message|named|text|url
```

## Documents

```bash
interceptor macos pdf info|text|outline|annotations|forms|find|merge|split <path>
interceptor macos detect types|run|file <text-or-path>
interceptor macos translate text|languages|availability|prepare|batch|file
interceptor macos thumbnail [batch] <path>
```

## Trust + Permissions

```bash
interceptor macos trust                              # Current grant snapshot
interceptor macos trust --no-prompt                  # Read-only snapshot
interceptor macos trust --prompt                     # Fire all three TCC prompts
interceptor macos trust --walkthrough                # Prompt + open Settings pane
interceptor macos trust --accessibility-prompt|--screen-prompt|--microphone-prompt
```

See `permissions.md` for response shape and worked examples.

## Monitor

```bash
interceptor macos monitor start --instruction "..."
interceptor macos monitor status | list | tail <sid> | tail <sid> --raw
interceptor macos monitor pause | resume | stop [--sid <sid>]
interceptor macos monitor stop --task <taskId|name>          # epilogue: snapshot + transcript + quality grade
interceptor macos monitor export <sid>                       # text default
interceptor macos monitor export <sid> --plan | --with-bodies | --json
```

Scope: `--app`, `--apps a,b`, `--all-apps`. Optional sources: `--include clipboard|files|network|log|notifications|speech`, `--frames N`, `--vision-text`, `--watch-path <p>`, `--log-predicate "<NSPredicate>"`.

`--include speech` emits throttled partials plus utterance-final `speech_segment` events (`isFinal: true`, with text) at utterance boundaries. Task verbs (`interceptor monitor task snapshot|quality|diagnose`) accept the task name or id; `quality` synthesizes a missing transcript before grading. Prefer `stop --task` over `stop --sid` — only the task stop runs the epilogue.

## Overlays + Container + AppIntent

```bash
interceptor macos overlay create --html '<...>' --duration 5
interceptor macos overlay list | close
interceptor macos container run                      # macOS 26+
interceptor macos appintent list|registered|donate|update-parameters|supports
interceptor macos auth status|confirm "<reason>"|invalidate|domain-state
```

Panic hotkey `Ctrl+Opt+Cmd+Escape` closes every active overlay.

## Output mode

Output is plain text by default. Use `--json` only when piping into a script or another tool that needs a machine-parseable contract.
