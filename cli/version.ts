// Sentinel values used when running from source (`bun run cli`).
// scripts/build.sh stamps real build values into this file just before
// each `bun build --compile` and restores it afterwards via `git checkout`.
export const VERSION = "2.1.8"
export const BUILD_SHA = "ff15767-dirty"
export const BUILD_DATE = "2026-10-31"
