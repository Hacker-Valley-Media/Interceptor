import { config } from "../config";
import { join } from "path";
import { mkdirSync } from "fs";

export interface ReviewVerdict {
  finding_id: string;
  verdict: "approve" | "reject" | "needs_more_data";
  confidence: number;
  reasoning: string;
  goal_check: Record<string, boolean>;
  consensus: { layer1_agreement: number; evaluators_agreeing: string[] };
}

export interface ReviewerResult {
  reviewer: string;
  reviews: ReviewVerdict[];
  error?: string;
}

export async function launchCodexReviewer(
  id: string,
  layer1FindingsJson: string,
  runDir: string
): Promise<ReviewerResult> {
  const instructionsPath = join(
    config.paths.instructionsDir,
    "reviewer.md"
  );
  const instructions = await Bun.file(instructionsPath).text();
  const fullPrompt = instructions + "\n" + layer1FindingsJson;

  const outputFile = join(runDir, `codex-${id}.json`);
  const codexHome = `/tmp/slop-codex-review-${id}-${Date.now()}`;
  mkdirSync(codexHome, { recursive: true });

  const promptFile = join(codexHome, "prompt.txt");
  await Bun.write(promptFile, fullPrompt);

  const args = [
    config.models.codexBinary,
    "exec",
    "--ephemeral",
    "--full-auto",
    "--skip-git-repo-check",
    "-C", config.paths.slopBrowserDir,
    "-o", outputFile,
    "-"
  ];
  if (config.models.codex) {
    args.splice(3, 0, "-m", config.models.codex);
  }

  const proc = Bun.spawn(args, {
    stdin: Bun.file(promptFile),
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
    },
    timeout: config.evaluation.layer2Timeout,
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    return {
      reviewer: `codex-${id}`,
      reviews: [],
      error: `Exit code ${exitCode}: ${stderr.slice(0, 200)}`,
    };
  }

  const outputExists = await Bun.file(outputFile).exists();
  if (!outputExists) {
    return { reviewer: `codex-${id}`, reviews: [], error: "No output" };
  }

  const raw = await Bun.file(outputFile).text();

  try {
    const jsonMatch = raw.match(/\{[\s\S]*"reviews"[\s\S]*\}/);
    if (!jsonMatch) {
      return { reviewer: `codex-${id}`, reviews: [], error: "No JSON" };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      reviewer: `codex-${id}`,
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
    };
  } catch (e: any) {
    return {
      reviewer: `codex-${id}`,
      reviews: [],
      error: `Parse error: ${e.message}`,
    };
  }
}
