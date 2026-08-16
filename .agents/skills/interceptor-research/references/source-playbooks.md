# Source Playbooks & the Seven Human Lenses

Where to go, in priority order — and the cross-discipline moves the deepest
researchers use. The deepest researchers aren't labs; they're people whose
livelihood or loved ones depend on not stopping at page one.

## Where to go (priority order)

| Surface | Use it for | Depth move |
|---|---|---|
| **Configured default provider** (`interceptor websearch`) | Broad discovery, leaked docs, primary sources | Query operators → open top 10–30 → pivot on names/files; do not assume Google |
| **Reddit** (`old.reddit`, top/year) | Practitioner tactics, failure stories, tool chains | Read comments; follow linked repos |
| **arXiv** (advanced + date_range) | Academic frontier, methods, benchmarks | Title-scope → abstract → citation-graph pivot |
| **GitHub** (qualifier search) | Working tooling, reference implementations | `stars:>` + `pushed:>` → README → verify via API |
| **Stack Overflow** (tag + score) | Extraction/automation craft, edge cases | Find the API/XHR behind the page |
| **Wayback / archive.today** | Deleted/changed pages | Compare snapshots across dates |
| **Citation graphs** (Connected Papers, Litmaps, Semantic Scholar, ResearchRabbit) | Following an idea forward & backward | Snowball from one seed paper |
| **Primary registries** (SEC EDGAR, gov data, standards bodies, official stats) | Authoritative facts | Quote the filing/standard, not an aggregator |

## The fallback ladder (a blocked page is not the end)

```
provider blocked      -> open an alternate provider URL only when the research plan explicitly chooses it
www.reddit.com thin   -> old.reddit.com (+ /top/?t=year, restrict_sr=on)
page dead/changed     -> web.archive.org (snapshot index, then a dated snapshot)
huggingface card      -> /raw/main/README.md
rendered HTML noisy   -> the .json endpoint the page calls (net log)
long standards doc    -> alternate URL forms (e.g. ITU SUM-HTM / TOC-HTM)
last resort           -> curl -A 'Mozilla/5.0' -L --max-time 20 '<url>' | rg -n '<terms>'
```

## The seven human lenses

Each discipline contributes a transferable move.

1. **Academic / research librarian — citation chaining.** Snowball: find one
   strong source, chase its references backward and its citations forward. Beware
   ghost references — verify every cited work exists.
2. **Intelligence analyst / FBI — Analysis of Competing Hypotheses.** List all
   hypotheses, evaluate evidence against all of them; disconfirming > confirming.
   Companion: Key Assumptions Check, red-team.
3. **Private investigator — skip tracing & record layering.** Layer public records
   and pivot between them (property → court → business filings). A dead end means
   **change record system**, not stop. Obituary/death checks close dead ends.
4. **Hacker / OSINT operator — the reuse pivot & metadata mining.** One handle
   often reappears across platforms. Metadata is gold (PDF author, EXIF, WHOIS,
   DNS). Free tools *chained* beat one paid platform.
5. **Competitive-intelligence operative — read the tells.** Don't just read what a
   company *says* — read what its *behavior* reveals: job posts → roadmap, pricing
   diffs → strategy, review sites → weaknesses, headcount → investment.
6. **Corporate-intelligence analyst — structured rigor at scale.** Rigor is a
   *process artifact* (a documented assumptions list, a competing-hypotheses
   table), not a feeling of confidence.
7. **Missing-persons searcher — relentlessness & every detail.** Don't stop at
   three links. Exhaust every free resource; re-examine old evidence with fresh
   eyes; every detail in every artifact is a potential lead. Before stopping, ask:
   "what resource have I *not* tried, and what detail have I *not* extracted?"

## Ethics

OSINT relentlessness is a method bounded by consent and law. Stay on public
sources; do not pursue private individuals without legitimate cause. If there is
immediate risk of harm, the research action is escalation to the appropriate
authorities, not more searching.
