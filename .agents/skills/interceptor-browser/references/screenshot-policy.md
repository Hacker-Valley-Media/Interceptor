# Browser Screenshot Policy

VLM-aware screenshot budgeting. Reference doc — load when you need to justify the agent-default recipe, override flags, or remember vendor ceilings.

## The agent-default recipe

```bash
interceptor screenshot --save --format webp --target-max-long-edge 1568 --quality 85
```

Produces a small WebP on disk (~50–100 KB for a typical full page) and a path-only response. Every flag is load-bearing.

## Auto-fallback and `--no-fallback`

When the default DOM render fails outright on a heavy page, a whole-page `screenshot` transparently retries via the pixel path and still returns an image. Two things an agent must know:

- The pixel retry **borrows tab focus and scrolls the page** (both restored afterward); the result's `fallback` note says so. Mid-interaction — while typing into a form, mid-drag, or watching a monitor stream — pass `--no-fallback` to forbid the retry and take the DOM-render error instead.
- Scoped captures (`--selector` / `--element` / `--ref` / `--region`) never fall back: the pixel path would crop against the wrong origin. They fail honestly.

## Token-cost reality

Screenshots are a **last-resort** read surface. Structured reads (`read`, `text`, `inspect`, `scene text`, `canvas log`, `macos tree`) cost roughly **10× fewer tokens per turn** than pixels, and they survive DOM churn far better. Use a screenshot only when pixels are genuinely the answer:
- Explicit visual evidence requested (the user said "show me a screenshot")
- Layout / color / chart issue that cannot be confirmed structurally
- Specific render artifact must be captured (a font glyph, a CSS bug, a hardware-rendered frame)

In editors, prefer `scene render` or `canvas read` before a page screenshot.

## Vendor auto-resize ceilings

Every major vision model auto-resizes oversized images before reading them. Pixels above the ceiling get downscaled by the API — you pay tokens for bytes the model discards.

| Vendor | Auto-resize ceiling | Use `--target-max-long-edge` |
|---|---|---|
| Anthropic Sonnet | 1568 px long edge | `1568` (the agent default) |
| Anthropic Opus | 2576 px long edge | `2576` |
| OpenAI GPT-4o / GPT-5 | Normalize to 2048-then-768 | `2048` (Opus-compatible upper bound) |

Pick the lowest ceiling your consumer supports. The default of `1568` covers Sonnet and is downscaled cleanly for Opus and OpenAI.

## WebP vs PNG

- **WebP at q=85** is roughly **5–8× smaller** than PNG with no measurable VLM accuracy loss.
- Default WebP quality is 85. PNG/JPEG default to 92.
- Choose PNG only for archival use cases (lossless evidence, regression baselines).

## Why `--save`

Without it, the screenshot bytes ride in the response inline as a base64 `dataUrl`. Even at WebP-q85 sizes, that inflates context. With `--save`:
- Bytes are written to disk in the CLI's CWD.
- The `dataUrl` field is **stripped** from the structured result.
- Stdout returns `{ filePath, format, size, width, height, mode }`.
- The path can be re-read on demand; the context window never bloats.

Use `--save` whenever you don't need to re-attach the image immediately.

## Full flag reference

- `--target-max-long-edge <px>` — clamp the rasterized canvas long edge to N pixels. Defaults to no clamp (legacy DPR behavior). Use `1568` for a safe Sonnet-aligned default; raise to `2576` for Opus or higher-fidelity. Applies to both DOM-render and `--pixel` paths.
- `--format webp` — re-encode at the SW boundary via OffscreenCanvas. ~5–8× smaller than PNG at q=85 with no measurable VLM accuracy loss. Falls back to PNG for archive use cases.
- `--quality <n>` — encoder quality. Defaults: WebP 85, PNG/JPEG 92.
- `--save` — write bytes to disk and strip `dataUrl` from the result.
- `--selector <css>` — capture a single matching element. Off-screen elements supported.
- `--element <ref>` — capture a refRegistry-tracked element (`e5`, `e2_7`).
- `--region X,Y,W,H` — capture an arbitrary page rectangle.
- `--scale <n>` — override pixel ratio. `--target-max-long-edge` wins when both are set.
- `--pixel` — pixel-true compositor capture via `chrome.tabs.captureVisibleTab`. Requires the browser window visible and focused. Use only when DOM-render fidelity is insufficient (compositor effects, hardware video frames, the browser chrome itself).
- `--pixel --full` — scroll-and-stitch full page. Throttled to clear Chrome's 2/sec `captureVisibleTab` quota; expect ~1.1s per viewport strip.

Default DOM-render works from a backgrounded Chrome on a different macOS Space — no focus required.

## Quick decision rules

- Need a single element? `--selector` or `--element <ref>` — much smaller than full page.
- Need a region? `--region X,Y,W,H` — same idea.
- Need pixel-true fidelity (CSS animation mid-frame, hardware video, the browser chrome)? `--pixel`.
- Need a full scrolling page in pixels? `--pixel --full` (slow — throttled).
- Just need to "see what's there"? The agent default. Don't override.

## See also

- `command-catalog.md` — full command surface
- `browser-and-network.md` — input layer priority and the `__interceptor_trust` marker
- `workflows/screenshot-for-vlm.md` — the task procedure that uses this policy
