// The last whole-page tree per read settings, as trimmed ref lines.
// Its own module: content.ts is a classic content script and must export nothing.
const lastTreeLines = new Map<string, Set<string>>()
const REF_LINE = /\[e\d+(?:_\d+)?[\]|]/

/** Ref lines new since the previous read with the same key; null when there is none. */
export function newTreeLines(key: string, tree: string): string[] | null {
  const lines = tree.split("\n").map(l => l.trim()).filter(l => REF_LINE.test(l))
  const before = lastTreeLines.get(key)
  lastTreeLines.set(key, new Set(lines))
  return before ? lines.filter(l => !before.has(l)) : null
}
