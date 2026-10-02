# ClearHumanVerificationGate

You are clearing a **human-verification / CAPTCHA gate** that is blocking a page in the user's signed-in browser — reCAPTCHA, Cloudflare Turnstile, hCaptcha, or a generic "I'm not a robot" / "press & hold" widget. These gates render their interactive control inside a **cross-origin iframe**, which defeats synthetic page input: `eval --main` cannot reach into the iframe (cross-origin) and the widget ignores dispatched events. What works is a **trusted OS click** on the control. Interceptor delivers that click to the browser window **in the background**: the browser does not need to be frontmost, the window can be covered, and the cursor does not move.

This is the sibling of [`trusted-input-gate.md`](trusted-input-gate.md): the same trusted-input delivery, aimed at a control inside a cross-origin iframe.

**Do not bring the browser forward for this.** The person is usually working on this Mac. No `app activate`, no `window focus`, and no bare `--os` click (a bare `--os` click goes to whatever window is on top, which is the user's).

## Authorization first — read this

Only do this on **the user's own machine, their own signed-in session, to get past friction on a site they are legitimately using.** A real logged-in browser with normal reputation is *meant* to pass these — you are removing accidental friction, not breaking access control. Do **not** build or run anything that defeats CAPTCHAs at scale, farms tokens, rotates identities/proxies to evade rate limits, or targets sites the user has no standing on. If the gate is protecting someone else's resource or the intent is mass automation, stop and say so. When a human is at the keyboard, prefer asking them to click it — one human click from a trusted session clears instantly and is the honest path.

## Detect the gate

You have hit one of these when a page read comes back near-empty and any of:

- **URL** contains `/nocaptcha`, `/cdn-cgi/challenge`, `/recaptcha/`, `hcaptcha.com`, `challenges.cloudflare.com`, `/sorry/` (Google), or `?__cf_chl`.
- **Title** is "Just a moment…", "Human verification", "Attention Required", "Verifying you are human".
- An **iframe** exists with `title="reCAPTCHA"`, `title*="hCaptcha"`, or `src*="turnstile"` / `src*="challenges.cloudflare"`.

Quick probe from the browser surface (works when the host page's CSP allows the extension's eval bypass):

```bash
interceptor eval --main 'JSON.stringify([].map.call(document.querySelectorAll("iframe"),f=>({t:f.title,s:(f.src||"").slice(0,40)})))'
```

## Provider map (what you are up against)

| Provider | Visible control | After click |
|---|---|---|
| **reCAPTCHA v2** | "I'm not a robot" checkbox (anchor iframe) | Often passes on reputation; may pop a 3×3 image grid |
| **reCAPTCHA v3 / invisible** | nothing | Pure score — no click to make; a clean signed-in session usually passes. Reload, don't fight it |
| **Cloudflare Turnstile** | single checkbox (managed) | Usually a brief verify spinner; rarely interactive beyond the checkbox |
| **hCaptcha** | checkbox → image grid ("select all …") | Grid almost always appears |
| **Generic** | checkbox / "press & hold" button | Hold = `interceptor macos drag X,Y X,Y --app <browser> --window <id>` (start and end on the button) |

Invisible/score gates (v3, Turnstile managed-pass) have **no target to click** — a reload from the real session is the move, not a coordinate click.

## The technique: find the control, click it in the background

The gate tab must be the active tab of a window that is not minimized. If it is a hidden tab in a window the user is working in, do not switch to it there: run `interceptor window new` (it moves your tab group into its own background window), then `interceptor tab switch <id>` inside that window.

### 1. Prefer the framed ref

The browser surface reads into cross-origin iframes. The checkbox has a ref:

```bash
interceptor read --tab <id> --tree-only --include-frames
# frame 18343 (parent=0): https://www.google.com/recaptcha/api2/anchor?...
# [e18343_1] checkbox "I'm not a robot" role="checkbox"

interceptor click e18343_1 --trusted --tab <id>
# delivered in the background, focus unchanged: clicked at (61, 509) → pid=4321 window=7247
```

`--trusted` on a framed ref (`e<frame>_<n>`) places the click through the iframe's position in the page. The result line says whether it was delivered in the background. Needs a full install.

### 2. No ref: click by screen point, addressed to the window

For a control with no ref (an image-grid tile, a canvas widget), work out the screen point and address the click to the browser window by id.

```bash
# The window: match the tab title, read its windowId and frame {x, y, width, height}
interceptor macos windows --app "Brave Browser"

# The page's viewport height, and where the widget sits in the page
interceptor eval --tab <id> --main --no-reload 'JSON.stringify({innerHeight, r: document.querySelector("iframe[title=reCAPTCHA]").getBoundingClientRect()})'
```

For a point `(cx, cy)` in the page's viewport (CSS px, browser zoom 100%) and the window `frame` from `macos windows`:

```
screen_x = frame.x + cx
screen_y = frame.y + (frame.height - innerHeight) + cy
```

Take the frame from `macos windows`, not from the page. `screenX`, `screenY`, and `outerHeight` read wrong in a window that is not focused (measured: `outerHeight` 736 and `screenY` 2 for a window whose real frame was y 74, height 811).

Then:

```bash
interceptor macos click <screen_x>,<screen_y> --app "Brave Browser" --window <windowId>
# clicked at (61, 509) → pid=4321 window=7247
```

Always pass `--window`. Several browser windows often share one frame, and without it the click goes to the front one, which is usually the user's. A result that ends `(nothing was delivered)` means the window is minimized, hidden, or the id is wrong: nothing was clicked.

To find a point visually, capture the tab, not the app: `interceptor screenshot --tab <id> --pixel --save` works on an unfocused, covered window and its image maps 1:1 onto the viewport (`cx = px / imageWidth * innerWidth`). `interceptor macos screenshot --app` captures one window of the app, which may not be the gate's.

Verified in a fully covered Brave window with another app frontmost: the reCAPTCHA v2 checkbox issued its token with no image grid, hCaptcha reported verified, and a forced-interactive Turnstile widget issued its token.

## Image challenges: accuracy and speed

If a 3×3 grid appears ("Select all images with a **bus**"):

1. **Read the grid type.** "Click verify once there are none left" = **dynamic** (each correct tile fades and is replaced: re-capture after each click and keep solving until none remain). No such line = **static** (select all matching, then verify once).
2. **Identify accurately.** `interceptor screenshot --tab <id> --pixel --save`, crop the grid region, upscale about 2×, read it, list the matching tile centers.
3. **Map every target tile center and the VERIFY button** to screen points (step 2 above). `read --include-frames` often gives VERIFY a framed ref, which `click <ref> --trusted` can take.
4. **Solve fast. This is the part that fails.** Image challenges expire in about 1 to 2 minutes. Batch all tile clicks and VERIFY into one call (about 10 s end to end). A correct but slow solve returns "Verification challenge expired" even though every tile was right. For static grids, skip the intermediate confirmation screenshot.

```bash
# static grid: click matching tiles + VERIFY in one fast batch, all addressed to the gate window
W=75845
for xy in "589,513" "907,513" "748,673"; do interceptor macos click $xy --app "Brave Browser" --window $W; done
interceptor macos click 920,957 --app "Brave Browser" --window $W   # VERIFY
```

## Verify it cleared

```bash
interceptor read --tab <id> --tree-only --include-frames   # checkbox reads "You are verified" / the page moved on
interceptor screenshot --tab <id> --pixel --save            # when you need to see it
```

**Pass** = the URL leaves the challenge path (e.g. `/nocaptcha` → real content), the checkbox reads checked, or the response field has a token. **Expired** ("check the checkbox again") = you were too slow: re-trigger and solve faster. **New grid** = loop back to the image-challenge steps. If it keeps escalating after 2 or 3 honest, fast attempts, the session is flagged. Stop automating and hand the single click to the user.

## Pitfalls

- **Bringing the browser forward.** Not needed, and it interrupts the person using the Mac. If you find yourself reaching for `app activate` or a bare `--os` click, go back to step 1.
- **No `--window`.** The click lands on the app's front window at that point. Read the id from `macos windows` and pass it.
- **Wrong window id after a tab change.** The window's title is its active tab's title. Re-read `macos windows` after any `tab switch`.
- **Gate tab is not the active tab of its window.** A trusted click reaches only the tab that is showing. Move your group to its own window (`interceptor window new`) and switch there.
- **Browser zoom is not 100%.** `innerHeight` is then in zoomed CSS px and the point formula is off. Use the framed ref, or reset zoom on that tab.
- **`warning: the page reports hidden`.** Chrome pauses a fully covered window. If nothing changed, part of the window has to be uncovered. Ask the user before moving anything.
- **Slow solve expires.** The top cause of "I solved it correctly and it still failed." Compress to one batched action.
- **Fighting an invisible/score gate.** reCAPTCHA v3 and a Turnstile managed pass have nothing to click. Reload from the clean session instead.
- **Endless escalation.** If correct fast solves keep producing new grids, the session reputation is the problem, not your aim. Defer to a human click rather than looping.

## Output format

Report:
- Which provider/gate (detected from URL/title/iframe)
- The path used (framed ref or screen point), the window id, and the computed points
- For image grids: the challenge prompt, tiles selected, and end-to-end solve time
- The verification result (URL left the challenge path / green check / expired / new grid)
- Whether you cleared it or handed off to the user, and why
