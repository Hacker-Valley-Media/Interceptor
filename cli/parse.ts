/**
 * cli/parse.ts — argument parsing utilities shared across command modules
 */

export function parseElementTarget(arg: string): { index?: number; ref?: string; semantic?: { role: string; name: string } } {
  if (/^e\d+$/.test(arg)) return { ref: arg }
  const n = parseInt(arg)
  if (!isNaN(n)) return { index: n }
  const colonIdx = arg.indexOf(":")
  if (colonIdx > 0) {
    return { semantic: { role: arg.slice(0, colonIdx), name: arg.slice(colonIdx + 1) } }
  }
  return { ref: arg }
}

export function parseTabFlag(args: string[]): number | undefined {
  const idx = args.indexOf("--tab")
  if (idx === -1) return undefined
  if (!args[idx + 1]) {
    console.error("error: --tab requires a numeric tab ID")
    process.exit(1)
  }
  const tabId = parseInt(args[idx + 1])
  if (isNaN(tabId)) {
    console.error(`error: --tab requires a numeric tab ID, got '${args[idx + 1]}'`)
    process.exit(1)
  }
  return tabId
}
