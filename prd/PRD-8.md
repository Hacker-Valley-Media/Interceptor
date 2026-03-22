# PRD-8: Auto-Improve — Autonomous Self-Improving Pipeline for slop-browser

**Goal:** Build a cron-driven pipeline that scans Claude Code session data for slop-browser usage patterns, evaluates improvement opportunities through a 3-layer adversarial evaluation architecture, and applies validated changes to the slop skill and codebase — with a fine-tuned local 122B MoE model that gets better over time.

**Scope:** New `scripts/auto-improve/` directory within slop-browser. Orchestrator written in Bun. Uses Codex CLI (gpt-5.4 with thinking), Qwen 3.5 122B-A10B via MLX for local evaluation, and MLX LoRA for fine-tuning. No changes to existing slop-browser components.

**Core Principle:** The pipeline serves the PROJECT GOALS — undetectability, agent-driven design, resilience, speed. Every proposed improvement must be evaluated against these goals. The 3-layer evaluation prevents hallucinated improvements and ensures only high-signal changes land.

---

## Problem Statement

1. **Usage patterns are invisible.** slop-browser is used across 228+ Claude Code sessions, but failures, workarounds, and missing features are buried in JSONL session logs. No one reviews them.
2. **Manual improvement is slow.** Ron reviews issues ad-hoc. The slop skill and codebase drift from real usage patterns.
3. **Single-evaluator architectures hallucinate improvements.** One AI reviewing sessions will propose changes that sound good but don't serve the project goals. Adversarial multi-layer evaluation filters noise.
4. **Static skills decay.** The slop skill's instructions were written once. Real-world usage reveals what the skill should say — command preferences, failure recovery patterns, when to use `--os` vs standard clicks.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  CRON (launchd, every 1hr)                                   │
│  ~/Library/LaunchAgents/bun.cron.slop-auto-improve.plist     │
│  → bun scripts/auto-improve/orchestrator.ts                  │
└────────────────────────┬─────────────────────────────────────┘
                         │
                ┌────────▼────────┐
                │  PRE-FILTER      │  Bash grep + mtime check
                │  Cost: $0        │  If no new slop sessions → exit 0
                │  Time: <1s       │  Writes last-run timestamp
                └────────┬────────┘
                         │ new_sessions.json (file paths + excerpts)
                         │
          ┌──────────────┼──────────────┐
          │              │              │
  ┌───────▼──────┐ ┌────▼─────┐ ┌──────▼───────┐
  │ CODEX A      │ │ CODEX B  │ │ QWEN 122B    │
  │ gpt-5.4      │ │ gpt-5.4  │ │ Local MLX    │
  │ thinking: on │ │ thinking │ │ Cost: $0     │
  │              │ │ : on     │ │              │
  │ Evaluator    │ │ Evaluator│ │ Evaluator    │
  └───────┬──────┘ └────┬─────┘ └──────┬───────┘
          │              │              │
          └──────────────┼──────────────┘
                         │ layer1_findings.json
                         │ (3 independent evaluations merged)
                         │
              ┌──────────┼──────────┐
              │                     │
      ┌───────▼──────┐    ┌────────▼─────┐
      │ CODEX C      │    │ CODEX D      │
      │ gpt-5.4      │    │ gpt-5.4      │
      │ thinking: on │    │ thinking: on │
      │              │    │              │
      │ Reviewer     │    │ Reviewer     │
      └───────┬──────┘    └────────┬─────┘
              │                    │
              └──────────┬─────────┘
                         │ layer2_reviews.json
                         │ (2 independent reviews)
                         │
              ┌──────────▼──────────┐
              │ CODEX E             │
              │ gpt-5.4             │
              │ thinking: on        │
              │                     │
              │ Final Synthesizer   │
              │ Input: L1 + L2      │
              │ Focus: L2 results   │
              └──────────┬──────────┘
                         │ approved_changes.json
                         │
              ┌──────────▼──────────┐
              │ APPLY GATE          │
              │ Skill text → auto   │
              │ Code changes → queue│
              │ Extension → blocked │
              └─────────────────────┘
