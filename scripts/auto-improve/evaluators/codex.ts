import { config } from "../config";
import { join } from "path";
import { mkdirSync } from "fs";

export interface Finding {
  id: string;
  type: string;
  severity: string;
  evidence: { excerpt: string };
  description: string;
  suggested_fix: string;
  target: string;
  goal_alignment: string;
}

export interface EvaluatorResult {
  evaluator: string;
  findings: Finding[];
  error?: string;
}

export async function launchCodexEvaluator(
  id: string,
  excerptsCombined: string,
  runDir: string
): Promise<EvaluatorResult> {
  const instructionsPath = join(
    config.paths.instructionsDir,
    "evaluator.md"
  );
  const instructions = await Bun.file(instructionsPath).text();
  const fullPrompt = instructions + "\n" + excerptsCombined;

  const outputFile = join(runDir, `codex-${id}.json`);
  const codexHome = `/tmp/slop-codex-${id}-${Date.now()}`;
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
    timeout: config.evaluation.layer1Timeout,
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    console.error(`Codex ${id} exited ${exitCode}: ${stderr.slice(0, 200)}`);
    return {
      evaluator: `codex-${id}`,
      findings: [],
      error: `Exit code ${exitCode}: ${stderr.slice(0, 200)}`,
    };
  }

  const outputExists = await Bun.file(outputFile).exists();
  if (!outputExists) {
    return {
      evaluator: `codex-${id}`,
      findings: [],
      error: "No output file produced",
    };
  }

  const raw = await Bun.file(outputFile).text();

  try {
    const jsonMatch = raw.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        evaluator: `codex-${id}`,
        findings: [],
        error: "No JSON found in output",
      };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      evaluator: `codex-${id}`,
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    };
  } catch (e: any) {
    return {
      evaluator: `codex-${id}`,
      findings: [],
      error: `JSON parse error: ${e.message}`,
    };
  }
}
