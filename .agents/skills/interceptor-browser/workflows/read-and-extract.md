# ReadAndExtract

You are extracting structured information from a webpage — a fact, a value, a list, the contents of a table. This is the workflow when the answer lives in the DOM, an XHR response, or rendered text, and you need to return it as data the user (or another tool) can use.

## Command Budget

This workflow should complete in **3 commands**, max **4**:
1. `interceptor open <url>` → 1 command (preflight; returns tree + flat text by default)
2. Narrow read **(only if step 1 output was insufficient)** — pick ONE of: `read --text-only`, `read --markdown --text-only`, or `read --tree-only --tree-format compact`. **Never run two content surfaces.** → 1 command
3. (Optional) `read <ref>` for a sub-element OR `find "<text>"` if the first read missed → 1 command

If you're at command 4 and don't have the value, **commit with what's there** — answer with the closest evidence and flag the gap. Do not add a 5th read.

**Mode-swap rule:** if step 2 needs structure (exact-text task, table, decoy-prone page), use `--markdown --text-only` *instead of* plain `--text-only`. Do not run both — they read the same content with different rendering.

## Decision tree

1. **Is the answer in plain page text?** → use `read --text-only` first, smallest surface.
2. **Does it need a passage or specific element?** → use `find "<text>" --text-only` for a passage, `find "<text>" --elements-only`/`--role` for a control, or `read e<ref>` on a known ref.
3. **Does it live in a sub-tree?** → use `read e<ref>` to scope.
4. **Is it inside an iframe?** → use `read --include-frames`, refs like `e2_7`.
5. **Is it client-side state hidden from DOM?** → use `inspect` (combined tree + network) or `state` for SPA state.
6. **Does it come from an API call?** → use `net log --filter <pattern>` or `inspect --net-only`.
7. **None of the above?** → use `eval --main "expression"` as the escape hatch.

## Steps

1. **Land on the page.**
   ```bash
   interceptor open <url>
   ```

2. **Pick the narrowest read surface — ONE content-read command.**
   ```bash
   interceptor read --text-only                          # Default: flat prose (cheapest)
   interceptor read --markdown --text-only               # SWAP for above when structure matters
   interceptor read --tree-only --tree-format compact    # Actionable refs only (no content)
   interceptor read e12 --tree-only --tree-format compact # Scoped sub-tree
   interceptor text e12                                  # Text of one element
   interceptor text e12 --markdown                       # Element text rendered as markdown
   interceptor html e12                                  # HTML of one element (last resort)
   ```
   **Strict rule: pick exactly one content surface per task.** `--text-only` and `--markdown` are mutually exclusive variants of the *same* read — running both wastes your 8-command budget. The preflight `open` already returns text + tree, so you typically need ZERO additional reads.

   **Use `--markdown` INSTEAD of `--text-only` when:**
   - The task says "report the exact X" / "the summary text" / "the exact phrasing" — visual hierarchy is the disambiguator.
   - The page has obviously emphasized text (bold headings, callouts) adjacent to plain explanatory copy that could be mistaken for the answer.
   - You need a clean table render (markdown pipe tables beat scraped prose).

   **Do NOT use `--markdown` when:**
   - The fact you need is a single value (date, name, number) that appears once on the page — flat text is faster and the markup adds noise.
   - You already ran `--text-only` (or the preflight ran `open --text-only`) and got the answer. Don't re-read the same content in a different mode.

3. **For a known passage or element, prefer `find` over returning the full page/tree.**
   ```bash
   interceptor find "termination for convenience" --text-only
   interceptor find "Submit" --elements-only
   interceptor find "Email" --role textbox
   ```
   Plain `find` returns both bounded rendered-text snippets and accessible element refs. It scans beyond `read`'s normal 8K emitted-text cap without returning the entire page, and it never navigates or mutates.

## When `read` returns less than you expected

If `read --text-only` came back short and your target string wasn't in it, the read **was truncated** — the page text is longer than the cap. `read` always appends an explicit `... (truncated: showed X of Y chars ...)` marker when it caps. Look for that marker before assuming the data isn't there.

Fix in one command:

- **`read e<ref> --text-only`** to scope to a known section (cheapest)
- **`read --text-only --full`** to widen to 200,000 chars (mid-cost)
- **`find "<target>" --text-only`** for a bounded passage, or **`--elements-only`** for a control ref

**Do NOT fetch `?action=raw`, `view-source:`, or any markup-level URL.** Raw wikitext / HTML source is harder to parse than rendered text. The agent's job is to read the page, not its source.

4. **For data behind XHRs**, use passive network capture before reaching for CDP.
   ```bash
   interceptor net log --filter graphql --limit 10
   interceptor net headers --filter api
   interceptor inspect --net-only
   ```

5. **For SPAs that hide state in JS**:
   ```bash
   interceptor state                            # Common framework probes
   interceptor eval --main "window.__APP_STATE__"  # Targeted page-world read
   ```

6. **Pages with iframes** (auth widgets, embedded docs, payment frames):
   ```bash
   interceptor read --include-frames
   interceptor find "target" --include-frames
   interceptor act e2_7                         # Framed ref directly
   ```

## When to escape to `eval --main`

Only when no built-in surface exposes what you need. Examples that justify it:
- Reading a specific deeply-nested object on `window`
- Calling a page function (e.g. `window.dataLayer.push`)
- Reading ad hoc page state that is not exposed through DOM, network, scene, or
  page-communication capture

On strict-CSP sites, the first `eval --main` may trigger an automatic reload/retry path. Expect that on the first attempt against a CSP-locked page.

## Output format

Return the extracted value cleanly:
- **Single value:** Quote it verbatim. No prose padding.
- **List:** Bulleted, exact strings, in source order.
- **Table:** Markdown table preserving columns from the source.
- **Network response:** The exact JSON path you read from (e.g. `data.users[0].id`) plus the value.

If the value is missing or empty, say "not found" with the exact selector or filter that returned nothing. Do not invent a default.
