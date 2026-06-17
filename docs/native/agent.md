# macOS Runtime Surface

In-process runtime **introspection and control of native macOS apps** (AppKit/
SwiftUI/C++/Rust) — the fourth Interceptor surface. Where the macOS bridge sees the
*outside* of an app (AX tree, OS input, window pixels), the Runtime Agent runs an
Interceptor dylib *inside* the target process and drives it against the host's
own Objective-C/Swift runtime: read the live view/object graph, run selectors,
**rewrite the text you actually see**, intercept/redirect calls — no Frida, no
SIP-off.

This is the native runtime sibling of the Electron/Chromium surface: load a resident
agent, then drive it over the daemon's WebSocket transport. The agent registers as
`runtime:<app>`, so `contexts`, verb routing, and disambiguation all reuse the
existing extension paths.

## The way-in ladder

`macos runtime discover` classifies each app and picks the **lightest** vector that
works. Re-signing is the hammer, used only for hardened pure-native apps where
the operator supplies the agent dylib and signing identity.

| Rung | Target | Vector | Re-sign? |
|---|---|---|---|
| 1 | your own app | link the agent at build (or it calls `interceptor_agent_start()`) | No |
| 2 | Electron/.NET/JVM/… | the runtime's own debug channel — use `interceptor macos cdp` / `interceptor macos cdp app` | No |
| 3 | weak-entitlement native (`disable-library-validation` + `allow-dyld-environment-variables`) | `DYLD_INSERT_LIBRARIES` at launch | No |
| 4 | **hardened pure-native** (most SwiftUI/AppKit apps) | **local re-sign of a managed copy + resident agent load** (SIP stays ON) | Yes (consent + BYO signing identity) |
| 5 | system platform binaries | Research build only; compiled out of public Full | out of public scope |

## Commands

```
interceptor macos runtime discover [<app>]            classify running native apps + lightest way-in
interceptor macos runtime enable <app> [--build] [--confirm] [--capability-continuity]
interceptor macos runtime disable <app> [--keep]      stop + remove the managed copy
interceptor macos runtime status                      live agents (daemon) + managed copies (bridge)
interceptor macos runtime signid                      the configured BYO native re-sign identity
```

Public Full builds do not bundle or vendor-sign runtime agent dylibs. Rung-4
enablement requires:

```bash
export INTERCEPTOR_AGENT_DYLIB=/path/to/InterceptorAgent-arm64.dylib
export INTERCEPTOR_NATIVE_SIGNING_IDENTITY="Developer ID Application: Your Team"
```

Research builds may include platform target support with
`INTERCEPTOR_ENABLE_PLATFORM_TARGETS=1`; public Full builds compile out
`--allow-platform`.

Verbs (need `--context runtime:<app>`):

```
interceptor macos runtime tree   --context runtime:<app>            view + runtime graph → nN refs
interceptor macos runtime layers --context runtime:<app> --ref nN   # CALayer tree (find CATextLayer text)
interceptor macos runtime eval   --context runtime:<app> --ref nN --selector title
interceptor macos runtime mutate --context runtime:<app> --ref nN --set-text "Hello"        # standard control text
interceptor macos runtime mutate --context runtime:<app> --ref nN --set-layer-text "Hello"  # CATextLayer text
interceptor macos runtime mutate --context runtime:<app> --ref nN --set-alpha 0.3           # translucency
interceptor macos runtime mutate --context runtime:<app> --ref nN --set-hidden | --set-visible
interceptor macos runtime mutate --context runtime:<app> --ref nN --set-bg "#ff2244"        # recolor a layer
interceptor macos runtime intercept --context runtime:<app> --class NSButton --selector performClick:
interceptor macos runtime screenshot --context runtime:<app> [--ref nN] [--out shot.png]
interceptor macos runtime watch  --context runtime:<app> --ref nN --key stringValue
interceptor macos runtime net    --context runtime:<app>            passive URLSession hook
interceptor macos runtime ping   --context runtime:<app>
interceptor macos runtime delegate --context runtime:<app> macos_apps   # run a bridge (TCC) action from inside
```

## Worked example — change a label in a hardened app

