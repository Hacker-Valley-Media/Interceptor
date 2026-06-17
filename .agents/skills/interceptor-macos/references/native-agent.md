# Runtime Agent Control - in-process runtime access for native macOS apps

Use `interceptor macos runtime` when AX is not enough: live AppKit/SwiftUI object graph,
selector calls, rendered text mutation, hooks, native network/file events, and
framework state such as MapKit. This is an owned-app control surface. It does not
use Frida and does not require SIP to be disabled.

## Pick This Surface When

| Need | Use |
|---|---|
| Read or mutate what AX cannot expose | `interceptor macos runtime tree`, `layers`, `mutate` |
| Invoke selectors or inspect Objective-C/Swift runtime objects | `macos runtime eval`, `macos runtime js --code` |
| Change rendered native text, including custom layer text | `macos runtime mutate --set-text` or `--set-layer-text` |
| Observe or redirect native calls | `macos runtime hook`, `trace`, `events`, `domains` |
| Drive native framework objects such as MapKit | `macos runtime js --code 'ObjC.msg(...)'` |

Stay on `interceptor macos *` for ordinary outside-in app work: AX buttons,
window moves, OS dialogs, capture, Apple Events, and trusted input. Use
`interceptor macos cdp` / `interceptor macos cdp app` instead for Electron web contents.

## Setup And Liveness

```bash
interceptor status
interceptor macos runtime status
interceptor macos runtime discover [<app>]
interceptor macos runtime enable <app> [--build]
interceptor contexts
interceptor macos runtime ping --context runtime:<app>
interceptor macos runtime tree --context runtime:<app>
```

Read the `mode:` line from `interceptor status` first. `macos runtime enable` needs a
Full install because the Swift bridge prepares the launch. A resident own-build
agent may still register in browser-only mode, but enabling a third-party app does not.

The core `enable` handles own-build (`--build`) and weak-entitlement targets
directly. Hardened targets are out of scope for the core; an operator-installed
extension provides that flow under its own `interceptor macos <prefix> <cmd>` verb
(run `interceptor extensions list`).

Public Full packages may not bundle runtime agent dylibs. If `macos runtime enable`
reports a missing agent, point it at a local build output:

```bash
export INTERCEPTOR_AGENT_DYLIB="$HOME/.interceptor/native/agent/InterceptorAgent-arm64.dylib"
```

Inside this repository, after rebuilding the agent, copy the arm64/arm64e dylibs
to `~/.interceptor/native/agent/` before testing the installed app path.

## Command Shape

```bash
interceptor macos runtime tree --context runtime:<app>
interceptor macos runtime read --context runtime:<app>
interceptor macos runtime layers --context runtime:<app> --ref nN
interceptor macos runtime eval --context runtime:<app> --ref nN --selector description
interceptor macos runtime mutate --context runtime:<app> --ref nN --set-text "Hello"
interceptor macos runtime mutate --context runtime:<app> --ref nN --set-layer-text "Hello"
interceptor macos runtime screenshot --context runtime:<app> [--ref nN] [--out shot.png]
interceptor macos runtime js --context runtime:<app> --code 'ObjC.className(ObjC.cls("NSApplication"))'
interceptor macos runtime hook SomeClass someSelector: --context runtime:<app>
interceptor macos runtime hook log --context runtime:<app>
interceptor macos runtime events --context runtime:<app> --limit 20
interceptor macos runtime disable <app>
```

Prefer `macos runtime js --code '<code>'` for any JavaScript beyond a trivial one-liner.
It avoids shell/flag parsing surprises and works for multi-statement snippets.
If a first JS call times out but `macos runtime ping` and `macos runtime tree` work, retry once
with `--code` before declaring the agent dead.

## JavaScript Bridge Pattern

The native JS bridge exposes an `ObjC` helper:

```js
ObjC.cls("ClassName")
ObjC.msg(receiver, "selector:with:", arg1, arg2)
ObjC.className(obj)
ObjC.responds(obj, "selector:")
```

Structs that are supported for selector arguments and return values include
`CGRect`, `CGPoint`, `CGSize`, and `CLLocationCoordinate2D`. For coordinates,
pass either `{lat, lon}` or `{latitude, longitude}`. A successful coordinate
return includes both short and long keys.

Quick coordinate round-trip:

```bash
interceptor macos runtime js --context runtime:<app> --code '
var a = ObjC.msg(ObjC.cls("MKPointAnnotation"), "new");
ObjC.msg(a, "setCoordinate:", {lat:30.2672, lon:-97.7431});
JSON.stringify(ObjC.msg(a, "coordinate"));
'
```

Expected result shape:

```json
{"lat":30.2672,"lon":-97.7431,"latitude":30.2672,"longitude":-97.7431}
```

When testing MapKit-backed views, verify both object-level marshalling and the
live view mutation:

```bash
interceptor macos runtime js --context runtime:<app> --code '
function cls(o){ try { return ObjC.msg(o,"className") } catch(e){ return "" } }
function count(a){ try { return ObjC.msg(a,"count") } catch(e){ return 0 } }
function find(v,d){
  if(!v || d>30) return null;
  if(cls(v)=="MKMapView") return v;
  var s; try { s=ObjC.msg(v,"subviews") } catch(e){ s=null }
  for(var i=0;i<count(s);i++){ var r=find(ObjC.msg(s,"objectAtIndex:",i),d+1); if(r) return r; }
  return null;
}
var app=ObjC.msg(ObjC.cls("UIApplication"),"sharedApplication");
var wins=ObjC.msg(app,"windows");
var map=null;
for(var i=0;i<count(wins) && !map;i++){ map=find(ObjC.msg(wins,"objectAtIndex:",i),0); }
if(!map) { "no MKMapView" } else {
  var before=count(ObjC.msg(map,"annotations"));
  var a=ObjC.msg(ObjC.cls("MKPointAnnotation"),"new");
  ObjC.msg(a,"setCoordinate:",{lat:30.2672,lon:-97.7431});
  ObjC.msg(a,"setTitle:","Interceptor Austin Test");
  ObjC.msg(map,"addAnnotation:",a);
  var cam=ObjC.msg(map,"camera");
  ObjC.msg(cam,"setCenterCoordinate:",{lat:30.2672,lon:-97.7431});
  ObjC.msg(map,"setCamera:animated:",cam,true);
  "pins="+before+"->"+count(ObjC.msg(map,"annotations"))+
    " center="+JSON.stringify(ObjC.msg(ObjC.msg(map,"camera"),"centerCoordinate"));
}
'
```

The `logs` array should be empty. If logs include unsupported struct arg/return
messages, the installed agent dylib is stale or the app is not using the rebuilt
agent.

## Recovery

- `contexts` missing `runtime:<app>`: run `macos runtime status`; if the agent is
  not running, re-run `macos runtime enable <app>`.
- `macos runtime ping` works but `macos runtime tree` is empty: the app may have no windows yet
  or be on a scene not backed by AppKit views; try the app's normal UI path, then
  re-read.
- JS hangs while `ping` and `tree` work: retry with `macos runtime js --code`, then
  disable and re-enable the app if needed.
- Coordinate or struct logs appear: confirm the current dylib under
  `~/.interceptor/native/agent/` is the rebuilt one and re-enable the app.
- Need OS-granted privileges such as Accessibility or Screen Recording: delegate
  to the bridge or use `interceptor macos *`; the target does not need to hold
  those TCC grants.
