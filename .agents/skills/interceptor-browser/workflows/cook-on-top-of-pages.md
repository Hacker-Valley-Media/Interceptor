# Use Case: Cook On Top Of Existing Pages

**Date:** 2026-04-17
**Agent:** Cy (Claude Opus 4.7)
**Target:** Any live website, modified in-place with cinematic overlays — radar sweeps, HUDs, matrix rain, targeting reticles, full-screen takeovers — while the real site keeps running underneath.

---

## What "Cooking" Means Here

You open a real site in the user's real Chrome/Brave through the Interceptor extension, and you *layer on top of it*:

- The user's actual session / login / cookies are intact
- The site's real JS, network, and DOM are still running
- You inject CSS, DOM, animations, and dramatic UI over the top
- When you're done, a reload wipes everything clean

No proxy, no extension development, no fork. Mostly `interceptor eval --main` and some CSS.

On strict-CSP sites, the first `eval --main` may trigger Interceptor's CSP-bypass fallback (strip CSP for the current tab, reload once, retry). That's still the same use case; it just means the browser may need one automatic retry before the page becomes paintable.

### Why this is fun

- **Live demos.** You can turn any site into a sci-fi HUD for a keynote, a birthday surprise, or a "look what I just built" moment.
- **Plus-up screenshots.** Marketing / sales screenshots where the real product sits under branded overlays.
- **Guided tours.** Inject tour markers, spotlights, or explainer callouts that track real DOM elements (e.g. Leaflet markers).
- **Playful automation.** Rain roses or confetti over a live map for a playful, dramatic moment.

---

## The One Technique You Need

Everything in this use case is built on one core primitive:

```bash
interceptor eval --main "<javascript>"
```

- `--main` runs the code in the **page's JS world** (not the isolated extension world), so your injected DOM shares the site's stylesheets, fonts, and layout viewport.
- The JS returns a string, and Interceptor surfaces it as the result of the command.
- Because you're in the page's world, you can:
  - `document.createElement(...)` anything on top
  - Read real DOM (`document.querySelectorAll('.leaflet-marker-icon')`) to anchor overlays to real elements
  - Wipe and repaint the whole page (`document.documentElement.innerHTML = ...`) when you want a full takeover

If the site has a strict CSP, the first attempt may fail and Interceptor may need to reload the tab once before retrying. After that, the same page-world pattern works normally.

That's it. The rest is CSS taste.

---

## Quickstart: Open A Site, Drop A Banner

```bash
# 1) Open the target site in the Interceptor tab (real browser, real session)
interceptor open "https://www.openstreetmap.org/" --text-only

# 2) Inject a glowing welcome banner over the live page
interceptor eval --main "
(function(){
  const s = document.createElement('style');
  s.textContent = \`
    @keyframes cookPulse { 0%,100%{box-shadow:0 0 30px #00ff9c} 50%{box-shadow:0 0 50px #ff00e6} }
    @keyframes cookSlide { from{transform:translate(-50%,-120%);opacity:0} to{transform:translate(-50%,0);opacity:1} }
    #cook-banner{
      position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:99999;
      padding:14px 28px;background:linear-gradient(90deg,#001a0f,#0a0a0a,#1a001a);
      border:1px solid #00ff9c;color:#00ff9c;font-family:ui-monospace,monospace;
      font-size:13px;letter-spacing:.18em;
      animation:cookSlide .8s ease-out, cookPulse 2.4s ease-in-out infinite;
    }
  \`;
  document.head.appendChild(s);

  const b = document.createElement('div');
  b.id = 'cook-banner';
  b.innerHTML = '// TRANSMISSION // WELCOME // STAND BY //';
  document.body.appendChild(b);
  return 'ok';
})()
"

# 3) Screenshot to verify
interceptor screenshot --save
```

A reload removes everything. Nothing is persisted.

---

## Pattern 1: Overlay That Tracks Real DOM

The unlock: you're in the page's JS world, so you can read real elements and anchor overlays to them.

Example — drop a magenta targeting reticle on top of every visible Leaflet marker on a map:

```bash
interceptor eval --main "
(function(){
  const st = document.createElement('style');
  st.textContent = \`
    @keyframes reticleIn { 0%{transform:translate(-50%,-50%) scale(0);opacity:0}
                           60%{transform:translate(-50%,-50%) scale(1.4);opacity:1}
                           100%{transform:translate(-50%,-50%) scale(1);opacity:1} }
    .cook-reticle{
      position:absolute;width:80px;height:80px;border:2px solid #ff00e6;
      border-radius:50%;pointer-events:none;z-index:9998;
      box-shadow:0 0 20px #ff00e6, inset 0 0 20px #ff00e6;
      animation:reticleIn .8s cubic-bezier(.2,.8,.2,1.2) forwards;
    }
    .cook-reticle::before, .cook-reticle::after{
      content:'';position:absolute;background:#ff00e6;box-shadow:0 0 8px #ff00e6;
    }
    .cook-reticle::before{top:50%;left:-12px;right:-12px;height:2px;margin-top:-1px}
    .cook-reticle::after{left:50%;top:-12px;bottom:-12px;width:2px;margin-left:-1px}
  \`;
  document.head.appendChild(st);

  const markers = [...document.querySelectorAll('.leaflet-marker-icon')].slice(0, 14);
  markers.forEach((m, i) => {
    setTimeout(() => {
      const r = m.getBoundingClientRect();
      const rt = document.createElement('div');
      rt.className = 'cook-reticle';
      rt.style.left = (r.left + r.width/2) + 'px';
      rt.style.top  = (r.top  + r.height/2) + 'px';
      rt.style.transform = 'translate(-50%,-50%)';
      document.body.appendChild(rt);
    }, i * 90);
  });

  return 'reticles-locked';
})()
"
```

