---
paths:
  - "cli/normalize.ts"
  - "cli/commands/**/*.ts"
---

# CLI flag contract

`cli/normalize.ts` rewrites every browser-surface command to
`[cmd, ...positionals, ...flags]` and rejects flags it does not know. Two
tables ARE the contract; `test/strict-flags.test.ts` walks both.

1. **Adding a flag to a command module means adding it to the table.** A flag
   that consumes the next token goes in `VALUE_FLAGS_BY_CMD` for its family;
   a bare flag goes in `BOOLEAN_FLAGS_BY_CMD`. Missing from the value table:
   the operand is hoisted into the positionals (`window resize --width 800`
   once parsed `800` as a window id). Missing from both: strict mode rejects
   it at runtime and the inventory test fails in CI.
2. **Parsers that sweep text consume the positional span only.** `type` slices
   `filtered.slice(2, positionalCount + 1)`; never `slice(2)` with a filter
   list — that is how `type e1 999 --frame 4897` typed "999 --frame 4897".
3. **Do not special-case the strict check per command.** The only escape is
   `INTERCEPTOR_LAX_FLAGS=1` (warning instead of exit 1). `macos`, `ios`,
   `mcp`, and `update` are outside the map on purpose and stay unnormalized.
4. Update `cli/help.ts` and the skill command catalogs in the same change.