```bash
interceptor macos runtime discover AuditTarget           # -> wayIn: re-sign (hardened)
export INTERCEPTOR_AGENT_DYLIB=/path/to/InterceptorAgent-arm64.dylib
export INTERCEPTOR_NATIVE_SIGNING_IDENTITY="Developer ID Application: Your Team"
interceptor macos runtime enable AuditTarget --confirm   # copy -> re-sign with your identity -> load agent -> launch
interceptor contexts                              # lists runtime:audittarget
interceptor macos runtime tree --context runtime:audittarget    # find the label's ref, e.g. n42
interceptor macos runtime mutate --context runtime:audittarget --ref n42 --set-text "Owned by Interceptor"
```

`--capability-continuity` can be added for owned or authorized apps whose
in-process checks expect original declared entitlement metadata after the managed
copy is re-signed. It does not grant OS privileges; AMFI, TCC, sandboxing, and
code signing remain the enforcement layers.

## TCC delegation

TCC is keyed on **BundleID + signature**, so re-signing resets the target's
grants — but that rarely matters:

- **In-process control needs no TCC.** Reading/mutating the host's own views,
  memory, and text is self-access, not a TCC-gated operation.
- **Privileged work is delegated to the bridge.** The agent sends a
  `{type:"delegate", action:{type:"macos_*"}}` frame; the daemon routes it to
  `interceptor-bridge`, which already holds Accessibility / Screen Recording /
  Apple Events. The bridge is the TCC principal; the agent borrows nothing.
- **Responsible-process bonus.** Because the bridge *launches* the re-signed
  copy, the target's own TCC requests can attribute to the bridge (XNU
  responsible-process), reducing re-prompts. Treated as a bonus, not relied on.

The only real cost: the re-signed copy may re-prompt for its **own** permissions
and must be re-enabled after the installed app updates.

## How it works (architecture)

```
interceptor macos runtime enable <app>
  └─ bridge NativeDomain: classify → (rung 4) copy app to ~/.interceptor/native/<slug>.app
        → copy operator-supplied InterceptorAgent.dylib into Contents/Frameworks
        → codesign -f -s "$INTERCEPTOR_NATIVE_SIGNING_IDENTITY" --deep
          (operator identity; opts out of hardened-runtime; SIP stays on)
        → NSWorkspace.openApplication (bridge = responsible process)
              with env: INTERCEPTOR_NATIVE_CONTEXT, DYLD_INSERT_LIBRARIES=<agent>
              and optionally INTERCEPTOR_ENTITLEMENT_CONTINUITY=1
  └─ agent C constructor → interceptor_agent_start() → bootstrap()
        → ws://127.0.0.1:19222  register {type:"native", contextId:"runtime:<app>"}
  └─ daemon stores the agent ws in extensionWsMap[runtime:<app>] + nativeAgentMeta
  └─ verbs route via --context runtime:<app>; the agent serves them on the host's
     main thread against NSApp.windows / the ObjC+Swift runtime.
```

- **Agent:** `interceptor-agent/` — a `.dynamic` SwiftPM lib. A C
  `__attribute__((constructor))` (linker-reliable) plus a Swift
  `@_section("__DATA,__mod_init_func")` entry both call the idempotent
  `bootstrap()`. Built per-slice (`arm64`, `arm64e`) by `build-agent.sh`.
  Public Full packages do not bundle these dylibs; set
  `INTERCEPTOR_AGENT_DYLIB`, or build an internal research package with
  `INTERCEPTOR_INCLUDE_AGENT_DYLIBS=1`.
- **Bridge:** `interceptor-bridge/Sources/Domains/NativeDomain.swift` —
  `macos_native_*` discover/enable/disable/status/signid.
- **Daemon:** `daemon/index.ts` — a `native` register branch (into
  `extensionWsMap` + `nativeAgentMeta`), a `delegate` forwarder to the bridge,
  `native_status`, and audit events (`native_agent_registered`,
  `native_enabled`, `native_delegate`, `native_agent_disconnected`).
