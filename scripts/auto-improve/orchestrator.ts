import { config } from "./config";
import { extractExcerpts } from "./extract-excerpts";
import { launchCodexEvaluator, type EvaluatorResult, type Finding } from "./evaluators/codex";
import { launchQwenEvaluator } from "./evaluators/qwen";
import { launchCodexReviewer, type ReviewerResult } from "./reviewers/codex-review";
import { launchSynthesizer, type SynthesizerResult } from "./reviewers/synthesize";
import { applyGate, type GateResult } from "./apply/gate";
import { join } from "path";
import { mkdirSync } from "fs";
import { $ } from "bun";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const disable = args.includes("--disable");
const enable = args.includes("--enable");

if (disable) {
  try {
    await Bun.cron.remove("slop-auto-improve");
    console.log("Cron job removed.");
  } catch {
    console.log("No cron job to remove.");
  }
  process.exit(0);
}

if (enable) {
  await Bun.cron(
    join(import.meta.dir, "orchestrator.ts"),
    config.cron,
    "slop-auto-improve"
  );
  console.log(`Cron job registered: ${config.cron}`);
  process.exit(0);
}

const runTimestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .slice(0, 19);
const runDir = join(config.paths.resultsDir, runTimestamp);
const layer1Dir = join(runDir, "layer1");
const layer2Dir = join(runDir, "layer2");
const layer3Dir = join(runDir, "layer3");
mkdirSync(layer1Dir, { recursive: true });
mkdirSync(layer2Dir, { recursive: true });
mkdirSync(layer3Dir, { recursive: true });

console.log(`\n=== slop-browser auto-improve ===`);
console.log(`Run: ${runTimestamp}`);
console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
console.log();

console.log(`[1/6] Pre-filter (last ${config.evaluation.recencyHours}h)...`);
const preFilterProc = Bun.spawn(
  ["bash", join(config.paths.autoImproveDir, "pre-filter.sh")],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SLOP_RECENCY_HOURS: String(config.evaluation.recencyHours) },
  }
);
const preFilterExit = await preFilterProc.exited;

if (preFilterExit !== 0) {
  console.log("  No new slop sessions found. Exiting.");
  await Bun.write(
    join(runDir, "run-meta.json"),
    JSON.stringify(
      { timestamp: runTimestamp, status: "no_new_sessions", dryRun },
      null,
      2
    )
  );
  process.exit(0);
}

const sessions: string[] = await Bun.file(config.paths.sessionsFile).json();
console.log(`  Found ${sessions.length} sessions with slop references`);

console.log("[2/6] Extracting excerpts...");
const excerptsDir = config.paths.excerptsDir;
const excerptPaths = await extractExcerpts(sessions, excerptsDir);
console.log(`  Extracted ${excerptPaths.length} session excerpts`);

if (excerptPaths.length === 0) {
  console.log("  No actionable excerpts. Exiting.");
  process.exit(0);
}

let excerptsCombined = "";
for (const ep of excerptPaths) {
  const text = await Bun.file(ep).text();
  excerptsCombined += text + "\n\n";
}
excerptsCombined = excerptsCombined.slice(0, 100_000);

console.log("[3/6] Layer 1 — Parallel evaluation (2 Codex + 1 Qwen)...");
const layer1Start = Date.now();
const [codexA, codexB, qwen] = await Promise.all([
  launchCodexEvaluator("a", excerptsCombined, layer1Dir),
  launchCodexEvaluator("b", excerptsCombined, layer1Dir),
  launchQwenEvaluator(excerptsCombined, layer1Dir),
]);
const layer1Ms = Date.now() - layer1Start;

const layer1Results: EvaluatorResult[] = [codexA, codexB, qwen];
for (const r of layer1Results) {
  console.log(
    `  ${r.evaluator}: ${r.findings.length} findings${r.error ? ` (error: ${r.error.slice(0, 80)})` : ""}`
  );
}

await Bun.write(
  join(layer1Dir, "merged.json"),
  JSON.stringify(layer1Results, null, 2)
);

