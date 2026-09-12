import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

const ROOT = resolve(import.meta.dir, "..")
const NOTES = readFileSync(join(ROOT, "docs/release-notes.html"), "utf8")
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function releaseDocument(installedVersion: string): Document {
  document.open()
  document.write(NOTES)
  document.close()
  const installed = document.querySelector(`[data-sparkle-version="${installedVersion}"]`)
  if (!(installed instanceof HTMLElement)) throw new Error(`missing release ${installedVersion}`)
  installed.classList.add("sparkle-installed-version")
  return document
}

function visibleVersions(document: Document): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("main > section[data-sparkle-version]"))
    .filter((section) => section.ownerDocument.defaultView?.getComputedStyle(section).display !== "none")
    .map((section) => section.dataset.sparkleVersion ?? "")
}

describe("cumulative Sparkle release notes", () => {
  test("one-version-behind shows only the target release", () => {
    expect(visibleVersions(releaseDocument("0.26.4"))).toEqual(["0.26.5"])
  })

  test("five-versions-behind shows exactly the five newer releases", () => {
    expect(visibleVersions(releaseDocument("0.24.13"))).toEqual([
      "0.26.5", "0.26.4", "0.26.2", "0.26.1", "0.25.0",
    ])
  })

  test("has unique newest-first versions and no remote assets or scripts", () => {
    document.open()
    document.write(NOTES)
    document.close()
    const versions = Array.from(document.querySelectorAll<HTMLElement>("main > section[data-sparkle-version]"))
      .map((section) => section.dataset.sparkleVersion ?? "")
    const key = (version: string) => version.split(".").map(Number)
    const descending = [...versions].sort((a, b) => {
      const left = key(a), right = key(b)
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const difference = (right[i] ?? 0) - (left[i] ?? 0)
        if (difference) return difference
      }
      return 0
    })
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toEqual(descending)
    expect(document.querySelector("script, link[rel=stylesheet], img, iframe")).toBeNull()
  })
})

type PublishFixture = {
  root: string
  host: string
  signLog: string
  run: (version: string) => ReturnType<typeof spawnSync>
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

function notesHtml(versions: string[]): string {
  return `<!doctype html><html><body><main>${versions.map((version) =>
    `<section data-sparkle-version="${version}"><h2>${version}</h2></section>`
  ).join("")}</main></body></html>`
}

function appcast(version = "1.0.0"): string {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Interceptor</title><link>https://example.test</link><description>test</description><language>en</language><item><title>old</title><sparkle:shortVersionString>${version}</sparkle:shortVersionString></item></channel></rss>`
}

function makePublishFixture(versions: string[], retainedVersion = "1.0.0"): PublishFixture {
  const root = mkdtempSync(join(tmpdir(), "interceptor-publish-test-"))
  temporaryDirectories.push(root)
  const host = join(root, "host")
  const tools = join(root, "tools")
  const fakeBin = join(root, "fake-bin")
  const signLog = join(root, "sign.log")
  for (const dir of [join(root, "scripts"), join(root, "docs"), join(root, "dist/release"), join(host, "public"), join(tools, "bin"), fakeBin]) {
    mkdirSync(dir, { recursive: true })
  }
  copyFileSync(join(ROOT, "scripts/publish-sparkle.sh"), join(root, "scripts/publish-sparkle.sh"))
  writeFileSync(join(root, "docs/release-notes.html"), notesHtml(versions))
  writeFileSync(join(host, "public/appcast.xml"), appcast(retainedVersion))
  writeExecutable(join(fakeBin, "spctl"), "#!/bin/sh\nexit 0\n")
  writeExecutable(join(fakeBin, "xcrun"), "#!/bin/sh\nexit 0\n")
  writeExecutable(join(fakeBin, "pkgutil"), "#!/bin/sh\nif [ \"$1\" = \"--expand-full\" ]; then mkdir -p \"$3/Interceptor-Bridge.pkg/Payload/Applications/interceptor-bridge.app/Contents\"; : > \"$3/Interceptor-Bridge.pkg/Payload/Applications/interceptor-bridge.app/Contents/Info.plist\"; fi\nexit 0\n")
  writeExecutable(join(fakeBin, "plutil"), "#!/bin/sh\necho 13.0\n")
  writeExecutable(join(tools, "bin/sign_update"), "#!/bin/sh\nprintf '%s\\n' \"$(basename \"$1\")\" >> \"$SIGN_LOG\"\nsize=$(wc -c < \"$1\" | tr -d ' ')\nprintf 'sparkle:edSignature=\"sig-%s\" length=\"%s\"\\n' \"$(basename \"$1\")\" \"$size\"\n")

  const addPackages = (version: string): void => {
    for (const mode of ["Browser", "Full"]) writeFileSync(join(root, `dist/release/Interceptor-${mode}-${version}.pkg`), `${mode}-${version}`)
  }
  for (const version of new Set(versions)) addPackages(version)

  return {
    root,
    host,
    signLog,
    run: (version: string) => spawnSync("bash", ["scripts/publish-sparkle.sh", `--version=${version}`, "--no-deploy", "--no-tag"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SIGN_LOG: signLog,
        INTERCEPTOR_SPARKLE_HOST_DIR: host,
        INTERCEPTOR_SPARKLE_TOOLS_DIR: tools,
        INTERCEPTOR_DOWNLOAD_URL_PREFIX: "https://updates.example.test/",
      },
    }),
  }
}