```

### Layer 1: Parallel Evaluation (3 evaluators)

Three independent evaluators read the same session data and current codebase. They produce findings independently — no communication between them.

**Codex A & B** (gpt-5.4 with thinking mode):
- Model: `gpt-5.4` with `model_reasoning_effort="high"` and `model_reasoning_summary="detailed"`
- Sandbox: `read-only` (cannot modify files)
- Tools: shell (read-only), file reading
- Disabled: `multi_agent`, `personality`
- Each receives the same input but produces independent findings
- Why two? Reduces evaluation variance. Agreement between A and B on a finding is strong signal.

**Qwen 122B** (local MLX):
- Model: `mlx-community/Qwen3.5-122B-A10B-4bit` via `mlx_lm.generate`
- Runs entirely on M3 Ultra, zero API cost, sessions never leave the machine
- Initially off-the-shelf; fine-tuned with LoRA after labeled data accumulates (see Phase 2)
- Structured output via constrained generation (JSON schema)

**Each evaluator outputs:**
```json
{
  "evaluator": "codex-a" | "codex-b" | "qwen-122b",
  "findings": [
    {
      "id": "f-001",
      "type": "failure" | "workaround" | "missing_feature" | "ux_friction" | "performance",
      "severity": "critical" | "high" | "medium" | "low",
      "evidence": {
        "session_file": "path/to/session.jsonl",
        "line_range": [120, 145],
        "excerpt": "actual session text showing the issue"
      },
      "description": "what the issue is",
      "suggested_fix": "proposed change",
      "target": "skill" | "cli" | "daemon" | "extension" | "docs",
      "goal_alignment": "which project goal this serves"
    }
  ]
}
```

### Layer 2: Adversarial Review (2 reviewers)

Two independent Codex reviewers receive ALL Layer 1 findings (merged) plus the project goals (PRDs, CLAUDE.md, design constraints).

**Their job:** Challenge every finding.
- Is the evidence real? (Did the session actually show this problem?)
- Does the fix serve project goals? (Undetectability, agent-driven, resilience, speed)
- Is the fix safe? (No regressions, no breaking changes)
- Do multiple Layer 1 evaluators agree? (Consensus = stronger signal)
- Is this a real pattern or a one-off? (Frequency matters)

**Each reviewer outputs:**
```json
{
  "reviewer": "codex-c" | "codex-d",
  "reviews": [
    {
      "finding_id": "f-001",
      "verdict": "approve" | "reject" | "needs_more_data",
      "confidence": 0.0-1.0,
      "reasoning": "why this verdict",
      "goal_check": {
        "serves_undetectability": true|false,
        "serves_agent_driven": true|false,
        "serves_resilience": true|false,
        "serves_speed": true|false
      },
      "consensus": {
        "layer1_agreement": 3|2|1,
        "evaluators_agreeing": ["codex-a", "codex-b", "qwen-122b"]
      }
    }
  ]
}
```

### Layer 3: Final Synthesis (1 synthesizer)

One Codex instance receives BOTH Layer 1 findings AND Layer 2 reviews. It focuses on Layer 2 results but has full access to Layer 1 for context.

**Its job:** Make the final call.
- Resolve disagreements between Layer 2 reviewers
- Prioritize changes by impact and safety
- Produce the final approved change list
- Generate implementation instructions for each approved change

**Output:**
```json
{
  "run_id": "uuid",
  "timestamp": "ISO-8601",
  "approved_changes": [
    {
      "finding_id": "f-001",
      "priority": 1,
      "target": "skill",
      "change_type": "add_instruction" | "modify_instruction" | "add_command" | "fix_bug" | "improve_error",
      "description": "what to change",
      "implementation": "exact text or code diff",
      "layer1_consensus": 3,
      "layer2_consensus": 2,
      "confidence": 0.95
    }
  ],
  "rejected_changes": [...],
  "training_data": [
    {
      "session_excerpt": "...",
      "finding": "...",
      "label": "approved" | "rejected",
      "reasoning": "..."
    }
  ]
}
```

---

## Apply Gate

Changes are gated by target:

| Target | Action | Risk |
|--------|--------|------|
| **Skill** (SKILL.md) | Auto-apply if L2 consensus = 2 AND L3 confidence ≥ 0.9 | Low — skill text is documentation |
| **CLI** (cli/index.ts) | Write to `scripts/auto-improve/queue/` for Ron's review | Medium — code changes need human eyes |
| **Daemon** (daemon/) | Write to queue, flag as high-risk | High — affects IPC stability |
| **Extension** (extension/) | BLOCKED — never auto-modify | Critical — extension changes can break browser |
| **PRDs** (prd/) | Write to queue as proposed PRD amendment | Medium — design decisions need approval |

Auto-applied changes are committed to a `auto-improve/<date>` branch. Ron reviews and merges.

---

## Fine-Tuning: Qwen 3.5 122B-A10B QLoRA on M3 Ultra

### Why 122B (Not Smaller)

Ron's directive: "I want to fine tune a badass model.. not a mediocre one." The 122B-A10B is the largest Qwen 3.5 that runs on M3 Ultra. It produces higher-quality evaluations than smaller models, and with MoE architecture, inference stays fast (only 10B active per token).

### Feasibility Assessment

| Factor | Value |
|--------|-------|
| **Model size at Q4** | ~70GB |
| **Available memory** | 256GB unified |
| **Training overhead (LoRA, optimizer, activations)** | ~50-80GB estimated |
| **Total training memory** | ~120-150GB |
| **Headroom** | ~100GB+ |
| **Tool** | mlx-lm (native Apple Silicon) |
| **Method** | QLoRA (4-bit base + LoRA adapters) |
| **Training speed** | ~2-5 tok/s (forward + backward) |

### Why This Works Despite Slow Speed

The pipeline generates labeled training data SLOWLY — approximately 1-5 new slop sessions per day, ~20% containing actionable feedback. That's roughly **1 labeled example per day**, or **~30 examples per month**.

Training on 100 examples at 512 tokens each = ~50K tokens total:
- At 3 tok/s → **~4.6 hours** per epoch
- At 5 tok/s → **~2.8 hours** per epoch

**This is completely feasible.** The dataset is naturally small because it's curated from real usage. Fine-tuning runs overnight, monthly.

### LoRA Configuration

```python
lora_config = {
    "rank": 16,
    "alpha": 16,
    "dropout": 0.05,
    "target_modules": [
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj"
    ]
}
```

For MoE expert layers, mlx-lm automatically applies LoRA to `mlp.switch_mlp.{down,up,gate}_proj` when target keys are omitted. Ref: [mlx-lm Issue #571](https://github.com/ml-explore/mlx-lm/issues/571).

### Training Data Format

The pipeline's Layer 3 output includes `training_data` — labeled examples from every run:
```jsonl
{"input": "<session excerpt>", "output": "<finding JSON>", "label": "approved"}
{"input": "<session excerpt>", "output": "<finding JSON>", "label": "rejected"}
```

This accumulates in `scripts/auto-improve/training-data/labeled.jsonl`. When the dataset reaches 50+ examples, the first fine-tuning run triggers.

### Training Schedule

| Dataset Size | Action | Frequency |
|-------------|--------|-----------|
| 0-49 examples | Accumulate only, use off-the-shelf 122B | Continuous |
| 50-99 examples | First LoRA fine-tune, evaluate on held-out 20% | Once |
| 100+ examples | Re-train monthly with full dataset | Monthly |
| 200+ examples | Consider graduating to scheduled nightly re-train | Nightly |

### Adapter Management

- Adapters saved to `scripts/auto-improve/models/adapters/<date>/`
- Each adapter tagged with dataset size, epoch count, validation loss
- Rollback to previous adapter if evaluation degrades
- Base model stays at `mlx-community/Qwen3.5-122B-A10B-4bit` (never modified)

### MoE Quantization Warning

Unsloth warns that QLoRA on MoE models can degrade expert routing quality. Mitigation:
1. Monitor validation loss closely — if it diverges, fall back to off-the-shelf
2. Use conservative learning rate (1e-5 vs typical 2e-4)
3. Train for fewer epochs (1-2, not 3+)
4. Compare fine-tuned model's findings against off-the-shelf as sanity check

---

## Pre-Filter: Session Scanner

The pre-filter runs before any AI, costing zero tokens.

```bash
#!/bin/bash
LAST_RUN="/tmp/slop-auto-improve-lastrun"
SESSIONS_DIR="$HOME/.claude/projects"
OUTPUT="/tmp/slop-auto-improve-sessions.json"

