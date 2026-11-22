// The short help card names the new verbs (agents ran `help` 8 times in the
// 2026-11-21 benchmark and used verify, run, wait conditions and --viewport 0 times), and each OS sees
// only its own verbs: `verify --app` is macOS only.
import { expect, test } from "bun:test"
import { shortHelp } from "../cli/help"

test("the short help card names verify, run -, the condition waits and read --viewport", () => {
  for (const surfaces of [{ macos: true, ios: true }, { macos: false, ios: false }]) {
    const card = shortHelp(surfaces)
    for (const needle of ["verify --text", "verify --file", "run -", "wait --text", "--gone", "--url", "wait --selector", "read --viewport", "expect <verify flags>"]) {
      expect(card).toContain(needle)
    }
    expect(card.length).toBeLessThan(6000)
  }
})

test("verify --app is listed on macOS only", async () => {
  if (process.platform === "darwin") expect(shortHelp({ macos: true, ios: true })).toContain("verify --app")
  const real = process.platform
  Object.defineProperty(process, "platform", { value: "linux" })
  try {
    // A fresh module instance: the per-OS lines are decided when cli/help.ts loads.
    const spec = "../cli/help.ts?platform=linux"
    const linux = await import(spec) as typeof import("../cli/help")
    const card = linux.shortHelp({ macos: false, ios: false })
    expect(card).toContain("verify --file")
    expect(card).not.toContain("verify --app")
    expect(linux.helpForCommand("verify")).not.toContain("--app")
  } finally {
    Object.defineProperty(process, "platform", { value: real })
  }
})
