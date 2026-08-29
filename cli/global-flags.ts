/**
 * cli/global-flags.ts — global CLI flag filtering shared by index and tests
 */

export function buildFilteredArgs(args: string[]): string[] {
  const skipIndices = new Set<number>()

  args.forEach((arg, index) => {
    if (arg === "--ws" || arg === "--any-tab" || arg === "--no-group") skipIndices.add(index)
  })

  const tabIdx = args.indexOf("--tab")
  if (tabIdx !== -1) {
    skipIndices.add(tabIdx)
    if (args[tabIdx + 1] !== undefined) skipIndices.add(tabIdx + 1)
  }

  const ctxIdx = args.indexOf("--context")
  if (ctxIdx !== -1) {
    skipIndices.add(ctxIdx)
    if (args[ctxIdx + 1] !== undefined) skipIndices.add(ctxIdx + 1)
  }

  const groupIdx = args.indexOf("--group")
  if (groupIdx !== -1) {
    skipIndices.add(groupIdx)
    if (args[groupIdx + 1] !== undefined) skipIndices.add(groupIdx + 1)
  }

  const groupColorIdx = args.indexOf("--group-color")
  if (groupColorIdx !== -1) {
    skipIndices.add(groupColorIdx)
    if (args[groupColorIdx + 1] !== undefined) skipIndices.add(groupColorIdx + 1)
  }

  return args.filter((arg, index) => {
    if (skipIndices.has(index)) return false
    if (arg === "--json") return index > 1
    return true
  })
}