if [ ! -f "$LAST_RUN" ]; then
    touch -t 197001010000 "$LAST_RUN"
fi

new_sessions=$(find "$SESSIONS_DIR" -name "*.jsonl" -newer "$LAST_RUN" -print0 | \
    xargs -0 grep -l "slop" 2>/dev/null)

if [ -z "$new_sessions" ]; then
    exit 0
fi

echo "$new_sessions" | jq -R -s 'split("\n") | map(select(length > 0))' > "$OUTPUT"
touch "$LAST_RUN"
exit 0
```

### Session Excerpt Extraction

After finding relevant sessions, the orchestrator extracts slop-related excerpts (not full sessions — those can be 3M+ lines). Strategy:

1. Parse JSONL line by line
2. Extract messages where `content` contains "slop" (case-insensitive)
3. Include ±5 messages of context around each match
4. Cap at 50K tokens per session (truncate oldest if over)
5. Write excerpts to `/tmp/slop-auto-improve-excerpts/`

---

## Orchestrator: Bun Implementation

```
scripts/auto-improve/
├── orchestrator.ts          # Main entry: cron handler, pipeline coordinator
├── pre-filter.sh            # Session scanner (no AI)
├── extract-excerpts.ts      # JSONL parser, slop-related excerpt extraction
├── evaluators/
│   ├── codex.ts             # Codex evaluator launcher (A & B)
│   ├── qwen.ts              # Qwen 122B evaluator via mlx_lm
│   └── instructions/
│       ├── evaluator.md     # Layer 1 evaluator prompt
│       ├── reviewer.md      # Layer 2 reviewer prompt
│       └── synthesizer.md   # Layer 3 synthesizer prompt
├── reviewers/
│   ├── codex-review.ts      # Layer 2 reviewer launcher (C & D)
│   └── synthesize.ts        # Layer 3 synthesizer launcher (E)
├── apply/
│   ├── gate.ts              # Apply gate logic
│   ├── skill-updater.ts     # Auto-apply skill changes
│   └── queue.ts             # Queue code changes for review
├── training/
│   ├── collect.ts           # Extract training data from L3 output
│   ├── train.ts             # LoRA fine-tuning via mlx_lm.lora
│   └── evaluate.ts          # Validate fine-tuned model
├── models/
│   └── adapters/            # LoRA adapter checkpoints
├── queue/                   # Queued code changes for review
├── training-data/
│   └── labeled.jsonl        # Accumulated labeled examples
├── results/
│   └── YYYY-MM-DD-HHMM/    # Per-run output (all layers)
└── config.ts                # Pipeline configuration
```

### Key Implementation Details

**Parallel Execution (Layer 1):**
```typescript
const [codexA, codexB, qwen] = await Promise.all([
    launchCodexEvaluator("A", excerpts, instructions),
    launchCodexEvaluator("B", excerpts, instructions),
    launchQwenEvaluator(excerpts, instructions, adapterPath)
]);
```

**Codex Launch Pattern:**
```typescript
async function launchCodexEvaluator(id: string, excerpts: string, instructions: string) {
    const proc = Bun.spawn([
        "codex", "exec",
        "--ephemeral",
        "--full-auto",
        "-m", "gpt-5.4",
        "-c", 'model_reasoning_effort="high"',
        "-c", 'model_reasoning_summary="detailed"',
        "--disable", "multi_agent",
        "--disable", "personality",
        "-c", `model_instructions_file="${instructions}"`,
        "--skip-git-repo-check",
        "--json",
        "-o", `/tmp/slop-auto-improve-layer1-${id}.json`,
        excerpts
    ], {
        cwd: "/Volumes/VRAM/00-09_System/01_Tools/slop-browser",
        env: {
            ...process.env,
            CODEX_HOME: `/tmp/slop-codex-${id}`
        },
        timeout: 300_000 // 5 minutes per evaluator
    });
    await proc.exited;
    return Bun.file(`/tmp/slop-auto-improve-layer1-${id}.json`).json();
}
```

**Qwen Launch Pattern:**
```typescript
async function launchQwenEvaluator(excerpts: string, instructions: string, adapter?: string) {
    const args = [
        "-m", "mlx_lm.generate",
        "--model", "mlx-community/Qwen3.5-122B-A10B-4bit",
        "--max-tokens", "4096",
        "--temp", "0.3",
        "--prompt", buildPrompt(instructions, excerpts)
    ];
    if (adapter) {
        args.push("--adapter-path", adapter);
    }
    const proc = Bun.spawn(["python3", ...args], {
        timeout: 600_000 // 10 minutes (local inference is slower)
    });
    const output = await new Response(proc.stdout).text();
    return parseJsonFromOutput(output);
}
```

**Cron Registration:**
```typescript
await Bun.cron(
    "./scripts/auto-improve/orchestrator.ts",
    "0 * * * *",  // every hour
    "slop-auto-improve"
);
```

This registers with macOS launchd at `~/Library/LaunchAgents/bun.cron.slop-auto-improve.plist`.

---

## Evaluator Instructions

### Layer 1: Evaluator Prompt (`evaluator.md`)

```markdown
You are analyzing Claude Code session logs for slop-browser usage patterns.

