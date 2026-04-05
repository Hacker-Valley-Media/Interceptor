/**
 * cli/commands/eval.ts — eval
 */

type Action = { type: string; [key: string]: unknown }

export function parseEvalCommand(filtered: string[]): Action {
  const world = filtered.includes("--main") ? "MAIN" : "ISOLATED"
  const code = filtered.slice(1).filter(a => a !== "--main").join(" ")
  return { type: "evaluate", code, world }
}
