# EscalatePage

A page came back empty or thin. **This is the moment most agents silently skip —
and that skip biases the whole corpus toward shallow sources.** Walk the
escalation chain until one rung yields. A page is "read" only when the chain is
exhausted; if it still fails, **log the skip explicitly** rather than letting
truncation look like coverage.

## The chain (run top to bottom, stop when one yields)

```bash
# 1. Loaded but empty? Let JS settle, then re-read full.
interceptor wait-stable
interceptor read --text-only --full

# 2. Structure matters (table, emphasized text, decoy-prone page)?
interceptor read --markdown --text-only --full

# 3. Know the target string? Jump to it instead of scanning.
interceptor find "<text>"

# 4. Data comes from an XHR, not the HTML? Read the API the page already calls.
interceptor inspect --net-only
interceptor net log --filter <host-or-path>

# 5. State lives only in JS? Escape hatch.
interceptor eval --main "document.body.innerText.slice(0, 12000)"
interceptor eval --main "window.__APP_STATE__"

# 6. Visual-only (canvas, image, chart)? Capture and read with vision.
interceptor screenshot --save
```

## Recover a late-rendering page

```bash
interceptor open "<url>" --no-wait
interceptor wait 3000
interceptor eval --main "document.body.innerText.slice(0, 12000)"
```

## The page is fighting you (blocked / paywalled / anti-bot)

Use the fallback ladder (`references/source-playbooks.md`):

```
www.reddit.com thin   -> old.reddit.com (+ /top/?t=year)
search blocked        -> duckduckgo.com/html/?q=  -> bing.com/search?q=
page dead/changed     -> web.archive.org (snapshot index, then a dated snapshot)
HF model card         -> /raw/main/README.md
rendered HTML noisy   -> the .json endpoint the page calls (net log)
long standards doc    -> alternate URL forms (e.g. ITU SUM-HTM / TOC-HTM)
last resort           -> curl -A 'Mozilla/5.0' -L --max-time 20 '<url>' | rg -n '<terms>'
```

A human-verification gate (e.g. Stack Overflow `/nocaptcha`) can stop a scrape
cold. A real signed-in session clears it; **speed matters** — image challenges
expire in ~1–2 minutes. Prefer letting a present human click; automate only the
user's own authorized session.

## When the chain is exhausted

If nothing yields, do **not** pretend the source was covered. Record it:

```bash
interceptor research note "[UNVERIFIED] could not extract <url> — escalation chain exhausted (JS/anti-bot)"
```

A logged skip is a known gap. A silent skip is a lie in the final report.
