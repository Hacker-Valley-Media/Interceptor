---
paths:
  - "cli/commands/macos.ts"
  - "cli/help.ts"
---

# macOS command parser / help / handler must stay in sync

When you add, rename, or change a flag on a `macos` subcommand, update **all four** places so they cannot drift:

1. the parser payload in `cli/commands/macos.ts` (the flag must be forwarded into the action, **typed to match what the Swift handler reads** — a field the domain casts with `as? Int` must go through `flagInt`, never the generic string flag loop; a mistyped forward is silently dropped by the cast, with no error on either side),
2. the help text in `cli/help.ts` (only advertise flags the parser actually forwards),
3. the Swift handler in `interceptor-bridge/Sources/Domains/` that reads the field,
4. a case in `test/macos-parser.test.ts` asserting the flag is forwarded.

A flag advertised in help but dropped by the parser (or vice-versa) is a silent bug: the user passes it, nothing happens, no error. The parser test is the guard — add or extend a case whenever you touch this surface.
