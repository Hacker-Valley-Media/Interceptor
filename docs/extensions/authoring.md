# Authoring an Interceptor Extension

Interceptor ships as a **capability-blind host**: a CLI, a daemon, a bridge with a
domain registry, an agent loader, and a skill set that know how to *discover*
extensions but nothing about what any specific extension *does*. Operators and
users add capabilities by dropping a self-contained **extension bundle** into a
standard path. Absent any extension, the product is exactly the owned-app audit
tool it ships as.

This guide is neutral: it documents the fabric (discovery, manifest, ABI, skill),
not any particular capability.

## Where extensions live

```
~/.interceptor/extensions/<name>/      # default discovery root
```

Override the root with `INTERCEPTOR_EXTENSIONS_DIR` (used by tests and operators
who keep extensions elsewhere). Discovery is **filesystem-only** — the core never
fetches an extension over the network.

## Bundle layout

```
<name>/
  manifest.json     # neutral capability declaration (schema below)
  bridge/           # optional: DomainHandler dylib(s), dlopen'd at bridge init
  agent/            # optional: agent dylib slices (InterceptorAgent-<slice>.dylib)
  cli/              # optional: reserved for future top-level verb declarations
  skill/            # the extension's OWN SKILL.md (+ references/, workflows/)
  reports/          # optional: extension-private docs (gitignored convention)
```

## `manifest.json`

The manifest declares *what surface* the extension adds — never *how* anything
works.

```json
{
  "name": "audit-tool",
  "version": "1.0.0",
  "bridgeDomains": [
    { "prefix": "auditx", "dylib": "bridge/handler.dylib", "entry": "itc_ext_handle" }
  ],
  "cliVerbs": [
    { "verb": "run", "actionPrefix": "auditx" }
  ],
  "agent": {
    "arm64":  "agent/InterceptorAgent-arm64.dylib",
    "arm64e": "agent/InterceptorAgent-arm64e.dylib"
  },
  "skill": "skill/",
  "capabilities": ["example-audit-surface"]
}
```

Field rules (validated for **shape**, not behavior):

| Field | Rule |
|---|---|
| `name` | `^[a-z][a-z0-9-]*$`; should match the directory name. |
| `version` | non-empty string (semver recommended). |
| `bridgeDomains[].prefix` | a **single lowercase token** `^[a-z][a-z0-9]*$`. An underscore would truncate the `macos_<prefix>_<cmd>` routing key. Must not collide with a built-in domain (the loader reserves the live Router key set). |
| `bridgeDomains[].dylib` | path, relative to the extension dir, of the handler dylib. |
| `bridgeDomains[].entry` | the exported C symbol the bridge calls (see `bridge-abi.md`). |
| `cliVerbs[].verb` | the subcommand, surfaced as `macos <actionPrefix> <verb>`. |
| `cliVerbs[].actionPrefix` | must match a `bridgeDomains[].prefix`. |
| `agent` | object of `slice -> relative path` (`arm64`, `arm64e`, `x86_64`). |
| `skill` | relative path to the extension's own skill directory. |
| `capabilities` | optional neutral, audit-centered tags (reserved; the core does not act on them today). |

A manifest that fails shape validation is **rejected and surfaced** (see
`interceptor extensions list`), never silently dropped.

## How each surface is loaded

| Surface | Mechanism |
|---|---|
| **Bridge domains** | At bridge startup (after all built-ins register), the loader scans manifests, verifies each `bridge/*.dylib` signature in software (`bridge-abi.md` §Signing), `dlopen`s it, resolves the `entry` symbol, wraps it in a `DomainHandler` adapter, and `router.register(prefix, …)`. Failures are isolated + logged, never fatal. |
| **CLI verbs** | The CLI discovers manifest prefixes synchronously at startup and routes `macos <prefix> <cmd>` → `{ type: "macos_<prefix>_<cmd>", sub: <cmd>, args, flags }` to your bridge domain. Hyphens in `<cmd>` normalize to underscores in the type (mirrors the built-in `vm` family). |
| **Agent dylib** | `resolveAgentDylib()` searches `INTERCEPTOR_AGENT_DYLIB`, then each `~/.interceptor/extensions/<name>/agent/`, then `~/.interceptor/native/agent`, then app-support, then the bridge bundle parent. |
| **Skill** | `interceptor extensions sync` symlinks `<name>/skill/` into the host agent skill dirs (`~/.claude/skills`, `~/.agents/skills`, `~/.openclaw/skills`, `~/.config/opencode/skills`) as `interceptor-ext-<name>/`. This is an **explicit, on-demand** verb — the core never silently mutates your home directories. Run `interceptor extensions sync --remove` to undo it (uninstall). |

## Operator commands

```bash
interceptor extensions list            # discovered (+ rejected) extensions
interceptor extensions sync            # link extension skills into host skill dirs
interceptor extensions sync --remove   # remove those links
```

## The capability-blind contract

- The shipped tree contains the loader + neutral interfaces only. A static audit
  (`scripts/audit-capability-blind.sh`, enforced in CI) asserts the tracked tree
  carries no relocated capability specifics, that shipped skills carry only a
  neutral pointer to extensions, and that the core performs no network fetch of
  extensions.
- All capability-specific code, comments, docs, skill text, and reports live
  **inside the extension** — which is neither in the `.pkg` nor in the commit tree.
- The shipped `interceptor` / `interceptor-macos` skills carry only a one-line
  neutral pointer: installed extensions may add capabilities; load their own skill.

## Reference extension (operator-supplied, out-of-repo)

The highest-sensitivity flow — hardened-target managed-copy audit (BYO-identity
re-sign of a managed copy, capability continuity, launch handling) — is **not**
part of this repository or the shipped package. It is delivered as the first
reference extension, `native-managed-copy`, which an operator places in their own
`~/.interceptor/extensions/` (or a private repo). It carries its own bridge
handler, its own agent dylib slices, and its own skill so agents can drive it.
The core's `macos runtime enable` for a hardened target returns guidance pointing
to such an extension; the core itself never re-signs. Distribution of that
extension is the operator's responsibility.

See `bridge-abi.md` for the C entry-point contract and the dylib signing policy.