Two important notes:

- `position: absolute` + `getBoundingClientRect()` gives pixel-perfect alignment at the moment of injection. The reticles **do not** follow pan/zoom. If the user scrolls the map, you'd need to re-run or listen to the site's own move events.
- `z-index: 9998` keeps you above most site chrome but below your big "reveal" banner at `99999`. A z-index ladder (`9996` background radar → `9997` rain → `9998` HUD → `99999` headline) prevents overlays from fighting each other.

---

## Pattern 2: Full-Screen Takeover (kill the page, keep the tab)

When you want the site gone but the tab alive, nuke the document and repaint:

```bash
interceptor eval --main "
(function(){
  document.title = '♥ COOK ♥';
  document.documentElement.innerHTML =
    '<head><meta charset=\"utf-8\"><title>♥ COOK ♥</title></head><body></body>';

  const st = document.createElement('style');
  st.textContent = \`
    html,body{margin:0;padding:0;height:100%;background:#05010a;overflow:hidden;
              font-family:ui-monospace,monospace;cursor:none}
    body{background:radial-gradient(ellipse at 50% 40%,#1a0014 0%,#0a0008 40%,#000 100%)}
    @keyframes roseFall{
      0%{transform:translate3d(var(--x),-12vh,0) rotate(0) scale(var(--s));opacity:0}
      8%{opacity:1} 92%{opacity:1}
      100%{transform:translate3d(calc(var(--x) + var(--drift)),112vh,0)
           rotate(var(--r)) scale(var(--s));opacity:0}
    }
    .rose{position:fixed;top:0;left:0;animation:roseFall linear forwards;
          will-change:transform,opacity;user-select:none}
  \`;
  document.head.appendChild(st);

  const roses = ['🌹','🥀','💐','🌹','💖','♥'];
  function drop(){
    const r = document.createElement('div');
    r.className = 'rose';
    r.style.setProperty('--x',      Math.random()*100 + 'vw');
    r.style.setProperty('--drift', (Math.random()*30 - 15) + 'vw');
    r.style.setProperty('--s',     (0.6 + Math.random()*1.8).toFixed(2));
    r.style.setProperty('--r',     (Math.random()*1440 - 720) + 'deg');
    r.style.animationDuration = (5 + Math.random()*6) + 's';
    r.style.fontSize = (22 + Math.random()*44) + 'px';
    r.textContent = roses[Math.floor(Math.random()*roses.length)];
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 12000);
  }
  setInterval(drop, 80);

  return 'takeover-on';
})()
"
```

Optional: if your environment has a trusted OS-input path, you can also hide the browser chrome after takeover:

```bash
interceptor macos app activate "Brave Browser"
interceptor macos keys "Meta+Shift+F"    # Brave / Chrome full-screen toggle
```

`Meta+Shift+F` (⌘⇧F) triggers Chromium's actual full-screen mode — the whole screen is yours, no tabs, no URL bar. `Esc` or the same shortcut exits.

> `interceptor macos keys` produces OS-level CGEvents, so shortcuts the browser normally intercepts (like full-screen toggle) actually fire. Web-level `interceptor keys` will **not** work for browser-chrome shortcuts — they only reach the page.

If you do **not** have the macOS path available, the cook still works. Full-screen browser chrome hiding is optional polish, not the core technique.

---

## Pattern 3: Live Scrolling Intel Feed

A cheap, high-impact effect — a fake terminal log that keeps printing new lines in the corner:

