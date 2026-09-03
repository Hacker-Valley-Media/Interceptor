// Issue #172: on Linux, scripts/install.sh resolved the browser to a bare name
// (brave, google-chrome) and asked `pgrep -f "$BROWSER_BIN"` whether it was
// running. `-f` matches whole command lines, and the installer's own line
// contains the name (`bash scripts/install.sh --brave …`), so the browser
// always looked running — and the "force restart" `pkill -f` signalled the
// installer itself. The fix routes every check through browser_running /
// kill_browser, whose Linux pattern is anchored to argv[0].
//
// The helper is extracted from the real script text (single source of truth)
// and exercised against live decoy processes with the host's pgrep.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "bun"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SCRIPT = readFileSync(resolve(REPO_ROOT, "scripts/install.sh"), "utf-8")
const HELPER = SCRIPT.match(/browser_pgrep_pattern\(\) \{\n[\s\S]*?\n\}\n/)?.[0]
const CAN_PGREP = process.platform !== "win32"

function pattern(platform: "Linux" | "Darwin", name: string): string {
  if (!HELPER) throw new Error("browser_pgrep_pattern() not found in scripts/install.sh")
  const run = spawnSync(["bash", "-c", `PLATFORM=${platform}\n${HELPER}\nbrowser_pgrep_pattern "$1"`, "bash", name])
  return run.stdout.toString()
}
function pgrepPids(pat: string): number[] {
  const run = spawnSync(["pgrep", "-f", pat])
  return run.stdout.toString().split("\n").filter(Boolean).map(Number)
}

const children: ReturnType<typeof spawn>[] = []
afterAll(() => { for (const c of children) { try { c.kill() } catch {} } })

describe("install.sh browser-running detection (issue #172)", () => {
  test("every browser-running check goes through the helpers; no bare pgrep -f on the binary remains", () => {
    expect(HELPER).toBeDefined()
    expect(SCRIPT).not.toMatch(/pgrep -f "\$BROWSER_BIN"/)
    expect(SCRIPT).not.toMatch(/pgrep -f "\$browser_bin"/)
    expect(SCRIPT).not.toMatch(/pkill -TERM -f "\$BROWSER_BIN"/)
    // write_developer_mode_true, dev-mode auto-enable gate, BROWSER_RUNNING,
    // and the post-kill wait loop → 4 checks; the force-restart path → 1 kill.
    expect(SCRIPT.match(/\bbrowser_running "\$/g)?.length).toBe(4)
    expect(SCRIPT.match(/\bkill_browser "\$/g)?.length).toBe(1)
  })

  test("Linux pattern is anchored to argv[0]; Darwin keeps the .app path verbatim", () => {
    expect(pattern("Linux", "brave")).toBe("^([^ ]*/)?brave")
    expect(pattern("Linux", "google-chrome")).toBe("^([^ ]*/)?google-chrome")
    const app = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    expect(pattern("Darwin", app)).toBe(app)
  })

  test.skipIf(!CAN_PGREP)("the installer's own argv no longer matches; a process launched as the browser still does", async () => {
    // Decoy 1: the reporter's exact shape — a bash process whose command line
    // carries `--brave` (installer argv) but whose argv[0] is bash.
    // (`sleep 20; :` — two commands, so bash forks instead of exec'ing sleep in
    // place, which would drop the installer-shaped argv from the process list.)
    const installer = spawn({ cmd: ["bash", "-c", "sleep 20; :", "bash", "--browser-only", "--brave", "--profile", "Default"], stdout: "ignore", stderr: "ignore" })
    // Decoy 2: a process launched AS the browser — argv[0] is the binary path,
    // as with the real binary or a distro wrapper's `exec -a "$0"`.
    const browser = spawn({ cmd: ["bash", "-c", "exec -a /opt/brave.com/brave/brave sleep 20"], stdout: "ignore", stderr: "ignore" })
    children.push(installer, browser)
    await Bun.sleep(300)

    // The old predicate reproduces the bug: it matches the installer decoy.
    expect(pgrepPids("brave")).toContain(installer.pid)

    const anchored = pattern("Linux", "brave")
    const pids = pgrepPids(anchored)
    expect(pids).not.toContain(installer.pid)
    expect(pids).toContain(browser.pid)
  })
})
