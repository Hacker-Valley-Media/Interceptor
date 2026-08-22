import { describe, expect, test } from "bun:test"
import { isSkillRead, parseCodexJsonl } from "./usage"

const READS = [
  `/bin/zsh -lc "sed -n '1,240p' /x/bench-head-to-head/.codex-homes/interceptor/skills/.system/interceptor-browser/SKILL.md"`,
  `/bin/zsh -lc "sed -n '241,520p' /x/bench-head-to-head/.codex-homes/axi/skills/axi/SKILL.md"`,
  `/bin/zsh -lc "sed -n '1,240p' /Users/me/.agents/skills/interceptor-browser/SKILL.md"`,
  `/bin/zsh -lc 'cat /Users/me/.agents/skills/interceptor-browser/workflows/read-and-extract.md'`,
  `/bin/zsh -lc "pwd && sed -n '1,240p' /Users/me/.agents/skills/interceptor-browser/SKILL.md"`,
  // quoted pipes must not shatter the segment (P3/P7 mis-invalidation, 2026-08-21)
  `/bin/zsh -lc 'rg -n -A8 -B4 "query <|query " /Users/me/.agents/skills/interceptor-browser/references/command-catalog.md'`,
  String.raw`/bin/zsh -lc "rg --files /Users/me/.agents/skills/interceptor-browser | rg '(^|/)SKILL\.md$'"`,
  // verbatim from the P7 2026-08-21 artifact: codex re-renders zsh quoting into concatenated fragments
  String.raw`/bin/zsh -lc "rg --files /Users/me/.agents/skills/interceptor-browser | rg '("'^|/)SKILL'"\\.md"'$'"'"`,
]
const BROWSER = [
  `/bin/zsh -lc 'interceptor --context chrome open https://example.com --text-only'`,
  `/bin/zsh -lc 'chrome-devtools-axi open https://example.com && chrome-devtools-axi snapshot'`,
  `/bin/zsh -lc "sed -n '1,40p' /x/skills/axi/SKILL.md && chrome-devtools-axi pages"`,
  `/bin/zsh -lc 'cat /x/bench-head-to-head/fixtures/spa-lab/index.html'`,
  // path-executed commands chained after a skill read must stay commands, not shrapnel
  `/bin/zsh -lc 'cat /Users/me/.agents/skills/interceptor-browser/SKILL.md && /bin/interceptor open https://example.com'`,
  `/bin/zsh -lc 'cat /Users/me/.agents/skills/interceptor-browser/SKILL.md && ./interceptor open https://example.com'`,
  `/bin/zsh -lc 'cat /Users/me/.agents/skills/interceptor-browser/SKILL.md && ~/bin/interceptor open https://example.com'`,
]

describe("isSkillRead", () => {
  test("read-only skill doc views are exempt", () => {
    for (const cmd of READS) expect(isSkillRead(cmd)).toBe(true)
  })
  test("browser commands, mixed chains, and non-skill reads are not", () => {
    for (const cmd of BROWSER) expect(isSkillRead(cmd)).toBe(false)
  })
  test("parseCodexJsonl splits the logs and counts only browser commands", () => {
    const raw = [...READS, ...BROWSER]
      .map((command) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } }))
      .join("\n")
    const usage = parseCodexJsonl(raw, 1)
    expect(usage.command_count).toBe(BROWSER.length)
    expect(usage.command_log).toEqual(BROWSER)
    expect(usage.skill_read_log).toEqual(READS)
  })
  test("telemetry classification tolerates --context between interceptor and the verb", () => {
    const raw = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'interceptor --context chrome net log --limit 5'" } })
    expect(parseCodexJsonl(raw, 1).interceptor_telemetry?.net_log_count).toBe(1)
  })
})
