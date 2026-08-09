---
paths:
  - "cli/commands/mcp.ts"
  - "cli/mcp/server.ts"
  - "cli/mcp/tiers.ts"
  - "cli/mcp/adapter.ts"
  - "cli/mcp/output.ts"
  - "cli/mcp/install.ts"
  - "package.json"
  - "patches/**"
---

# MCP control plane contract

`interceptor mcp serve` exposes the whole CLI surface to MCP clients as a small
set of typed, safety-gated tools. These files implement one contract — keep the
invariants; extend `test/mcp-*.test.ts` whenever you touch this surface.

1. **The CLI is the source of truth; the server re-implements nothing.** Every
   tool call shells back out to the same `interceptor` binary via
   `runInterceptor` (`adapter.ts`), so arg parsing, compound fan-out, group
   injection, daemon auto-spawn, and result formatting are inherited. Never speak
   the daemon socket directly from the MCP layer.

2. **Six tools, verb enums from the binary.** `interceptor_browser/macos/ios/read/
   local/raw` (`server.ts`). Browser/local enums come from `COMMAND_SPECS`; macOS/
   iOS menus are maintained lists; sub-verbs + flags ride in the `args` array and
   are documented in the `interceptor://…` discovery resources. Add a new verb →
   it appears automatically for browser/local; update the macOS/iOS menu lists.

3. **The operator owns the safety boundary, never the model.** `tiers.ts`
   classifies every call as read/mutate/destructive/exec by (surface, verb,
   sub-verb), with fail-safe family floors (an unknown `vm`/`runtime`/`app`
   sub-verb defaults to its highest tier). read+mutate run by default;
   destructive+exec are refused unless `INTERCEPTOR_MCP_ALLOW` (operator env)
   permits the tier/verb, and then still require a `confirm:true` speed-bump.
   `interceptor_raw` is off unless `raw` is allowed. Do not weaken this to a
   model-set gate.

4. **Inbound content is fenced.** `output.ts` wraps content-bearing verb output
   (page text, trees, file/network reads) in an untrusted-data fence
   (`INTERCEPTOR_MCP_FENCE`, default on) so a client model treats captured page
   content as data, not instructions.

5. **`interceptor mcp install` is the setup path.** It auto-detects and writes
   config for Claude Code, Codex, Gemini CLI, Cursor, and Claude Desktop
   (`install.ts`); the command self-locates via `process.execPath`. Merges are
   idempotent and preserve unrelated config. Never tell a user to hand-edit JSON.

6. **The MCP SDK ships patched — never drop `patchedDependencies`.** The SDK's
   stdio transports import `node:process`, which triggers a Bun `--compile` bug
   (present through at least Bun 1.3.14): any compiled binary bundling that
   import silently truncates piped stdout at 64 KiB on exit — for every verb,
   even though the SDK only loads for `mcp serve` (issue #183). The patch in
   `patches/` rewrites those imports to the `process` global and is applied via
   `package.json` `"patchedDependencies"`. Bun keys patches to the exact package
   version, so bumping `@modelcontextprotocol/sdk` requires regenerating the
   patch (`bun patch` → re-apply the edit → `bun patch --commit`), not deleting
   it. `test/compiled-stdout-pipe.test.ts` fails if the patch is missing or
   ineffective.
