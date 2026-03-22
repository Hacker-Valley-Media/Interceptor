import { config } from "../config";
import { join } from "path";
import { mkdirSync } from "fs";
import type { ApprovedChange, TrainingExample } from "../reviewers/synthesize";

export interface GateResult {
  applied: ApprovedChange[];
  queued: ApprovedChange[];
  blocked: ApprovedChange[];
  trainingDataAppended: number;
}

export async function applyGate(
  approvedChanges: ApprovedChange[],
  trainingData: TrainingExample[],
  runDir: string,
  dryRun: boolean
): Promise<GateResult> {
  const result: GateResult = {
    applied: [],
    queued: [],
    blocked: [],
    trainingDataAppended: 0,
  };

  for (const change of approvedChanges) {
    if (config.applyGate.blockExtensionChanges && change.target === "extension") {
      result.blocked.push(change);
      continue;
    }

    if (
      change.target === "skill" &&
      config.applyGate.autoApplySkill &&
      change.layer2_consensus >= config.applyGate.autoApplyMinConsensus &&
      change.confidence >= config.applyGate.autoApplyMinConfidence
    ) {
      if (!dryRun) {
        await applySkillChange(change);
      }
      result.applied.push(change);
      continue;
    }

    if (config.applyGate.queueCodeChanges) {
      if (!dryRun) {
        await queueChange(change, runDir);
      }
      result.queued.push(change);
    }
  }

  if (trainingData.length > 0 && !dryRun) {
    const labeledPath = join(config.paths.trainingDataDir, "labeled.jsonl");
    const lines = trainingData
      .map((td) => JSON.stringify(td))
      .join("\n") + "\n";

    const file = Bun.file(labeledPath);
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(labeledPath, existing + lines);
    result.trainingDataAppended = trainingData.length;
  }

  return result;
}

async function applySkillChange(change: ApprovedChange): Promise<void> {
  const skillPath = join(config.paths.slopSkillDir, "SKILL.md");
  const file = Bun.file(skillPath);
  if (!(await file.exists())) return;

  const current = await file.text();
  const marker = `\n\n<!-- auto-improve: ${change.finding_id} -->\n`;

  if (current.includes(marker)) return;

  const addition = `${marker}${change.implementation}\n`;
  await Bun.write(skillPath, current + addition);
}

async function queueChange(
  change: ApprovedChange,
  runDir: string
): Promise<void> {
  const queueDir = config.paths.queueDir;
  mkdirSync(queueDir, { recursive: true });

  const filename = `${change.finding_id}-${change.target}.json`;
  await Bun.write(
    join(queueDir, filename),
    JSON.stringify(change, null, 2)
  );
}