## Context
slop-browser is an agent-driven Chrome extension with CLI bridge.
Project goals: undetectability, agent-driven design, resilience, speed.

## Your Task
Read the session excerpts below. For each interaction with slop-browser, identify:

1. **Failures**: Commands that errored, timed out, or returned unexpected results
2. **Workarounds**: Where the agent tried multiple approaches (e.g., `slop click` then `slop click --os`)
3. **Missing features**: Tasks the agent struggled with due to missing capabilities
4. **UX friction**: Commands that required multiple attempts or confusing flag combinations
5. **Performance issues**: Slow responses, timeouts, or memory problems

For each finding, provide:
- The exact session text as evidence (copy verbatim)
- Which project goal it relates to
- A specific, actionable suggested fix

Output valid JSON matching the schema provided.

Do NOT suggest:
- Features that conflict with undetectability (no CDP, no debugger)
- Changes that add internal agent logic (slop-browser is a dumb actuator)
- Improvements without evidence from the sessions
- Generic "code quality" changes that don't address real usage patterns
```

### Layer 2: Reviewer Prompt (`reviewer.md`)

```markdown
You are reviewing findings from three independent evaluators who analyzed
slop-browser usage in Claude Code sessions.

## Project Goals (from PRDs)
1. Undetectable — no CDP, no debugger, no navigator.webdriver artifacts
2. Agent-driven — no internal LLM, the calling agent drives all decisions
3. Resilient — handle service worker suspension, connection loss, stale DOM
4. Fast — batch actions to minimize IPC round trips