const output = (result: ReturnType<typeof spawnSync>): string => `${result.stdout ?? ""}${result.stderr ?? ""}`

describe("Sparkle release-note publisher", () => {
  test("rejects a missing target-version section", () => {
    const fixture = makePublishFixture(["1.0.0"])
    writeFileSync(join(fixture.root, "dist/release/Interceptor-Browser-2.0.0.pkg"), "browser")
    writeFileSync(join(fixture.root, "dist/release/Interceptor-Full-2.0.0.pkg"), "full")
    const result = fixture.run("2.0.0")
    expect(result.status).not.toBe(0)
    expect(output(result)).toContain("no section for target version 2.0.0")
  })

  test("rejects a missing retained-version section", () => {
    const fixture = makePublishFixture(["2.0.0"])
    const result = fixture.run("2.0.0")
    expect(result.status).not.toBe(0)
    expect(output(result)).toContain("omit retained appcast version(s): 1.0.0")
  })

  test("rejects duplicate version sections", () => {
    const fixture = makePublishFixture(["2.0.0", "2.0.0", "1.0.0"])
    const result = fixture.run("2.0.0")
    expect(result.status).not.toBe(0)
    expect(output(result)).toContain("duplicate release-note version section(s): 2.0.0")
  })

  test("rejects release sections that are not newest first", () => {
    const fixture = makePublishFixture(["1.0.0", "2.0.0"])
    const result = fixture.run("2.0.0")
    expect(result.status).not.toBe(0)
    expect(output(result)).toContain("must be ordered newest first")
  })

  test("publishes both modes with one signed immutable notes snapshot", () => {
    const fixture = makePublishFixture(["2.0.0", "1.0.0"])
    const first = fixture.run("2.0.0")
    expect(first.status, output(first)).toBe(0)
    const feedPath = join(fixture.host, "public/appcast.xml")
    const feedBefore = readFileSync(feedPath, "utf8")
    const noteLinks = [...feedBefore.matchAll(/<sparkle:releaseNotesLink[^>]*>([^<]+)<\/sparkle:releaseNotesLink>/g)]
    expect(noteLinks).toHaveLength(2)
    expect(noteLinks.map((match) => match[1])).toEqual([
      "https://updates.example.test/release-notes-2.0.0.html",
      "https://updates.example.test/release-notes-2.0.0.html",
    ])
    expect(noteLinks.every((match) => match[0].includes("sparkle:edSignature=") && match[0].includes("length="))).toBe(true)
    const signCalls = readFileSync(fixture.signLog, "utf8").trim().split("\n")
    expect(signCalls.filter((name) => name === "release-notes-2.0.0.html")).toHaveLength(1)

    const oldSnapshot = readFileSync(join(fixture.host, "public/release-notes-2.0.0.html"))
    writeFileSync(join(fixture.root, "docs/release-notes.html"), notesHtml(["2.0.0", "1.0.0"]).replace("</main>", "<p>changed</p></main>"))
    const changedRepublish = fixture.run("2.0.0")
    expect(changedRepublish.status).not.toBe(0)
    expect(output(changedRepublish)).toContain("immutable release-note snapshot differs for version 2.0.0")
    expect(readFileSync(join(fixture.host, "public/release-notes-2.0.0.html"))).toEqual(oldSnapshot)

    const oldLink = feedBefore.match(/<sparkle:releaseNotesLink[^>]*>https:\/\/updates\.example\.test\/release-notes-2\.0\.0\.html<\/sparkle:releaseNotesLink>/)?.[0]
    writeFileSync(join(fixture.root, "docs/release-notes.html"), notesHtml(["3.0.0", "2.0.0", "1.0.0"]))
    for (const mode of ["Browser", "Full"]) writeFileSync(join(fixture.root, `dist/release/Interceptor-${mode}-3.0.0.pkg`), mode)
    const second = fixture.run("3.0.0")
    expect(second.status, output(second)).toBe(0)
    expect(readFileSync(join(fixture.host, "public/release-notes-2.0.0.html"))).toEqual(oldSnapshot)
    expect(readFileSync(feedPath, "utf8")).toContain(oldLink ?? "missing-old-link")
  })
})

