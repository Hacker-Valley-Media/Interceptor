import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join, resolve } from "node:path"
import { captureShell } from "./helpers/shell-capture"

// macOS 27 denies writes into a browser's Application Support folder when that
// browser is not installed. A read-only Google folder reproduces the denial.
const home = mkdtempSync(join(tmpdir(), "postinstall-links-"))
const support = join(home, "Library/Application Support")
mkdirSync(join(support, "BraveSoftware/Brave-Browser"), { recursive: true })
mkdirSync(join(support, "Google"), { recursive: true })
chmodSync(join(support, "Google"), 0o500)
afterAll(() => {
  chmodSync(join(support, "Google"), 0o700)
  rmSync(home, { recursive: true, force: true })
})

for (const pkg of ["full", "browser"]) {
  const script = readFileSync(resolve(import.meta.dir, `../scripts/release/postinstall-${pkg}`), "utf8")
  const start = script.indexOf("# ── Symlink manifest into Chrome + Brave")
  const block = script.slice(start, script.indexOf("\n\n#", start))

  describe(`${pkg} postinstall native host links`, () => {
    test("a browser folder macOS refuses is skipped, not fatal", () => {
      const brave = join(support, "BraveSoftware/Brave-Browser/NativeMessagingHosts")
      rmSync(brave, { recursive: true, force: true })
      const result = captureShell("/bin/bash", ["-s"], {
        input: `set -euo pipefail\nlog_install() { echo "$*" >&2; }\n${block}\necho done\n`,
        timeout: 5000,
        env: { ...process.env, TARGET_HOME: home, TARGET_USER: userInfo().username, RENDERED_MANIFEST: "/manifest.json" },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe("done\n")
      expect(result.stderr).toContain("Google/Chrome/NativeMessagingHosts")
      expect(readlinkSync(join(brave, "com.interceptor.host.json"))).toBe("/manifest.json")
      expect(existsSync(join(support, "Google/Chrome"))).toBe(false)
    })
  })
}
