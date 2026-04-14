import type { AgentFinalMessage, GradeResult, TaskDef } from "./types"

function includesAll(answer: string, expected: string[]): boolean {
  const lower = answer.toLowerCase()
  return expected.every((piece) => lower.includes(piece.toLowerCase()))
}

function includesAny(answer: string, expected: string[]): boolean {
  const lower = answer.toLowerCase()
  return expected.some((piece) => lower.includes(piece.toLowerCase()))
}

export function deterministicGrade(task: TaskDef, final: AgentFinalMessage): GradeResult | null {
  const expected = task.validator.expected ?? []
  switch (task.validator.type) {
    case "text_in_answer":
      return {
        pass: includesAny(final.answer, expected),
        score: includesAny(final.answer, expected) ? 1 : 0,
        reason: includesAny(final.answer, expected)
          ? `Answer included expected text: ${expected.join(", ")}`
          : `Answer missing expected text: ${expected.join(", ")}`,
        mode: "deterministic",
      }
    case "text_all_of_in_answer":
      return {
        pass: includesAll(final.answer, expected),
        score: includesAll(final.answer, expected) ? 1 : 0,
        reason: includesAll(final.answer, expected)
          ? `Answer included all expected text fragments.`
          : `Answer did not include all expected fragments: ${expected.join(", ")}`,
        mode: "deterministic",
      }
    case "text_any_of_in_answer":
      return {
        pass: includesAny(final.answer, expected),
        score: includesAny(final.answer, expected) ? 1 : 0,
        reason: includesAny(final.answer, expected)
          ? `Answer included one of the accepted text fragments.`
          : `Answer did not include any accepted fragment: ${expected.join(", ")}`,
        mode: "deterministic",
      }
    case "requires_judge":
      return null
  }
}
