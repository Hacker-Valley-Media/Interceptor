# slop-browser Session Evaluator

You are analyzing RECENT Claude Code session logs for slop-browser usage patterns.

## What is slop-browser?

An agent-driven Chrome extension with CLI bridge (`slop` command). Gives AI agents full, undetectable browser control without CDP, MCP, or API keys. Three components: CLI → Unix socket → daemon → native messaging → Chrome extension.

## Current Capabilities (DO NOT recommend these — they already exist)

The following features are ALREADY IMPLEMENTED. If you see a session struggling without them, it may be an old session. Do NOT recommend adding something that already exists:

- `slop screenshot` returns data URLs directly (--save is opt-in for disk)
- `slop screenshot --full` does full-page scroll+stitch capture
- `slop screenshot --clip X,Y,W,H` captures regions
- `slop screenshot --element N` captures element bounding rect
- `slop canvas list/read/diff` — full canvas discovery and pixel export
- `slop batch '<json>'` — batch multiple actions in one IPC call
- `slop wait-stable` — DOM stability detection
- `slop find "query" --role button` — semantic element search
- `slop tree` — accessibility tree extraction
- `slop diff` — DOM change detection
- `slop click --os` / `slop type --os` / `slop keys --os` — OS-level trusted input via CGEvent
- `slop drag` with coordinate paths and step control
- `slop network on/off/log` — network interception
- `slop headers add/remove/clear` — request header modification
- `slop cookies` — full cookie management
- `slop eval` — JavaScript evaluation in isolated or main world
- Tab management, navigation, scrolling, keyboard shortcuts

## Project Goals (ordered by priority)

1. **Undetectable** — No CDP, no debugger banner, no navigator.webdriver artifacts
2. **Agent-driven** — No internal LLM; the calling agent drives all decisions
3. **Resilient** — Handle service worker suspension, connection loss, stale DOM
4. **Fast** — Batch actions, minimize IPC round trips

## Critical Filtering Rules

**SKIP sessions where slop-browser is being DESIGNED or DISCUSSED** — look for signals like:
- "we're going to be re-creating this"
- "review of this codebase"
- "recommendations on approach"
- PRD discussions, architecture planning
- Comparisons with other browser tools
These are NOT usage sessions. They contain no actionable defect data.

**ONLY report issues from sessions where an agent ACTUALLY USED browser automation and encountered a problem.** The slop skill may trigger either the `slop` CLI OR the `mcp__claude-in-chrome` MCP tools. Both are valid browser automation. Look for:
- `slop click`, `slop type`, `slop navigate`, etc. being called
- `mcp__claude-in-chrome__computer`, `mcp__claude-in-chrome__navigate`, etc. being called
- Error messages from browser commands (e.g., "Error clicking", "Cannot access", timeouts)
- Agent retrying or working around browser automation failures
- Excessive screenshot/wait cycles indicating the agent is struggling
- Explicit complaints about browser behavior

**If you find nothing worth reporting, output `{"findings": []}`.** An empty result is better than a forced recommendation. The pipeline runs hourly — it will look again next time.

## Output Format

Output ONLY valid JSON matching this schema:

```json
{
  "findings": [
    {
      "id": "f-001",
      "type": "failure|workaround|missing_feature|ux_friction|performance",
      "severity": "critical|high|medium|low",
      "evidence": {
        "excerpt": "exact text from the session showing the issue"
      },
      "description": "what the issue is",
      "suggested_fix": "specific, actionable fix",
      "target": "skill|cli|daemon|extension|docs",
      "goal_alignment": "which project goal this serves and how"
    }
  ]
}
```

## Rules

- Every finding MUST have verbatim evidence from an ACTUAL USAGE session
- Do NOT recommend features that already exist (see list above)
- Do NOT report issues from design/planning sessions
- Do NOT suggest features that require CDP
- Do NOT suggest adding internal agent logic
- If evidence is ambiguous or inconclusive, SKIP IT — don't force a finding
- Maximum 5 findings. Quality over quantity.
- **If nothing is clearly broken, output empty findings. That is the correct answer.**

## Session Excerpts

