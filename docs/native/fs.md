# fs — Native filesystem

`interceptor macos fs {read, write, search}` exposes Foundation `FileManager` + `UTType` reads/writes plus Spotlight (`NSMetadataQuery`) search. Native, structured — no shelling out to `cat` / `bash`.

## fs_read

```bash
interceptor macos fs read /path/to/file
interceptor macos fs read /path/to/file --byte-range 0,4096
interceptor macos fs read /path/to/file --encoding base64    # for binary
```

Returns: `{ path, content, encoding, size, modified, contentType }` where `contentType` is the UTType identifier (e.g. `public.plain-text`, `public.png`).

## fs_write

```bash
interceptor macos fs write /tmp/notes.txt --content "hello world"
interceptor macos fs write /tmp/blob.bin --base64 "aGVsbG8="
interceptor macos fs write /tmp/log.txt --content "next line\n" --append
```

**Hard-coded denylist** (cannot be disabled):

- `/etc/**`
- `/usr/**`
- `/System/**`
- `/private/var/**`

Writes to these paths return `fs_write: refused (denylist)` regardless of permission rules.

## fs_search (Spotlight)

```bash
# Free-text or Spotlight predicate against an absolute path.
interceptor macos fs search "Bun" --scope ~/Documents --limit 25
interceptor macos fs search "kMDItemDisplayName == 'budget*'"

# Multi-root search via --paths (only honored when --scope path).
interceptor macos fs search "*" --scope path --paths /tmp,/var/log --kinds public.folder

# cwd / workspace scope — bridge roots at --cwd (or the CLI's working dir).
interceptor macos fs search "*" --scope cwd --kinds file
```

Wire fields (mirrored by the CLI flags):

- `query` — free-text substring or Spotlight predicate. `*` / `**` is a wildcard listing.
- `--scope` — alias (`everywhere` | `cwd` | `workspace` | `home` | `granted` | `path`) or an absolute path. Default `everywhere`.
- `--paths /a,/b` (or repeated) — multi-root, only with `--scope path`. An empty/missing list errors.
- `--timeout-ms N` (`timeoutMs`, default 10000, floor 200) — deadline for the Spotlight passes. `mdfind` has no timeout of its own and a content search over a large indexed volume can outlive the CLI's transport timeout; the name pass runs first, the content pass second, and when the deadline cuts a pass the result carries `partial: true`, `deadlineMs`, and a `hint` naming the pass that was cut. Results are what arrived in time.
- `--cwd /path` — root for `cwd` / `workspace`. Defaults to the CLI's working directory when omitted.
- `--kinds public.folder,file` — additive UTI / class filter (`directory`, `file`, `public.folder`, etc.).
- `--limit N` — match cap (default 50 from the CLI, 20 from the wire default).

Uses `NSMetadataQuery` against the Spotlight index, then falls back to a bounded breadth-first enumerator if Spotlight returns nothing within the gather window. Wildcard-only queries on rooted scopes return `source: "direct_listing"` with a shallow visible listing instead of running Spotlight.

Results: `{ matches: [{ path, name, kind, size, modified }], indexed, source, scope, query, count }`. `source` is one of `spotlight` (Spotlight returned matches), `fallback` (BFS enumerator), or `direct_listing` (wildcard fast path).
