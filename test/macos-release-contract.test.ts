import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const read = (path: string) => readFileSync(resolve(root, path), "utf-8")

describe("macOS release contract", () => {
  // release.sh runs build.sh for the release host, and the macOS packages are
  // built on Apple silicon, so the CLI, daemon, and bridge they install are
  // arm64-only. hostArchitectures is what Installer checks before it installs:
  // with x86_64 listed, an Intel Mac installs binaries that cannot run there.
  // Add x86_64 back only when every executable in the payload is universal.
  test.each(["scripts/release/distribution.xml", "scripts/release/distribution-browser.xml"])(
    "%s lets Installer run only on Apple silicon",
    (path) => {
      // Read the attribute on <options>; the comment above it names the same attribute.
      const xml = read(path).replace(/<!--[\s\S]*?-->/g, "")
      const hostArchitectures = xml.match(/<options\b[^>]*\bhostArchitectures="([^"]*)"/)?.[1]
      expect(hostArchitectures).toBe("arm64")
    },
  )
})
