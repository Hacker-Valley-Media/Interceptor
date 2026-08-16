# DeepResearchSweep

You are running a full deep-research sweep on a topic — not a lookup. The goal is
breadth + verification: many primary sources, every load-bearing claim
triangulated, a durable cited artifact at the end. Run this as a **loop**, not a
line — re-enter PLAN whenever a pivot opens a new branch.

## Floor (the anti-laziness contract)

Pick an effort and commit to its source floor. Do not stop short of it.

| Effort | Source floor | Use for |
|---|---|---|
| quick | 8 | a focused question, one afternoon |
| standard | 20 | a real research question that matters (default) |
| exhaustive | 40+ | due diligence, a decision you'll defend |

## Steps

1. **PLAN — decompose before searching.**
   - Write 5–10 sub-questions. Each earns ≥1 source.
   - Pre-commit the source *type* per sub-question (primary doc / paper / repo /
     practitioner thread / public record). See `references/operating-loop.md`.

2. **Stand up the ledger** (collect-before-synthesize):
   ```bash
   interceptor research init <slug> --effort standard
   ```
   See `workflows/build-source-ledger.md` for the filing discipline.

3. **COLLECT — per sub-question, find then open the primary source.**
   - Query like a database, not a search box (`references/query-craft.md`): use
     `site:`, `filetype:pdf`, exact `"phrases"`, `OR`, date windows.
   - Use `interceptor websearch "<query>"` to *locate* the authoritative source through the browser's configured default provider, then `open` the primary
     doc (registry / filing / standard / vendor doc / paper) and read *that*.
   - For each source: open → escalate if thin (`workflows/escalate-page.md`) →
     save to `sources/NN-<slug>.md` → `interceptor research add <url> --note "…"`
     → `interceptor research note "<insight>"`. **No report writing yet.**

4. **PIVOT — chase every promising lead 2–3 hops** (`workflows/pivot-chase.md`).
   Each name/file/date/handle/citation is the next search.

5. **DEPTH-CHECK — measure against the rubric.**
   ```bash
   interceptor research status <slug>
   ```
   If the verdict says KEEP DIGGING, expand with a **specific** instruction
   ("10 new sources from domains not yet in the ledger"), not a vague "go deeper."
   See `workflows/saturation-check.md`.

6. **VERIFY — attribute, then attack** (`workflows/verify-and-attribute.md`).
   Attribute every claim to a saved file; run the claim audit and ACH on the
   central conclusions; tag confidence `[HIGH]/[MED]/[LOW]/[CONFLICT]`.

7. **WRITE — last.** Map findings back to the original sub-questions, every fact
   dated + attributed + confidence-tagged. Run a coverage critic: what source
   type / counter-view / search angle is still missing? What it finds is the
   next collection round.

## Stopping rule

Stop expanding a branch when **two consecutive rounds from fresh angles/new
domains surface nothing new** (saturation), the source floor is met, every
load-bearing claim is triangulated ≥3× (or tagged single-sourced), and the
coverage critic finds no obvious gap. `interceptor research status` reports the
saturation state for you.

## Anti-patterns

Stopping at 3 sources · reading only what extracts easily (silent skips) ·
synthesizing while collecting · vague "go deeper" · Boolean worship · circular
sourcing (N blogs citing one original = one source) · trusting unverified
repos/links. See `references/verification.md`.
