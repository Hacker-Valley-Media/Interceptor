# Interceptor over MCP (`interceptor mcp serve`)

Interceptor exposes its whole surface (browser, macOS, iOS, local) to any
MCP-native client — Claude Desktop, Cursor, Zed, Windsurf, custom agents — as a
small set of typed, safety-gated tools. The MCP server runs **inside** the
`interceptor` binary and shells back out to it for every call, so nothing is
re-implemented and the CLI stays the source of truth.

## Install (one command)

After the pkg is installed, `interceptor` is on your PATH. Register it into every
AI runtime on the machine with:

```sh
interceptor mcp install
```

This auto-detects **Claude Code, Codex, Gemini CLI, Cursor, and Claude Desktop**
and writes the correct config into each — no manual JSON/TOML editing. It's
idempotent (safe to re-run), and because Interceptor is a local binary already on
PATH there's no `npx`, no remote URL, and no auth step. Then restart the client.

```sh
interceptor mcp install --allow destructive,arbitrary-exec  # opt in to risky verbs up front
interceptor mcp install --into claude,codex,gemini          # target specific clients
interceptor mcp install --print                             # just print config snippets, write nothing
interceptor mcp status                                      # show where it's configured
interceptor mcp uninstall                                   # remove the registration
```

`interceptor mcp serve` is what the clients run under the hood (speaks MCP over stdio).

## Tools

| Tool | What it drives |
|---|---|
| `interceptor_browser` | the signed-in browser (DOM, network, tabs, editors, screenshots) |
| `interceptor_macos` | native macOS apps + OS (AX, input, capture, Apple Events, VM, runtime, personal data) |
| `interceptor_ios` | an owned, unlocked, Developer-Mode iPhone |
| `interceptor_read` | read-only observation across surfaces (auto-approvable, `readOnlyHint`) |
| `interceptor_local` | daemon-free meta (`status`, `manifest`, `diagnose`, `extensions`, …) |
| `interceptor_raw` | verbatim `interceptor` argv — **off unless** the operator allows `raw` |

Each router takes a `verb` (from a menu folded into the tool description) and an
`args` string array of sub-verbs/flags passed verbatim to the CLI. Exact flags,
sub-verbs, and return shapes live in the discovery resources:
`interceptor://manifest`, `interceptor://help/macos`, `interceptor://help/ios`,
`interceptor://extensions`, and `interceptor://help/{verb}`.

## Safety — the operator controls the boundary, not the model

Every call is classified into a tier: **read**, **mutate**, **destructive**, or
**arbitrary-exec**. By default **read + mutate run**; **destructive + exec are
refused** until the operator opts in via an environment variable. A model-set
`confirm:true` is only a secondary speed-bump — it can never enable a tier the
operator did not allow.

| Env | Effect |
|---|---|
| `INTERCEPTOR_MCP_ALLOW` | comma list of `destructive`, `arbitrary-exec`, `raw`, `all`, or `surface:verb` (e.g. `macos:vm`). Unset ⇒ only read+mutate. |
| `INTERCEPTOR_MCP_FENCE` | `on` (default) wraps captured page/file/network content in an untrusted-data fence; `off` disables. |
| `INTERCEPTOR_MCP_GROUP` | tab-group for browser isolation (default `mcp-<pid>`). |

Examples:

```sh
# safe default — reads + UI input, nothing irreversible
interceptor mcp serve

# allow irreversible acts (vm delete, app quit, calendar CRUD, share) — each still needs confirm:true
INTERCEPTOR_MCP_ALLOW=destructive interceptor mcp serve

# full power incl. eval / script / runtime / raw passthrough
INTERCEPTOR_MCP_ALLOW=all,raw interceptor mcp serve
```

## Manual client config (if you skip `mcp install`)

`interceptor mcp install` writes all of these for you. They're here only for
reference or unsupported clients (`interceptor mcp install --print` emits them too).

**Claude Code CLI one-liner:** `claude mcp add --scope user interceptor -- interceptor mcp serve`

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "interceptor": {
      "command": "interceptor",
      "args": ["mcp", "serve"],
      "env": { "INTERCEPTOR_MCP_ALLOW": "" }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "interceptor": { "command": "interceptor", "args": ["mcp", "serve"] }
  }
}
```

To enable destructive/exec verbs, set `"env": { "INTERCEPTOR_MCP_ALLOW": "destructive,arbitrary-exec" }`.

## Pairing with a remote search MCP

Interceptor's tools drive your actual signed-in browser, apps, and devices. Some
clients also want a general web-search tool for open-web source discovery, and
the two compose in one config: discover candidate sources remotely, then open
and verify each cited page in the managed browser session with
`interceptor_browser`, so claims are checked against the real page.

For example, You.com publishes a remote MCP server with a keyless profile
(`https://api.you.com/mcp?profile=free` — no API key; it exposes the
`you-search` and `you-discover` tools), so a client that accepts remote MCP
URLs in config can run both servers side by side:

```json
{
  "mcpServers": {
    "interceptor": {
      "command": "interceptor",
      "args": ["mcp", "serve"]
    },
    "you-web": {
      "url": "https://api.you.com/mcp?profile=free"
    }
  }
}
```

Claude Desktop is the exception: `claude_desktop_config.json` only starts local
stdio servers, so keep the `interceptor` entry there and add remote servers
such as You.com through **Settings > Connectors** rather than declaring them
in that file.

Remote servers sit outside Interceptor's permission tiers:
`INTERCEPTOR_MCP_ALLOW` gates only the `interceptor` tools, so review any
second server's own access, auth, and data story before adding it to the same
config.