describe("macOS package conclusion extension routes", () => {
  const identities = JSON.parse(readFileSync(join(ROOT, "extension/store-identities.json"), "utf8")) as { chrome: { listingUrl: string } }
  const browser = readFileSync(join(ROOT, "scripts/release/Resources/conclusion-browser.html"), "utf8")
  const full = readFileSync(join(ROOT, "scripts/release/Resources/conclusion-full.html"), "utf8")

  test("Browser conclusion has the store route and exact unpacked route", () => {
    expect(browser).toContain(`href="${identities.chrome.listingUrl}"`)
    expect(browser).toContain('target="_blank" rel="noopener noreferrer"')
    expect(browser).toContain("Install from the Chrome Web Store")
    expect(browser).toContain("Install as an unpacked extension")
    expect(browser).toContain("/Library/Application Support/Interceptor/extension")
    expect(browser).toContain("Keep only one Interceptor extension copy")
    expect(browser).toContain("Open the Interceptor Chrome Web Store listing")
    expect(browser).toContain("prefers-color-scheme: dark")
  })

  test("Full conclusion has the store route and exact unpacked route", () => {
    expect(full).toContain(`href="${identities.chrome.listingUrl}"`)
    expect(full).toContain('target="_blank" rel="noopener noreferrer"')
    expect(full).toContain("Install from the Chrome Web Store")
    expect(full).toContain("Install as an unpacked extension")
    expect(full).toContain("/Library/Application Support/Interceptor/extension")
    expect(full).toContain("Keep only one Interceptor extension copy")
    expect(full).toContain("Open the Interceptor Chrome Web Store listing")
    expect(full).toContain("prefers-color-scheme: dark")
  })

  test("store URL stays in parity and packages do not mutate browser profiles", () => {
    for (const file of ["distribution-browser.xml", "distribution.xml"]) {
      expect(readFileSync(join(ROOT, `scripts/release/${file}`), "utf8")).toContain('customize="never"')
    }
    for (const file of ["postinstall-browser", "postinstall-full"]) {
      const script = readFileSync(join(ROOT, `scripts/release/${file}`), "utf8")
      expect(script).not.toMatch(/External Extensions|chrome-extension|Preferences/)
    }
  })

  test("opens the Store only for a first package install", () => {
    const preinstall = readFileSync(join(ROOT, "scripts/release/preinstall-extension-store"), "utf8")
    const release = readFileSync(join(ROOT, "scripts/release.sh"), "utf8")
    expect(preinstall).toContain("pkgutil --pkg-info com.interceptor.daemon.pkg")
    expect(preinstall).toContain('STATE_DIR="/Library/Application Support/Interceptor"')
    expect(preinstall).toContain(".open-extension-store-$TARGET_UID")
    expect(preinstall).toContain("install -d -o root -g wheel -m 755")
    expect(preinstall).not.toContain("/tmp/interceptor-open-extension-store")
    expect(release.match(/PREINSTALL_EXTENSION_STORE/g)?.length).toBeGreaterThanOrEqual(3)
    for (const file of ["postinstall-browser", "postinstall-full"]) {
      const script = readFileSync(join(ROOT, `scripts/release/${file}`), "utf8")
      expect(script).toContain(".open-extension-store-$TARGET_UID")
      expect(script).toContain(identities.chrome.listingUrl)
      expect(script).toContain('if [[ -n "$TARGET_UID" && -f "$STORE_MARKER" ]]')
    }
  })
})
