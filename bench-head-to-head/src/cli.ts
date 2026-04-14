import { runMatrix, runOne } from "./runner"
import { writeReports } from "./reporter"
import { loadConfig } from "./utils"
import type { RunSpec, SuiteId, ConditionId } from "./types"

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue
    const key = argv[i].slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true"
    args[key] = value
    if (value !== "true") i += 1
  }
  return args
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const config = loadConfig()

  switch (command) {
    case "run": {
      const suite = (args.suite || "public_parity") as SuiteId
      const condition = (args.condition || "interceptor") as ConditionId
      const taskId = args.task
      const run = Number(args.run || 1)
      if (!taskId) throw new Error("Missing --task for run command")
      const result = runOne({ suite, condition, taskId, run } as RunSpec, config)
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "matrix": {
      const suite = args.suite
      const condition = args.condition
      const repeat = args.repeat ? Number(args.repeat) : undefined
      const results = runMatrix({ suite, condition, repeat })
      console.log(`Completed ${results.length} benchmark runs.`)
      return
    }
    case "report": {
      writeReports()
      console.log("Reports written.")
      return
    }
    default:
      console.log(`interceptor vs axi head-to-head benchmark\n\nCommands:\n  run --suite <public_parity|interceptor_differentiation> --condition <interceptor|axi> --task <id> [--run N]\n  matrix [--suite <id>] [--condition <id>] [--repeat N]\n  report`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