## Your Task
For each finding, determine:
1. Is the evidence real? Does the session excerpt actually show this problem?
2. Does the suggested fix serve at least one project goal?
3. Is the fix safe? Could it cause regressions?
4. How many Layer 1 evaluators independently identified this? (consensus signal)
5. Is this a real pattern or a one-off fluke?

REJECT findings that:
- Have fabricated or misinterpreted evidence
- Propose changes that violate project goals
- Are one-off issues unlikely to recur
- Suggest over-engineering for edge cases

APPROVE findings that:
- Have clear evidence from sessions
- Serve project goals directly
- Are identified by 2+ evaluators independently
- Address recurring patterns
```

### Layer 3: Synthesizer Prompt (`synthesizer.md`)

```markdown
You are the final decision-maker for slop-browser improvements.

You have received:
1. Layer 1 findings (3 independent evaluators)
2. Layer 2 reviews (2 independent reviewers)

Focus primarily on Layer 2 reviews, but reference Layer 1 for context.

## Your Task
1. Resolve any disagreements between Layer 2 reviewers
2. Rank approved changes by: impact × safety × consensus
3. For each approved change, write exact implementation instructions
4. Generate training data labels (approved/rejected + reasoning)

## Decision Framework
- Both L2 reviewers approve + L1 consensus ≥ 2 → STRONG APPROVE
- One L2 approves, one rejects → examine reasoning, lean toward rejection
- Both L2 reject → REJECT (do not override)
- L1 consensus = 1 (single evaluator) → needs BOTH L2 approvals

