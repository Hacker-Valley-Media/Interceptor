// What `interceptor desktop` lacks on Windows and Linux (desktop-support.json). Help, the MCP
// desktop menu and the generated skills (scripts/gen-skills.ts) all read these rows.
import data from "./desktop-support.json"

export type DesktopOs = "win32" | "linux"
export type Support = "yes" | "partial" | "no"
export type SupportRow = {
  family: string
  sub?: string
  flag?: string
  except?: string[]
  win32: Support
  linux: Support
  why: string | Partial<Record<DesktopOs, string>>
  cases?: string[]
}

export const SUPPORT_ROWS = data.rows as SupportRow[]

export function hostDesktopOs(platform: string = process.platform): DesktopOs | undefined {
  return platform === "win32" || platform === "linux" ? platform : undefined
}

export function supportReason(row: SupportRow, os: DesktopOs): string {
  return typeof row.why === "string" ? row.why : row.why[os] ?? ""
}

/** A family this OS cannot use at all (a family row marked `no`, even when one read still answers). */
export function desktopFamilyUnavailable(family: string, os: DesktopOs): boolean {
  return SUPPORT_ROWS.some(r => r.family === family && !r.sub && !r.flag && r[os] === "no")
}

const alternation = (token = "") => /^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(token)

/**
 * Drops help lines (and their wrapped continuation lines) for commands this OS does not have,
 * removes unavailable subcommands from `a|b|c` lists, and removes `[--flag ...]` groups for
 * unavailable flags. Only single-token flags are filtered; a flag value such as
 * `--level always` stays in the help because the flag itself works.
 */
export function filterDesktopHelp(text: string, os: DesktopOs): string {
  const rows = SUPPORT_ROWS.filter(r => r[os] === "no")
  const out: string[] = []
  let dropping = false
  for (const line of text.split("\n")) {
    const m = /^(\s*interceptor desktop )(.*)$/.exec(line)
    if (!m) {
      if (dropping && /^\s{4,}\S/.test(line)) continue
      dropping = false
      out.push(line)
      continue
    }
    const kept = filterLine(m[1], m[2], rows)
    dropping = kept === null
    if (kept !== null) out.push(kept)
  }
  return out.join("\n")
}

function filterLine(prefix: string, rest: string, rows: SupportRow[]): string | null {
  const tokens = rest.split(" ")
  const family = tokens[0]
  const mine = rows.filter(r => r.family === family)
  if (!mine.length) return prefix + rest
  const whole = mine.find(r => !r.sub && !r.flag)
  // Subcommands: the first one or two tokens may be a subcommand or an `a|b|c` list.
  const subRows = mine.filter(r => r.sub && !r.flag)
  const removeSub = (position: number, word: string) => {
    const list = tokens[position].split("|").filter(s => s !== word)
    if (!list.length) return false
    tokens[position] = list.join("|")
    return true
  }
  if (whole) {
    if (!alternation(tokens[1])) return null
    const kept = tokens[1].split("|").filter(s => whole.except?.includes(s))
    if (!kept.length) return null
    tokens[1] = kept.join("|")
  }
  for (const row of subRows) {
    const words = row.sub!.split(" ")
    const last = words.length
    if (!words.slice(0, -1).every((w, i) => tokens[i + 1] === w)) continue
    if (!alternation(tokens[last]) || !tokens[last].split("|").includes(words[last - 1])) continue
    if (!removeSub(last, words[last - 1])) return null
  }
  let line = tokens.join(" ")
  for (const row of mine.filter(r => r.flag && !r.flag.includes(" "))) {
    if (row.sub) {
      const words = row.sub.split(" ")
      if (!words.every((w, i) => (tokens[i + 1] ?? "").split("|").includes(w))) continue
    }
    const flag = row.flag!.replace(/[-]/g, "\\-")
    const bracketed = new RegExp(`\\s*\\[(?:[^\\]\\[]*\\|)?${flag}(?=[\\s\\]|=])[^\\]]*\\]`)
    if (bracketed.test(line)) { line = line.replace(bracketed, ""); continue }
    if (new RegExp(`(^|[\\s|])${flag}(?=[\\s\\]|=]|$)`).test(line)) return null
  }
  return prefix + line
}