const allFindings = layer1Results.flatMap((r) => r.findings);
if (allFindings.length === 0) {
  console.log("  No findings from any evaluator. Exiting.");
  await Bun.write(
    join(runDir, "run-meta.json"),
    JSON.stringify(
      {
        timestamp: runTimestamp,
        status: "no_findings",
        dryRun,
        layer1Ms,
        sessionsScanned: sessions.length,
        excerptsExtracted: excerptPaths.length,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const findingConsensus = new Map<string, { count: number; evaluators: string[] }>();
for (const r of layer1Results) {
  for (const f of r.findings) {
    const key = f.description?.toLowerCase().slice(0, 100) || f.id;
    const existing = findingConsensus.get(key) || { count: 0, evaluators: [] };
    existing.count++;
    existing.evaluators.push(r.evaluator);
    findingConsensus.set(key, existing);
  }
}

const layer1Json = JSON.stringify(layer1Results, null, 2);

console.log("[4/6] Layer 2 — Parallel review (2 Codex reviewers)...");
const layer2Start = Date.now();
const [reviewC, reviewD] = await Promise.all([
  launchCodexReviewer("c", layer1Json, layer2Dir),
  launchCodexReviewer("d", layer1Json, layer2Dir),
]);
const layer2Ms = Date.now() - layer2Start;

const layer2Results: ReviewerResult[] = [reviewC, reviewD];
for (const r of layer2Results) {
  const approvals = r.reviews.filter((v) => v.verdict === "approve").length;
  const rejections = r.reviews.filter((v) => v.verdict === "reject").length;
  console.log(
    `  ${r.reviewer}: ${approvals} approved, ${rejections} rejected${r.error ? ` (error: ${r.error.slice(0, 80)})` : ""}`
  );
}

await Bun.write(
  join(layer2Dir, "merged.json"),
  JSON.stringify(layer2Results, null, 2)
);

const layer2Json = JSON.stringify(layer2Results, null, 2);

console.log("[5/6] Layer 3 — Final synthesis...");
const layer3Start = Date.now();
const synthesis: SynthesizerResult = await launchSynthesizer(
  layer1Json,
  layer2Json,
  layer3Dir
);
const layer3Ms = Date.now() - layer3Start;

console.log(
  `  ${synthesis.approved_changes.length} approved, ${synthesis.rejected_changes.length} rejected${synthesis.error ? ` (error: ${synthesis.error.slice(0, 80)})` : ""}`
);

await Bun.write(
  join(layer3Dir, "synthesis.json"),
  JSON.stringify(synthesis, null, 2)
);

console.log("[6/6] Apply gate...");
const gateResult: GateResult = await applyGate(
  synthesis.approved_changes,
  synthesis.training_data,
  runDir,
  dryRun
);

console.log(`  Applied: ${gateResult.applied.length}`);
console.log(`  Queued: ${gateResult.queued.length}`);
console.log(`  Blocked: ${gateResult.blocked.length}`);
console.log(`  Training examples: ${gateResult.trainingDataAppended}`);

const meta = {
  timestamp: runTimestamp,
  status: "completed",
  dryRun,
  sessionsScanned: sessions.length,
  excerptsExtracted: excerptPaths.length,
  layer1: {
    durationMs: layer1Ms,
    findings: allFindings.length,
    byEvaluator: layer1Results.map((r) => ({
      name: r.evaluator,
      findings: r.findings.length,
      error: r.error || null,
    })),
  },
  layer2: {
    durationMs: layer2Ms,
    byReviewer: layer2Results.map((r) => ({
      name: r.reviewer,
      approved: r.reviews.filter((v) => v.verdict === "approve").length,
      rejected: r.reviews.filter((v) => v.verdict === "reject").length,
      error: r.error || null,
    })),
  },
  layer3: {
    durationMs: layer3Ms,
    approved: synthesis.approved_changes.length,
    rejected: synthesis.rejected_changes.length,
    error: synthesis.error || null,
  },
  gate: {
    applied: gateResult.applied.length,
    queued: gateResult.queued.length,
    blocked: gateResult.blocked.length,
    trainingExamples: gateResult.trainingDataAppended,
  },
};

await Bun.write(join(runDir, "run-meta.json"), JSON.stringify(meta, null, 2));

console.log(`\n=== Run complete: ${runDir} ===`);
console.log(
  `Total: ${layer1Ms + layer2Ms + layer3Ms}ms (L1: ${layer1Ms}ms, L2: ${layer2Ms}ms, L3: ${layer3Ms}ms)`
);