- **CLI:** `cli/commands/native.ts` + the `native`/`mutate`/`intercept` families.
- **Types:** `shared/native-agent.ts` — the way-in classifier (shared source of
  truth with the Swift bridge), slice/runtime parsers, context-id helpers.

## Hook Fabric & runtime-style domains

The agent exposes a **tiered hook fabric** — pick the most reliable primitive that
reaches the target — wired to a runtime-shaped **domain / command / event** contract.
`enable` a domain's hooks, then drain its event stream. This is what makes native
control deterministic: a stable contract + an event stream, not one-off object
pokes.

```
# Debugger domain — set a "breakpoint" on any ObjC method (captures args + return)
interceptor macos runtime hook TargetController setValue: --context runtime:audittarget
interceptor macos runtime hook log --context runtime:audittarget # -> hookHit, args=[111], ret="void"
interceptor macos runtime hooks                                 # installed hooks + hit counts
interceptor macos runtime unhook TargetController setValue:
interceptor macos runtime trace TargetFormatter --max 40        # hook every (safe) method of a class
interceptor macos runtime untrace TargetFormatter

# DOM domain — wholesale view lifecycle
interceptor macos runtime dom-watch                             # -> viewAdded events (NSClipView, NSThemeFrame, …)

# Network / File domain — C functions via dyld __interpose (safe on modern macOS)
interceptor macos runtime cintercept open                       # -> open /etc/hosts fd=3
interceptor macos runtime cintercept getaddrinfo

# the unified stream + the domain map
interceptor macos runtime events --follow                       # stream hooks + dom + cintercept
interceptor macos runtime domains                               # Runtime / DOM / Network / Debugger / Input / Page
```

**The tiers (most → least reliable):**

| Tier | Mechanism | Reaches | Verb |
|------|-----------|---------|------|
| 1 | ObjC swizzle — generic `forwardInvocation:` interposer (Aspects pattern); captures *any* method's args+return via `NSInvocation`; the runtime signs IMPs so arm64e PAC is handled for free | any named ObjC method | `hook` / `trace` |
| 2 | class-wide trace = Tier 1 over every (safe) method of a class | a whole class's calls | `trace` |
| 3 | dyld `__interpose` — applied at **bind** (before `__DATA_CONST` locks), gated by a recording mask; **not** runtime fishhook, which corrupts libsystem GOTs on modern macOS | curated C symbols (`open`, `getaddrinfo`) | `cintercept` |
| — | DOM `addSubview:` uses a **typed block swizzle** (not forwarding — `NSView` is a hot base class) | every view added app-wide | `dom-watch` |

Safety rails: refuses to hook unsafe selectors (`release`/`respondsToSelector:`/
`forwardInvocation:`/`dealloc`/…) and root classes (`NSObject`/`NSProxy`); the C-tier
is a near-free pass-through until enabled and never writes memory at runtime.

## Limits (honest)

- The generic `hook` is safest on **specific classes**; forward-hooking a hot base
  class (`NSView`/`NSResponder`) directly is risky — `dom-watch` uses the block-swizzle
  path for those. Invoking a *hooked* method back through the `macos runtime js` bridge
  (NSInvocation→forwarded method) can be unstable; real in-app calls capture cleanly.
- Tier-3 `cintercept` is a curated allowlist (`open`/`getaddrinfo`) via dyld interpose;
  runtime fishhook of libsystem symbols is unsafe on modern macOS (`__DATA_CONST` /
  chained fixups) and is intentionally not used. Direct `svc` syscalls do not hit
  symbol-level hooks (inline tier, not built).
- `intercept` v1 handles **0-arg void selectors** (forwarded to the original,
  reported as `native_intercept` events). Other signatures need per-shape thunks.
- Reading state beyond what the UI renders (raw `@State`) needs Swift Remote
  Mirror / a debugger and is out of scope for the agent (use an own build).
- System platform binary support is compiled out of public Full builds. Internal
  research builds can opt in with `INTERCEPTOR_ENABLE_PLATFORM_TARGETS=1`;
  SIP remains on and `/System` is never modified.
- A re-signed copy loses notarization trust + TCC and must be re-enabled per app
  update — this is the documented cost of the rung-4 path.
