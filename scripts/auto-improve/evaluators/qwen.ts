import { config } from "../config";
import { join } from "path";
import { mkdirSync } from "fs";
import type { EvaluatorResult } from "./codex";

export async function launchQwenEvaluator(
  excerptsCombined: string,
  runDir: string
): Promise<EvaluatorResult> {
  const instructionsPath = join(
    config.paths.instructionsDir,
    "evaluator.md"
  );
  const instructions = await Bun.file(instructionsPath).text();

  const truncatedExcerpts = excerptsCombined.slice(0, 8000);
  const fullPrompt =
    instructions +
    "\n" +
    truncatedExcerpts +
    '\n\nRespond with ONLY valid JSON. No markdown, no explanation. Start with { and end with }';

  const outputFile = join(runDir, "qwen-122b.json");
  const tmpDir = `/tmp/slop-qwen-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });

  const promptFile = join(tmpDir, "prompt.txt");
  await Bun.write(promptFile, fullPrompt);

  const runnerPath = join(import.meta.dir, "qwen-runner.py");
  const args = [
    "python3", runnerPath,
    promptFile,
    config.models.qwen,
    "4096",
  ];

  if (config.models.qwenAdapter) {
    args.push(config.models.qwenAdapter);
  }

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: config.evaluation.qwenTimeout,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`Qwen exited ${exitCode}: ${stderr.slice(0, 200)}`);
    return {
      evaluator: "qwen-122b",
      findings: [],
      error: `Exit code ${exitCode}: ${stderr.slice(0, 200)}`,
    };
  }

  try {
    const jsonMatch = stdout.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (!jsonMatch) {
      await Bun.write(
        outputFile,
        JSON.stringify({
          evaluator: "qwen-122b",
          findings: [],
          raw: stdout.slice(0, 2000),
        })
      );
      return {
        evaluator: "qwen-122b",
        findings: [],
        error: "No JSON found in output",
      };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const result: EvaluatorResult = {
      evaluator: "qwen-122b",
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    };
    await Bun.write(outputFile, JSON.stringify(result, null, 2));
    return result;
  } catch (e: any) {
    await Bun.write(
      outputFile,
      JSON.stringify({
        evaluator: "qwen-122b",
        findings: [],
        error: e.message,
        raw: stdout.slice(0, 2000),
      })
    );
    return {
      evaluator: "qwen-122b",
      findings: [],
      error: `JSON parse error: ${e.message}`,
    };
  }
}
