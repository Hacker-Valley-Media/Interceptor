import { homedir } from "os";
import { join } from "path";

const home = homedir();
const autoImproveDir = import.meta.dir;

export const config = {
  cron: "0 * * * *",

  paths: {
    sessionsDir: join(home, ".claude/projects"),
    slopBrowserDir: "/Volumes/VRAM/00-09_System/01_Tools/slop-browser",
    slopSkillDir: join(home, ".claude/skills/slop"),
    autoImproveDir,
    resultsDir: join(autoImproveDir, "results"),
    queueDir: join(autoImproveDir, "queue"),
    trainingDataDir: join(autoImproveDir, "training-data"),
    adaptersDir: join(autoImproveDir, "models/adapters"),
    instructionsDir: join(autoImproveDir, "evaluators/instructions"),
    lastRunFile: "/tmp/slop-auto-improve-lastrun",
    sessionsFile: "/tmp/slop-auto-improve-sessions.json",
    excerptsDir: "/tmp/slop-auto-improve-excerpts",
  },

  models: {
    codex: null as string | null,
    codexBinary: "codex",
    qwen: "mlx-community/Qwen3.5-122B-A10B-4bit",
    qwenAdapter: null as string | null,
  },

  evaluation: {
    recencyHours: 24,
    layer1Timeout: 300_000,
    qwenTimeout: 600_000,
    layer2Timeout: 300_000,
    layer3Timeout: 300_000,
    maxExcerptTokens: 50_000,
    maxSessionsPerRun: 20,
    contextWindowMessages: 5,
  },

  applyGate: {
    autoApplySkill: true,
    autoApplyMinConsensus: 2,
    autoApplyMinConfidence: 0.9,
    queueCodeChanges: true,
    blockExtensionChanges: true,
    maxSkillChangesPerDay: 5,
    maxQueuedChangesPerDay: 10,
  },

  training: {
    minExamplesForFirstTrain: 50,
    retrainThreshold: 25,
    loraRank: 16,
    loraAlpha: 16,
    learningRate: 1e-5,
    epochs: 2,
    maxSeqLen: 1024,
    batchSize: 1,
    gradientCheckpointing: true,
  },
};

export type Config = typeof config;
