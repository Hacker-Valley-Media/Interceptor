// Sentinel values used when running from source (`bun run cli`).
// scripts/build.sh stamps real build values into this file just before
// each `bun build --compile` and restores it afterwards via `git checkout`.
export const VERSION = "2.1.0"
export const BUILD_SHA = "dev"
export const BUILD_DATE = "dev"
