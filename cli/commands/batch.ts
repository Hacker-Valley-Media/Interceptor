/**
 * cli/commands/batch.ts — batch, raw
 */

type Action = { type: string; [key: string]: unknown }

export function parseBatchCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "batch": {
      if (!filtered[1]) {
        console.error("error: batch requires a JSON array of actions. Usage: interceptor batch '[{\"type\":\"click\",\"ref\":\"e5\"}, ...]'")
        process.exit(1)
      }
      try {
        const batchActions = JSON.parse(filtered[1])
        if (!Array.isArray(batchActions)) {
          console.error("error: batch argument must be a JSON array")
          process.exit(1)
        }
        const batchTimeout = filtered.includes("--timeout")
          ? parseInt(filtered[filtered.indexOf("--timeout") + 1])
          : 30000
        return {
          type: "batch",
          actions: batchActions,
          stopOnError: filtered.includes("--stop-on-error"),
          timeout: batchTimeout
        }
      } catch (e) {
        console.error(`error: invalid JSON for batch: ${(e as Error).message}`)
        process.exit(1)
      }
      break
    }

    case "raw":
      return JSON.parse(filtered.slice(1).join(" "))

    default:
      console.error(`error: unknown batch command '${cmd}'`)
      process.exit(1)
  }
  throw new Error("unreachable")
}
