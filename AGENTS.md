# interceptor

This repository now uses `AGENTS.md` as the canonical agent-instructions file.

For user-facing command reference, examples, and workflows, see [README.md](README.md).  
For implementation details, see [ARCHITECTURE.md](ARCHITECTURE.md).  
For change rationale, see [prd/](prd/).

## Working Rules

- Prefer `./dist/interceptor ...` when working inside this repo and the binary is not on `PATH`.
- Prefer Interceptor compound commands first: `open`, `read`, `act`, `inspect`.
- Prefer structured read surfaces over screenshots unless pixels are the task.
- Treat `eN` refs as short-lived and recover with `read` or `find` after DOM changes.
- Use `eval --main` only when the built-in command surface is not enough.
- On strict-CSP sites, `eval --main` may need Interceptor's automatic reload/retry fallback before page-world code succeeds.
- For rich editors, start with `scene profile` before assuming scene support.
- For native apps, start with `interceptor macos open`, `read`, `act`, and `inspect`.
- Do not default to explaining or debugging Interceptor unless the task is specifically about Interceptor itself.

## Compatibility

`CLAUDE.md` is retained as a compatibility file for tools that still look for that filename, but `AGENTS.md` is the source of truth going forward.
