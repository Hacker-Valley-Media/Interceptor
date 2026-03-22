import { config } from "../config";
import { join } from "path";
import { mkdirSync } from "fs";

export interface ApprovedChange {
  finding_id: string;
  priority: number;
  target: string;
  change_type: string;
  description: string;
  implementation: string;
  layer1_consensus: number;
  layer2_consensus: number;
  confidence: number;
}

export interface TrainingExample {
  input: string;
  output: string;
  label: "approved" | "rejected";
  reasoning: string;
}

export interface SynthesizerResult {
  approved_changes: ApprovedChange[];
  rejected_changes: { finding_id: string; reason: string }[];
  training_data: TrainingExample[];
  error?: string;
}

export async function launchSynthesizer(
  layer1FindingsJson: string,
  layer2ReviewsJson: string,
  runDir: string
): Promise<SynthesizerResult> {
  const instructionsPath = join(
    config.paths.instructionsDir,
    "synthesizer.md"
  );
  let instructions = await Bun.file(instructionsPath).text();
  instructions = instructions
    .replace("{LAYER1_FINDINGS}", layer1FindingsJson)
    .replace("{LAYER2_REVIEWS}", layer2ReviewsJson);

  const outputFile = join(runDir, "synthesizer.json");
  const codexHome = `/tmp/slop-codex-synth-${Date.now()}`;
  mkdirSync(codexHome, { recursive: true });

  const promptFile = join(codexHome, "prompt.txt");
  await Bun.write(promptFile, instructions);

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
    timeout: config.evaluation.layer3Timeout,
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    return {
      approved_changes: [],
      rejected_changes: [],
      training_data: [],
      error: `Exit code ${exitCode}: ${stderr.slice(0, 200)}`,
    };
  }

  const outputExists = await Bun.file(outputFile).exists();
  if (!outputExists) {
    return {
      approved_changes: [],
      rejected_changes: [],
      training_data: [],
      error: "No output",
    };
  }

  const raw = await Bun.file(outputFile).text();

  try {
    const jsonMatch = raw.match(/\{[\s\S]*"approved_changes"[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        approved_changes: [],
        rejected_changes: [],
        training_data: [],
        error: "No JSON",
      };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      approved_changes: parsed.approved_changes || [],
      rejected_changes: parsed.rejected_changes || [],
      training_data: parsed.training_data || [],
    };
  } catch (e: any) {
    return {
      approved_changes: [],
      rejected_changes: [],
      training_data: [],
      error: `Parse error: ${e.message}`,
    };
  }
}
