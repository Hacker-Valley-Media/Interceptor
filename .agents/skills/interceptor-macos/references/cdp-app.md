# CDP App Control — driving Electron / Chromium desktop apps

A third Interceptor surface: read DOM, run JavaScript, capture network, and
screenshot **inside** an Electron/Chromium app's web content (Slack, VS Code,
Descript, Notion, Discord, …) — what the macOS AX/screen surface can't reach.

These commands need the **daemon** but **not** the Swift bridge — process
detection, signals, and relaunch are all daemon-side, so `macos cdp` and
`macos cdp app` work in `browser-only` installs too.

## Two paths through one idea

| | Path A — `interceptor macos cdp` (direct CDP) | Path 0 — `interceptor macos cdp app` (extension) |
|---|---|---|
| Mechanism | relaunch with `--remote-debugging-port`, drive renderer via CDP | SIGUSR1 → main-process inspector → `session.loadExtension` |
| Restart? | yes (state-losing relaunch) | **no** (signals the running process) |
| Fuse gate | **none** (`--remote-debugging-port` is not fuse-gated) | `nodeCliInspect` (Electron default ON) |
| Works on hardened apps (Slack/Claude)? | **yes** | no (fuse off → falls back to Path A) |
| Control | per-verb CDP (`Runtime.evaluate`, `Input.*`, `Page.*`) | resident extension's content scripts (close to core) |

**Pick:** use `macos cdp connect <port>` directly when `macos cdp app discover`
or `macos cdp app status` shows an existing `remoteDebuggingPort`. Use
`macos cdp app attach` only when no renderer
debug port is already present and you specifically want the resident-extension
Path 0. The daemon refuses the default `macos cdp app attach` SIGUSR1 path when a CDP port
is already present, because signaling a running Electron app that is already
debuggable is unnecessary and can terminate some apps.

> Note on hardened apps: native injection (Frida/task_for_pid) does **not** work
> on macOS for notarized apps — the Hardened Runtime blocks task ports even as
> root, and the bypass (`processor_set_tasks` + `com.apple.system-task-ports`) is
> an Apple-only entitlement. So Slack/Claude (all node fuses off) require a
> `--remote-debugging-port` relaunch; there is no no-restart route for them.

## Command catalog

```
# Path A — direct CDP
interceptor macos cdp discover                       # list running Electron apps + CDP/debug-port status
interceptor macos cdp launch <app> --port N --confirm  # quit + relaunch with --remote-debugging-port (loses unsaved state)
interceptor macos cdp connect <port> [--app NAME] [--url HINT]   # attach to a debug port → registers cdp:<name>
interceptor macos cdp targets  --context cdp:<id>     # list debuggable targets (windows/workers)
interceptor macos cdp attach   --context cdp:<id> <targetId>     # switch the attached target
interceptor macos cdp detach   --context cdp:<id>     # close the CDP connection (app keeps running)
interceptor macos cdp status                          # connected CDP contexts
interceptor macos cdp raw --context cdp:<id> <Method> '<jsonParams>'   # any CDP method (escape hatch)

# Path 0 — inspector-bootstrap + resident extension
interceptor macos cdp app discover                        # list Electron apps + attach state
interceptor macos cdp app attach <app> [--pid N] [--inspect-port N]   # SIGUSR1 + loadExtension → app:<name>
interceptor macos cdp app attach <app> --allow-sigusr1                # explicit override when a CDP port is already present
interceptor macos cdp app detach <app>
interceptor macos cdp app status

# then drive it with the normal verbs, routed by --context:
interceptor eval   --context cdp:slack --main "document.title"
interceptor read   --context cdp:slack
interceptor screenshot --context cdp:slack
interceptor net log --context cdp:slack --filter api.slack.com
interceptor click  --context cdp:slack "button:Compose"
interceptor contexts                            # lists cdp:/app: contexts alongside browser contexts
```

## Verb support on the CDP surface

Works (no page serializer needed): `eval` (MAIN/ISOLATED), `screenshot`, `text`
(full page), `state`, `navigate`/`reload`/`back`/`forward`, `scroll`,
`click-at X,Y`, `keys`, `type` (into the focused element), `net log`/`clear`/`headers`,
`macos cdp raw`, plus all lifecycle (`discover`/`connect`/`targets`/`attach`/`detach`/`status`/`launch`).

Needs the injected page serializer (element refs / a11y tree) — **not** on this
surface; use `eval` with `document.querySelector(...)` or `screenshot` instead:
`click <ref>`, `html <ref>`, `tree`, `find`, `hover`, `focus`, `check`, `select`,
`drag`. They return a clear pointer rather than failing silently. (Full ref
parity arrives with the MV2/injected-serializer Path 0.)

## Gotchas (from live testing)

- `macos cdp launch` waits for the app to fully quit before relaunching (a bare
  `open --args` races and silently drops the flag).
- Treat `macos cdp launch` success as provisional until `macos cdp connect <port>` works or
  `curl http://127.0.0.1:<port>/json/version` returns. Some apps accept
  `--remote-debugging-port` in their argv but never open the listener.
- Put `--json` **before** the command, not after — a trailing `--json` is parsed
  into `eval` code (`document.title --json` → SyntaxError). Or just omit it.
- After a relaunch, give the app time to come up *and* expose an
  `app.<host>/client` page target before `macos cdp connect`.
- `macos cdp` screenshots save to a file by default; pass `--json` to get the dataURL
  inline instead.
- If `macos cdp app status` or `macos cdp app discover` shows `remoteDebuggingPort`, attach with
  `interceptor macos cdp connect <port> --app <name>`. Default `macos cdp app attach` refuses
  to send SIGUSR1 in this state and prints that exact fallback.
- A fully-hardened app whose `nodeCliInspect` is off will reject `macos cdp app attach`
  with a clear message and the Path A fallback commands.
- If `macos cdp app attach <app>` cannot discover an app but `ps` shows a nested helper app
  under the bundle, do not force `--pid` after the daemon says the pid is not a
  confirmed Electron main process. That refusal is the safety guard that keeps
  agents from signaling arbitrary Chromium-like processes.
- Nested Electron helper apps may need classifier work before Path 0 works. In
  that case, report the failed discovery and use Path A only if a verified CDP
  listener is available.