```bash
interceptor eval --main "
(function(){
  const f = document.createElement('div');
  f.id = 'cook-feed';
  Object.assign(f.style, {
    position:'fixed', bottom:'30px', right:'30px',
    width:'320px', height:'180px',
    background:'rgba(0,15,8,.85)', border:'1px solid #00ff9c',
    boxShadow:'0 0 20px rgba(0,255,156,.4)',
    zIndex:9999, overflow:'hidden',
    fontFamily:'ui-monospace,monospace', fontSize:'10px',
    color:'#00ff9c', padding:'8px', pointerEvents:'none'
  });
  f.innerHTML = '<div style=\"color:#ff00e6;letter-spacing:.25em;border-bottom:1px dashed #00ff9c;padding-bottom:4px;margin-bottom:6px\">// LIVE INTEL FEED //</div><div id=\"cook-lines\"></div>';
  document.body.appendChild(f);

  const msgs = [
    '> uplink established · node NODE-07',
    '> handshake OK · 256b AES',
    '> whisperkit large-v3 online',
    '> sensor grid: 589 readers active',
    '> mission status: COOKING',
  ];
  const lines = document.getElementById('cook-lines');
  let i = 0;
  setInterval(() => {
    const d = document.createElement('div');
    d.textContent = msgs[i % msgs.length];
    lines.appendChild(d);
    while (lines.children.length > 11) lines.removeChild(lines.firstChild);
    i++;
  }, 700);

  return 'feed-up';
})()
"
```

Drop-in effect. Pairs well with a background radar sweep (a giant `conic-gradient` rotated with `@keyframes sweep`) for the full MISSION CTRL vibe.

---

## End-To-End Playbook (The Actual Session That Shipped)

This is the literal sequence I ran for the demo:

1. **Open the real site.**
   `interceptor open "https://www.openstreetmap.org/" --text-only`

2. **Tour the site's actual features** via `interceptor act eN` on the buttons from `interceptor tree`: Map → Incidents → Scanner → Stats. Screenshot each with `interceptor screenshot --save` and `Read` the JPEG to verify.

3. **Plus-up pass 1** — inject a glowing banner (Pattern: quickstart above).

4. **Plus-up pass 2** — full HUD: corner brackets, radar sweep, scrolling intel feed, targeting reticles over real Leaflet markers.

5. **Plus-up pass 3** — confetti-style dramatic reveal with screen shake (`body { animation: shake .25s infinite }`) + glitch-clip reveal card.

6. **Optional full-screen cook** — nuke the page, repaint as pure roses + headline. If trusted OS input is available, activate Brave and send `Meta+Shift+F` through `interceptor macos keys`.

7. **Exit** — `Esc` or reload the tab. Page restores cleanly.

---

## Tips That Saved Me Time

- **Return something from your IIFE.** `return 'ok'` at the bottom of `eval --main` gives you a clear success signal and avoids accidentally returning a DOM node (which serializes ugly).
- **Escape single quotes with `\\'` inside the bash string.** Double-quoted bash + single-quoted template-literal CSS lets you author multi-line CSS without `\n` noise.
- **Use `position: fixed`** for overlays that should ignore page scroll. Use `position: absolute` with `getBoundingClientRect()` values only when anchoring to a specific DOM element at injection time.
- **`pointer-events: none`** on every pure-decoration overlay so the site stays clickable underneath.
- **Z-index ladder.** Pick a single scheme early (e.g. `9996 / 9997 / 9998 / 99999`) and stick to it — it makes adding effects additive instead of combative.
- **Expect CSP on real sites.** If `eval --main` fails with a `script-src` / `unsafe-eval` error, don't abandon the cook. Interceptor may need to do a one-time reload/retry on that tab first.
- **Prefer staged injections over one huge payload.** Big one-shot HUD scripts are more likely to hit message timeouts or become miserable to debug. Frame first, then feed, then locks, then any map-specific blips.
- **Namespace everything.** Give every overlay style block, node, timer, and animation root a `cook-*` id/class so a second pass can replace the first cleanly.
- **`interceptor screenshot --save` + `Read` the JPEG** after every injection. Cooking blind produces garbage. Seeing the frame fixes 90% of layout mistakes immediately.
- **Don't forget the exit.** The user is on a live page with their real session. Prefer overlays that vanish on reload over persistent storage hacks. If you `document.documentElement.innerHTML = ...`, the user can still hit reload to get their site back.

---

## When NOT To Cook

- **Don't modify pages the user is transacting on** (checkout, banking, medical portals). Overlays are visual but the injection itself could race with real submit flows.
- **Don't cook and walk away.** These effects run `setInterval` forever. Clear your intervals or rely on the user reloading the tab.
- **Don't rely on it persisting across navigations.** Every `interceptor navigate` or link click wipes the injection — by design.

---

## Known-Good Targets

- **OpenStreetMap** — a useful proof target because it has a real strict CSP and still supports the cook flow after Interceptor's CSP-bypass retry path.
- **Wikipedia** — permissive, fast, good for banner / feed / target-lock experiments.
- **Leaflet-backed internal tools** — best for anchored reticles and radar-style map overlays because DOM markers are easy to target.

---

## Credits

This use case grew out of a live-demo session: take a real map site → live tour → increasingly dramatic overlays → a full-screen rose-rain finale with a headline glowing in the middle. The whole thing ran in one session through Interceptor's `eval --main` + `macos keys` bridge, with no code deployed anywhere.

The trick isn't the effects. The trick is realizing that a real browser extension talking to a real Chromium tab gives you a canvas that already has the user's session, data, and layout. Interceptor just hands you the brush.
