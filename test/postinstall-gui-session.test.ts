import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { captureShell } from "./helpers/shell-capture"

// Exercise the shipped user-selection block without executing installation.
const mocks = `
stat() { printf '%s\\n' "$FIXTURE_CONSOLE_USER"; }
who() { printf '%s\\n' "$FIXTURE_LOGIN_RECORDS"; }
id() { case "$2" in alice) echo 501;; second) echo 502;; root) echo 0;; *) return 1;; esac; }
launchctl() { case "$2" in gui/501) [[ "$FIXTURE_GUI_DOMAINS" == *501* ]];; gui/502) [[ "$FIXTURE_GUI_DOMAINS" == *502* ]];; *) return 1;; esac; }
log_install() { :; }
`

for (const pkg of ["full", "browser"]) {
  const script = readFileSync(resolve(import.meta.dir, `../scripts/release/postinstall-${pkg}`), "utf8")
  const selection = script.slice(script.indexOf("# ── Identify the installing user"), script.indexOf("TARGET_HOME="))

  describe(`${pkg} postinstall GUI session selection`, () => {
    test("does not trust /dev/console ownership alone", () => {
      expect(selection).toContain('TARGET_USER="$(resolve_installing_gui_user || true)"')
      expect(selection).not.toContain('TARGET_USER="$(stat -f')
    })

    for (const fixture of [
      { name: "console owner with a live GUI domain", console: "alice", logins: "", domains: "501", user: "alice" },
      { name: "root console with a unique live console login", console: "root", logins: "alice console Oct 2 11:08", domains: "501", user: "alice" },
      { name: "loginwindow ownership with a live console login", console: "loginwindow", logins: "alice console Oct 2 11:08", domains: "501", user: "alice" },
      { name: "duplicate records for the same login", console: "root", logins: "alice console Oct 2 11:08\nalice console Oct 2 11:08", domains: "501", user: "alice" },
      { name: "headless installation", console: "root", logins: "", domains: "", user: "" },
      { name: "stale login without a GUI domain", console: "root", logins: "alice console Oct 2 11:08", domains: "", user: "" },
      { name: "SSH login is not a console login", console: "root", logins: "alice ttys001 Oct 2 11:08", domains: "501", user: "" },
      { name: "ambiguous console logins", console: "root", logins: "alice console Oct 2 11:08\nsecond console Oct 2 11:08", domains: "501 502", user: "" },
    ]) {
      test(fixture.name, () => {
        const result = captureShell("/bin/bash", ["-s"], {
          input: mocks + selection + '\nprintf "%s" "$TARGET_USER"\n',
          timeout: 5000,
          env: { ...process.env, USER: "root", FIXTURE_CONSOLE_USER: fixture.console, FIXTURE_LOGIN_RECORDS: fixture.logins, FIXTURE_GUI_DOMAINS: fixture.domains },
        })
        expect(result.status).toBe(0)
        expect(result.stderr).toBe("")
        expect(result.stdout).toBe(fixture.user)
      })
    }
  })
}
