/**
 * cli/commands/navigation.ts — navigate, back, forward, scroll, wait, wait-stable, wait_for
 */

type Action = { type: string; [key: string]: unknown }

export function parseNavigationCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "navigate":
      return { type: "navigate", url: filtered[1] }

    case "back":
      return { type: "go_back" }

    case "forward":
      return { type: "go_forward" }

    case "scroll":
      return {
        type: "scroll",
        direction: filtered[1] as "up" | "down" | "top" | "bottom",
        amount: filtered.includes("--amount")
          ? parseInt(filtered[filtered.indexOf("--amount") + 1])
          : undefined
      }

    case "wait":
      return parseWaitCondition(filtered) ?? { type: "wait", ms: parseInt(filtered[1]) }

    case "wait-stable": {
      const ms = filtered.includes("--ms")
        ? parseInt(filtered[filtered.indexOf("--ms") + 1])
        : 200
      const timeout = filtered.includes("--timeout")
        ? parseInt(filtered[filtered.indexOf("--timeout") + 1])
        : 5000
      return { type: "wait_stable", ms, timeout }
    }

    case "wait_for":
      return {
        type: "wait_for",
        selector: filtered[1],
        timeout: filtered[2] ? parseInt(filtered[2]) : 10000
      }

    default:
      console.error(`error: unknown navigation command '${cmd}'`)
      process.exit(1)
  }
}

const WAIT_KINDS: Array<[flag: string, kind: string, field: "text" | "selector"]> = [
  ["--text", "text", "text"], ["--gone", "gone", "text"], ["--url", "url", "text"],
  ["--selector", "selector", "selector"], ["--gone-selector", "gone_selector", "selector"],
]

/**
 * `wait --text <t>`, `--gone <t>`, `--url <t>`, `--selector <css> [--count <n>]`,
 * `--gone-selector <css>`, each with `--timeout <ms>` (default 10000). Null
 * when no condition flag is present, so `wait <ms>` keeps its meaning.
 * Agents were writing sleep loops inside eval for these.
 */
export function parseWaitCondition(filtered: string[]): { type: string; [key: string]: unknown } | null {
  const present = WAIT_KINDS.filter(([flag]) => filtered.includes(flag))
  if (present.length === 0) {
    if (filtered.includes("--count")) throw new Error("wait --count needs --selector <css>, e.g. interceptor wait --selector \".row\" --count 10")
    return null
  }
  if (present.length > 1) throw new Error(`wait takes one condition; got ${present.map(([f]) => f).join(" and ")}`)
  const [flag, kind, field] = present[0]
  const value = filtered[filtered.indexOf(flag) + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`wait ${flag} requires a value`)
  const action: { type: string; [key: string]: unknown } = { type: "wait_condition", kind, [field]: value }
  if (filtered.includes("--count")) {
    if (kind !== "selector") throw new Error("wait --count goes with --selector")
    const n = Number(filtered[filtered.indexOf("--count") + 1])
    if (!Number.isInteger(n) || n < 0) throw new Error("wait --count requires a whole number")
    action.count = n
  }
  const tIdx = filtered.indexOf("--timeout")
  action.timeout = tIdx === -1 ? 10_000 : Number(filtered[tIdx + 1])
  if (!Number.isFinite(action.timeout as number) || (action.timeout as number) < 0) throw new Error("wait --timeout requires milliseconds")
  return action
}