Output the final approved changes list with implementation details.
```

---

## Configuration

```typescript
// scripts/auto-improve/config.ts
export const config = {
    cron: "0 * * * *",  // every hour
    sessionsDir: `${Bun.env.HOME}/.claude/projects`,
    slopBrowserDir: "/Volumes/VRAM/00-09_System/01_Tools/slop-browser",
    slopSkillDir: `${Bun.env.HOME}/.claude/skills/slop`,

    models: {
        codex: "gpt-5.4",
        qwen: "mlx-community/Qwen3.5-122B-A10B-4bit",
        qwenAdapter: null as string | null,  // set after first fine-tune
    },

    evaluation: {
        layer1Timeout: 300_000,   // 5 min per Codex evaluator
        qwenTimeout: 600_000,     // 10 min for local model
        layer2Timeout: 300_000,   // 5 min per reviewer
        layer3Timeout: 300_000,   // 5 min for synthesizer
        maxExcerptTokens: 50_000, // per session
        maxSessionsPerRun: 20,    // cap to control costs
    },

    applyGate: {
        autoApplySkill: true,          // auto-apply skill changes
        autoApplyMinConsensus: 2,      // L2 consensus required
        autoApplyMinConfidence: 0.9,   // L3 confidence threshold
        queueCodeChanges: true,        // queue code changes for review
        blockExtensionChanges: true,   // never auto-modify extension
    },

    training: {
        minExamplesForFirstTrain: 50,
        retrainThreshold: 25,          // retrain after 25 new examples
        loraRank: 16,
        loraAlpha: 16,
        learningRate: 1e-5,            // conservative for MoE
        epochs: 2,                     // max 2 for MoE QLoRA
        maxSeqLen: 1024,
        batchSize: 1,
        gradientCheckpointing: true,
    },

    results: {
        dir: "/Volumes/VRAM/00-09_System/01_Tools/slop-browser/scripts/auto-improve/results",
        retainDays: 90,
    }
};
```

---

## Observability

Each pipeline run produces:
```
results/2026-03-22-1400/
├── run-meta.json          # Run ID, timestamp, sessions scanned, duration
├── pre-filter.json        # Sessions found, excerpts extracted
├── layer1/
│   ├── codex-a.json       # Evaluator A findings
│   ├── codex-b.json       # Evaluator B findings
│   └── qwen-122b.json     # Qwen findings
├── layer2/
│   ├── codex-c.json       # Reviewer C verdicts
│   └── codex-d.json       # Reviewer D verdicts
├── layer3/
│   └── synthesizer.json   # Final approved changes + training data
├── applied/
│   ├── skill-diff.patch   # What was auto-applied to SKILL.md
│   └── queued-changes/    # Code changes awaiting review
└── training/
    └── new-examples.jsonl # New labeled examples from this run
