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
      return { type: "wait", ms: parseInt(filtered[1]) }

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
