# ScreenshotForVlm

You are taking a screenshot of a webpage for a vision-language model (VLM) to read. Use this when pixels are genuinely the answer — visual layout, color, a chart artifact, a rendered glyph — and no structured read (`read`, `text`, `inspect`, `scene text`, `canvas log`, `macos tree`) can produce the same information.

**Screenshots are a last-resort read surface.** Structured reads cost roughly 10× fewer tokens per turn and survive DOM churn better than pixels. Try every other read first.

## Command Budget

**1 command.** That's it. The agent-default recipe below IS the budget:

```bash
interceptor screenshot --save --format webp --target-max-long-edge 1568 --quality 85
```

If the first screenshot doesn't answer the question, do NOT take a second exploratory screenshot — re-evaluate whether pixels are actually the answer. The "exploratory screenshot then second screenshot" pattern is the failure mode this budget exists to prevent. If you need a second capture, scope it tightly with `--selector`, `--element <ref>`, or `--region X,Y,W,H` — and that's still 1 command, not a re-take.

## The agent-default recipe

```bash
interceptor screenshot --save --format webp --target-max-long-edge 1568 --quality 85
```

This writes a small WebP to disk (~50–100 KB for a typical full page) and returns a path-only structured result. No inline base64 in the stdout. Every flag is load-bearing.

### Why these flags

- `--save` — writes bytes to disk in the CLI's CWD and **strips `dataUrl` from the result**. Without it the WebP rides the response inline. The path can be re-read on demand and never bloats your context window.
- `--format webp` — re-encodes at the SW boundary via OffscreenCanvas. ~5–8× smaller than PNG at q=85 with no measurable VLM accuracy loss. Default WebP quality is 85; PNG/JPEG default to 92.
- `--target-max-long-edge 1568` — clamps the rasterized canvas long edge to 1568 px, Anthropic Sonnet's auto-resize ceiling. Pixels above that ceiling get downscaled by the API anyway — you pay tokens for bytes the model would discard. Vendor ceilings:
  - **Sonnet** — 1568 px
  - **Opus** — 2576 px
  - **OpenAI** — normalizes to 2048-then-768
- `--quality 85` — WebP quality. Empirically no measurable VLM accuracy loss vs PNG.

## When to override the default

- `--target-max-long-edge 2576` — Opus or higher-fidelity consumer.
- `--selector <css>` — capture a single matching element. Off-screen elements supported.
- `--element <ref>` — capture a refRegistry-tracked element (`e5`, `e2_7`).
- `--region X,Y,W,H` — capture an arbitrary page rectangle.
- `--scale <n>` — override pixel ratio. `--target-max-long-edge` wins when both are set.
- `--pixel` — pixel-true compositor capture via `chrome.tabs.captureVisibleTab`. The browser does not need to be the focused app and the window does not need focus: the capture switches the window's active tab to the target and back by itself, and it worked on an unfocused, fully covered Brave window. Do not `tab switch` or `window focus` for it. To keep even that brief tab borrow out of the user's window, put the page in your own window first (`interceptor window new <url>`). Use `--pixel` only when DOM-render fidelity is insufficient (compositor effects, hardware video frames, canvas apps).
- `--pixel --full` — scroll-and-stitch full page. Throttled to clear Chrome's 2/sec `captureVisibleTab` quota; expect ~1.1s per viewport strip.

Default DOM-render works from a backgrounded Chrome on a different macOS Space — no focus required.

## Before you reach for a screenshot

Try these first:

- `interceptor read --text-only` — prose only, cheapest read.
- `interceptor read --tree-only` — actionable refs.
- `interceptor inspect` — tree + text + passive network.
- `interceptor scene text <ref>` — text inside a rich editor.
- `interceptor canvas log <n>` — observer log of canvas draw calls.
- `interceptor macos tree --app "X"` — when the target is outside the page.

If any of those returns the answer, you do not need pixels.

## Output format

Report:
- The path written (e.g. `./screenshot-1736.webp`)
- Dimensions and on-disk size
- What you saw in the image (the actual visual finding, not a description of "the page rendered")
- Whether the pixel evidence answered the question, or whether you still need another read
