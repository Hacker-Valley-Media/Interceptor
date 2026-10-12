---
paths:
  - ".agents/skills/**"
  - "shared/desktop-support.json"
---

Every installer ships its own OS's copy of the skills, written by `scripts/gen-skills.ts` (Mac: `scripts/release.sh`; Windows and Linux: `scripts/build.sh`). When you edit a skill:

- A line that is true on only some OSes ends with `<!-- os:darwin -->`, `<!-- os:win32 -->`, `<!-- os:linux -->` or a comma list such as `<!-- os:win32,linux -->`. Put the other OSes' version on the next line with its own tag. A longer passage goes between `<!-- os:… -->` and `<!-- /os -->` on lines of their own.
- In frontmatter, `#os:win32,linux description: "…"` replaces the `description:` line for those OSes.
- Untagged lines ship everywhere. The Mac copy must stay what the Mac skill said before; Windows and Linux copies must not name `interceptor macos`, `interceptor-macos`, `interceptor-ios`, Safari or `--trusted`, and the Windows and Linux copies must not name each other. The generator refuses to write a copy that does.
- What `interceptor desktop` lacks on Windows and Linux lives in `shared/desktop-support.json`, not in skill text. The desktop skill's tables, `desktop --help` and the MCP desktop menu are built from it. Each row cites the parity cases that prove it.

Check with `bun test test/desktop-support.test.ts`; preview a copy with `bun scripts/gen-skills.ts <darwin|win32|linux> /tmp/skills <skill>...`.
