# Extraction Craft — the interceptor verb cookbook (research mode)

Every verb here exists today (flag-level detail in `interceptor-browser`'s
`references/command-catalog.md`). Zero CDP — Interceptor reads the real signed-in
Chrome and captures request/response without a debugger banner.

| Need | Verb / idiom | Notes |
|---|---|---|
| Search the web | `interceptor websearch "<query>" --text-only` | Browser's configured default provider; managed background tab, never assumed to be Google |
| Load a source | `interceptor open "<url>" --text-only --full` | `--text-only` strips chrome; `--full` lifts the cap to 200K |
| Pull exact rows | `interceptor read --text-only --full \| awk '/Start/,/End/'` | Pricing/financial tables, timelines |
| Structure-preserving read | `interceptor read --markdown --text-only --full` | Headings/bold/lists/tables; tell answer from decoy |
| Precise extraction | `interceptor read --markdown --text-only --full \| rg -n -C 8 '<terms>'` | Token-efficient; the default extraction idiom |
| Find a page passage | `interceptor find "<text>" --text-only` | Scans complete rendered text; returns bounded snippets + truthful totals |
| Find one element | `interceptor find "<text>" --elements-only` / `--role <role>` | Actionable refs; cheaper than re-reading the tree |
| Grab the API payload | `interceptor inspect --net-only` / `interceptor net log --filter <host>` | Scrape the JSON the page already fetches |
| Capture XHR to disk | `interceptor net log --filter <host> --format json --out <path>` | Save the raw API response as a source |
| Infer infrastructure | `interceptor net headers --filter <host>` | Spot processors/CDNs from request hosts |
| Find one element fast | `interceptor find "<text>" --role <role>` | Semantic + text match |
| Scrape a JS app | `interceptor eval --main "(async()=>{…})()"` | Escape hatch when `read` returns nothing |
| Map before crawling | `interceptor eval --main "JSON.stringify([...document.querySelectorAll('a[href]')].map(a=>a.href))"` | Build the link graph, then fetch deliberately |
| Pull a binary (PDF) | `eval --main` `fetch(url,{headers:{Range:'bytes=0-32767'}})` → `btoa` → chunk | Download through the browser context |
| Probe before fetching | `eval --main` `fetch(url,{headers:{Range:'bytes=0-0'}})` → `content-length`/`type` | Avoid committing to a huge resource |
| Recover an empty read | `open … --no-wait` → `wait 3000` → `eval --main "document.body.innerText.slice(0,12000)"` | JS-late pages |
| Surface lazy UI | `eval --main` dispatch `MouseEvent('mouseenter')` → read `[role=tooltip]` | Tooltips/popovers in SPAs |
| Parallel fan-out | `interceptor tab new "<url>"` (×N) then `read --tab <id>` | Cover many sources at once |
| Isolate streams | `interceptor contexts` → `interceptor --context <id> open "<url>"` | Concurrent profiles (IDs are UUIDs) |
| Page communication | `interceptor net page-comm log [--type ws\|beacon\|broadcast]` | WebSocket/Beacon/BroadcastChannel, no CDP |
| Capture evidence | `interceptor screenshot --save` | Visual receipt for a claim |
| Last-resort fetch | `curl -A 'Mozilla/5.0' -L --max-time 20 '<url>' \| rg -n '<terms>'` | Graceful fallthrough when interceptor returns thin data |

## The mode-swap rule (do not waste reads)

`--text-only` and `--markdown` are mutually-exclusive variants of the *same* read.
Pick one. Use `--markdown` when structure disambiguates the answer (exact-text
task, table, emphasized-vs-plain copy); use flat `--text-only` for a single fact.
The preflight `open` already returns text + tree, so you often need zero extra reads.

## When `read` returns less than expected

`read` appends an explicit `... (truncated: showed X of Y chars …)` marker when it
caps. Look for it before assuming the data isn't there. Fix in one command:
`read e<ref> --text-only` (scope), `read --text-only --full` (widen to 200K), or
`find "<target>" --text-only` (bounded passage). Do **not** fetch `?action=raw` / `view-source:` — raw
markup is harder to parse than rendered text.