```

---

## Rollback & Safety

1. **Skill changes** committed to `auto-improve/<date>` branch, never directly to main
2. **Git bisect-friendly** — each auto-applied change is its own commit with the run ID in the message
3. **Adapter rollback** — if fine-tuned model produces worse evaluations (measured by L2 rejection rate increasing), revert to previous adapter or off-the-shelf
4. **Kill switch** — `bun scripts/auto-improve/orchestrator.ts --disable` removes the launchd cron job
5. **Rate limit** — max 5 skill changes per day, max 10 queued code changes per day
6. **Dry run** — `bun scripts/auto-improve/orchestrator.ts --dry-run` runs the full pipeline but applies nothing

---

## Phases

### Phase 1: Ship the Pipeline (Week 1) — COMPLETED 2026-03-22
- [x] Pre-filter script
- [x] Excerpt extraction from JSONL
- [x] Codex evaluator launcher (Layer 1 A & B)
- [x] Qwen evaluator launcher (Layer 1, off-the-shelf 122B)
- [x] Codex reviewer launcher (Layer 2 C & D)
- [x] Codex synthesizer launcher (Layer 3 E)
- [x] Apply gate (skill auto-apply + code queue)
- [x] Orchestrator with cron registration
- [x] Results directory structure
- [x] Dry-run mode
- [x] Kill switch
- [x] Production test #1 (dry-run): 22 findings, 5 approved, 2 queued, 3 blocked
- [x] Production test #2 (live): 19 findings, 1 approved, 3 training examples collected

### Phase 2: Fine-Tuning (After 50+ Labeled Examples, ~Month 2)
- [ ] Training data collection from L3 outputs
- [ ] LoRA training script via mlx_lm
- [ ] Adapter evaluation (compare fine-tuned vs off-the-shelf)
- [ ] Adapter management (versioned, rollback-capable)
- [ ] Automatic retrain trigger when threshold reached
- [ ] Validation loss monitoring

### Phase 3: Optimization (Month 3+)
- [ ] Tune evaluator prompts based on L2 rejection patterns
- [ ] Adjust consensus thresholds based on false positive/negative rates
- [ ] Graduate from hourly to event-driven (trigger on session end, not cron)
- [ ] Dashboard for pipeline health metrics
- [ ] Cross-pollination: apply pattern to other skills (browser, research, etc.)

---

## Cost Estimate

| Component | Per Run | Per Day (24 runs) | Per Month |
|-----------|---------|-------------------|-----------|
| **Codex A** (gpt-5.4, ~2K input + 1K output) | ~$0.04 | ~$0.96 | ~$29 |
| **Codex B** (same) | ~$0.04 | ~$0.96 | ~$29 |
| **Codex C** (reviewer, ~3K input + 1K output) | ~$0.05 | ~$1.20 | ~$36 |
| **Codex D** (same) | ~$0.05 | ~$1.20 | ~$36 |
| **Codex E** (synthesizer, ~5K input + 2K output) | ~$0.08 | ~$1.92 | ~$58 |
| **Qwen 122B** (local) | $0.00 | $0.00 | $0.00 |
| **Pre-filter** (grep) | $0.00 | $0.00 | $0.00 |
| **Total** | ~$0.26 | ~$6.24 | ~$188 |

**Note:** Most runs will exit at pre-filter (no new sessions). Realistic cost with 3-5 active runs per day: **~$25-40/month**.

With pre-filter short-circuiting, the 5 Codex instances only spin up when there's actual new slop session data to analyze. On a quiet day with no slop usage, cost is $0.

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Findings per run** | 1-5 (quality over quantity) | Count from L1 |
| **L2 approval rate** | 40-60% (strict filtering) | approved / total |
| **L3 confidence** | ≥ 0.85 average | From synthesizer output |
| **Skill improvements applied** | 2-5 per week | Git log on auto-improve branch |
| **Code changes queued** | 1-3 per week | Queue directory count |
| **Fine-tuned model lift** | L2 rejection rate drops 20%+ after fine-tune | Compare pre/post fine-tune |
| **False positive rate** | <10% (Ron rejects <10% of auto-applied changes) | Ron's merge/reject ratio |

---

## Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| Bun | ≥1.0 | Orchestrator runtime, cron, subprocess management |
| Codex CLI | latest | gpt-5.4 evaluation instances |
| mlx-lm | ≥0.20 | Qwen 122B inference + LoRA fine-tuning |
| mlx | ≥0.22 | Apple Silicon ML framework |
| Python | 3.10+ | MLX runtime |
| Qwen3.5-122B-A10B-4bit | mlx-community | Base model (~70GB) |

---

## References

- [Qwen 3.5 MLX Installation Guide](https://dev.to/thefalkonguy/installing-qwen-35-on-apple-silicon-using-mlx-for-2x-performance-37ma)
- [mlx-lm LoRA Documentation](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md)
- [mlx-lm MoE LoRA Issue #571](https://github.com/ml-explore/mlx-lm/issues/571)
- [Unsloth Qwen3.5 Fine-Tuning Guide](https://unsloth.ai/docs/models/qwen3.5/fine-tune)
- [mlx-community/Qwen3.5-122B-A10B-4bit](https://huggingface.co/mlx-community/Qwen3.5-122B-A10B-4bit)
- [Bun Subprocess API](https://bun.sh/docs/runtime/child-process)
- [Bun Shell API](https://bun.sh/docs/runtime/shell)
- [Bun Cron API](https://bun.sh/docs/runtime/cron)
- [Codex CLI Exec Documentation](/Volumes/VRAM/80-89_Resources/80_Reference/docs/openai/codex/)
- [slop-browser PRD-1 through PRD-7](/Volumes/VRAM/00-09_System/01_Tools/slop-browser/prd/)
