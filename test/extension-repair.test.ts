import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { captureShell } from "./helpers/shell-capture"
import { deriveChromiumExtensionId } from "../scripts/installer/generate-native-host"
import { classify } from "../cli/mcp/tiers"
import {
  LEGACY_DEVELOPMENT_EXTENSION_ID as OLD,
  LEGACY_DEVELOPMENT_PUBLIC_KEY,
  STORE_EXTENSION_ID as NEW,
} from "../shared/extension-identity"
import identities from "../extension/store-identities.json"
import { classifyProfile, findProblems, hadOldInstall, instancePid, manualStep, report, REPAIR_BROWSERS, takeLock, type Finding, type RepairBrowser } from "../cli/lib/extension-repair"
import { legacyDevelopmentCopyLine } from "../cli/commands/diagnose"
import { guidePage } from "../cli/lib/extension-welcome"
import { dialogPage, rich } from "../cli/lib/hvm-window"

const root = mkdtempSync(join(tmpdir(), "extension-repair-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const brave = REPAIR_BROWSERS.find(b => b.key === "brave")!
const chrome = REPAIR_BROWSERS.find(b => b.key === "chrome")!

// Folders and the ID their manifest derives, the way Chromium sees them.
const SHARED = "/Library/Application Support/Interceptor/extension" // now holds the store key
const LEGACY = "/Library/Application Support/Interceptor/extension-legacy"
const STORE_DIR = `${NEW}/2.1.4_0` // a Chrome Web Store install lives inside the profile
const ids: Record<string, string> = { [SHARED]: NEW, [LEGACY]: OLD }
const unpacked = (path: string) => ({ location: 4, path })
const commandLine = (path: string) => ({ location: 8, path })
const kinds = (settings: Record<string, unknown>, browser = brave, enhancedSafeBrowsing = false) =>
  classifyProfile(browser, "Default", "Work", settings, { idOf: d => ids[d] ?? null, enhancedSafeBrowsing, legacyDir: LEGACY })
    .map(f => `${f.kind}:${f.extensionId === OLD ? "old" : "new"}:${f.autoFix}`)

describe("classifyProfile: every state a user's profile can be in", () => {
  const darwin = process.platform === "darwin"

  test("both IDs on the shared folder: lost at every start; a restart fixes it where --load-extension works", () => {
    expect(kinds({ [OLD]: unpacked(SHARED), [NEW]: unpacked(SHARED) })).toEqual([`both-ids:old:${darwin}`])
    expect(kinds({ [OLD]: unpacked(SHARED), [NEW]: unpacked(SHARED) }, chrome)).toEqual(["both-ids:old:false"])
    expect(kinds({ [OLD]: unpacked(SHARED), [NEW]: unpacked(SHARED) }, brave, true)).toEqual(["both-ids:old:false"])
  })

  test("only the old-ID entry: nothing has loaded since the update; fixed by hand", () => {
    expect(kinds({ [OLD]: unpacked(SHARED) })).toEqual(["old-id-only:old:false"])
  })

  test("a working store copy next to the dead old entry is harmless: nothing reported", () => {
    expect(kinds({ [OLD]: unpacked(SHARED), [NEW]: { location: 1, path: STORE_DIR } })).toEqual([])
  })

  test("a --load-extension load only (scripts/install.sh) lasts one session", () => {
    expect(kinds({ [NEW]: commandLine(SHARED) })).toEqual(["session:new:false"])
  })

  test("both copies loading persistently: Interceptor runs twice", () => {
    expect(kinds({ [OLD]: unpacked(LEGACY), [NEW]: unpacked(SHARED) })).toEqual(["two-copies:old:false"])
    expect(kinds({ [OLD]: unpacked(LEGACY), [NEW]: { location: 1, path: STORE_DIR } })).toEqual(["two-copies:old:false"])
  })

  test("the states each fix leaves behind are all clean", () => {
    // Restart fix: the old entry becomes a command-line load on extension-legacy.
    expect(kinds({ [OLD]: commandLine(LEGACY), [NEW]: unpacked(SHARED) })).toEqual([])
    // That inert entry alone (a profile that never had Interceptor) is not a session finding.
    expect(kinds({ [OLD]: commandLine(LEGACY) })).toEqual([])
    // Old-ID-only fixed by hand: the old ID now loads from extension-legacy.
    expect(kinds({ [OLD]: unpacked(LEGACY) })).toEqual([])
    // Both-IDs fixed by hand: old card removed.
    expect(kinds({ [NEW]: unpacked(SHARED) })).toEqual([])
    // Store users who never loaded unpacked.
    expect(kinds({ [NEW]: { location: 1, path: STORE_DIR } })).toEqual([])
  })

  test("switched off by the user is a choice, not a problem; switched off for reload comes back on", () => {
    expect(kinds({ [OLD]: unpacked(SHARED), [NEW]: { location: 1, path: STORE_DIR, disable_reasons: [1] } })).toEqual([])
    expect(kinds({ [OLD]: { ...unpacked(LEGACY), disable_reasons: [4] }, [NEW]: unpacked(SHARED) })).toEqual(["two-copies:old:false"])
    expect(kinds({ [OLD]: { ...unpacked(LEGACY), disable_reasons: [1] }, [NEW]: unpacked(SHARED) })).toEqual([])
  })

  test("an entry whose folder is gone is not ours to fix", () => {
    expect(kinds({ [OLD]: unpacked("/gone") })).toEqual([])
  })
})

describe("findProblems reads real profile files", () => {
  test("profiles the browser no longer lists are skipped; Enhanced Safe Browsing blocks the restart", () => {
    const shared = join(root, "extension"), legacy = join(root, "extension-legacy")
    for (const [dir, key] of [[shared, identities.chrome.publicKey], [legacy, LEGACY_DEVELOPMENT_PUBLIC_KEY]]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "Interceptor", key }))
    }
    const udd = join(root, "brave")
    const profile = (dir: string, settings: object, prefs: object = {}) => {
      mkdirSync(join(udd, dir), { recursive: true })
      writeFileSync(join(udd, dir, "Secure Preferences"), JSON.stringify({ extensions: { settings } }))
      writeFileSync(join(udd, dir, "Preferences"), JSON.stringify(prefs))
    }
    mkdirSync(udd, { recursive: true })
    writeFileSync(join(udd, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Work" }, "Profile 1": { name: "Safe" } } } }))
    profile("Default", { [OLD]: unpacked(shared), [NEW]: unpacked(shared) })
    profile("Profile 1", { [OLD]: unpacked(shared), [NEW]: unpacked(shared) }, { safebrowsing: { enhanced: true } })
    profile("Profile 9", { [OLD]: unpacked(shared), [NEW]: unpacked(shared) }) // deleted profile's leftover folder
    const env = { ...process.env }
    for (const b of REPAIR_BROWSERS) process.env[b.overrideEnv] = join(root, "none")
    process.env.INTERCEPTOR_BRAVE_USER_DATA = udd
    process.env.INTERCEPTOR_LEGACY_EXTENSION_DIR = legacy
    try {
      const found = findProblems().map(f => `${f.profileDir}:${f.kind}:${f.autoFix}`).sort()
      expect(found).toEqual([`Default:both-ids:${process.platform === "darwin"}`, "Profile 1:both-ids:false"])
    } finally {
      process.env = env
    }
  })

  // macOS 27 refuses Chrome/Brave/Edge data to a process without Full Disk Access
  // (the installer's and Sparkle's); an unread browser must not count as clean.
  test.skipIf(process.getuid?.() === 0)("a browser folder it may not read is reported, never called clean", () => {
    const udd = join(root, "locked-brave")
    mkdirSync(udd, { recursive: true })
    chmodSync(udd, 0o000)
    const env = { ...process.env }
    for (const b of REPAIR_BROWSERS) process.env[b.overrideEnv] = join(root, "none")
    process.env.INTERCEPTOR_BRAVE_USER_DATA = udd
    try {
      const blocked: RepairBrowser[] = []
      expect(findProblems(undefined, blocked)).toEqual([])
      expect(blocked.map(b => b.key)).toEqual(["brave"])
      const text = report([], blocked)
      expect(text).toContain("could not check Brave")
      expect(text).not.toContain("loads normally")
    } finally {
      process.env = env
      chmodSync(udd, 0o755)
    }
  })
})

describe("steps by hand say exactly what to click", () => {
  const f = (kind: Finding["kind"], id = OLD, path = SHARED): Finding => ({ kind, browser: chrome, profileDir: "Default", profileName: "Person 1", extensionId: id, path, autoFix: false })
  test("both IDs: load the old-ID copy, remove it, restart", () => {
    const s = manualStep(f("both-ids"))
    expect(s).toContain("Load unpacked")
    expect(s).toContain('Remove on the card named "Interceptor (old ID)"')
    expect(s).toContain("quit and reopen Google Chrome")
  })
  test("old ID only: load it, reload it (the browser keeps cached code otherwise), keep it", () => {
    const s = manualStep(f("old-id-only"))
    expect(s).toContain("click the reload arrow")
    expect(s).toContain("Keep that card")
  })
  test("two copies: remove the old one by ID", () => {
    expect(manualStep(f("two-copies"))).toContain(`Remove on the Interceptor card with ID ${OLD}`)
  })
})

describe("old-ID copy and recurrence guards", () => {
  test("the shipped extension keeps the store key; changing it in place recreates this whole problem", () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../extension/manifest.json"), "utf8"))
    expect(deriveChromiumExtensionId(manifest.key)).toBe(NEW)
    expect(manifest.key).toBe(identities.chrome.publicKey)
  })

  test("the legacy key derives the old development ID", () => {
    expect(deriveChromiumExtensionId(LEGACY_DEVELOPMENT_PUBLIC_KEY)).toBe(OLD)
  })

  test("the native host keeps allowing the old ID (repaired profiles run it)", () => {
    const host = JSON.parse(readFileSync(resolve(import.meta.dir, "../daemon/com.interceptor.host.json"), "utf8"))
    expect(host.allowed_origins).toContain(`chrome-extension://${OLD}/`)
  })

  test("the stamp script puts the old key and a distinct name on a copy of the manifest", () => {
    const manifest = join(root, "legacy-manifest.json")
    writeFileSync(manifest, JSON.stringify({ name: "Interceptor", version: "2.1.4", key: identities.chrome.publicKey }))
    const r = captureShell(process.execPath, [resolve(import.meta.dir, "../scripts/stamp-legacy-extension.ts"), manifest], { timeout: 30_000 })
    expect(r.status).toBe(0)
    const stamped = JSON.parse(readFileSync(manifest, "utf8"))
    expect(deriveChromiumExtensionId(stamped.key)).toBe(OLD)
    expect(stamped.name).toBe("Interceptor (old ID)")
    expect(stamped.version).toBe("2.1.4")
  })

  test("the macOS release stages the stamped copy next to the current one", () => {
    const release = readFileSync(resolve(import.meta.dir, "../scripts/release.sh"), "utf8")
    expect(release).toContain('DEST_EXTENSION_LEGACY_DIR="${DEST_SUPPORT_DIR}/extension-legacy"')
    expect(release).toContain('scripts/stamp-legacy-extension.ts" "$STAGING_DIR/extension/$DEST_EXTENSION_LEGACY_DIR/manifest.json"')
  })
})

describe("installer hooks", () => {
  for (const pkg of ["full", "browser"]) {
    test(`${pkg} postinstall asks the console user and never blocks or fails the install`, () => {
      const script = readFileSync(resolve(import.meta.dir, `../scripts/release/postinstall-${pkg}`), "utf8")
      const block = script.slice(script.indexOf("# A browser profile that loaded the unpacked extension"), script.indexOf("# ── skills-refresh marker"))
      expect(block).toContain('if [[ -n "$TARGET_UID" && -n "$TARGET_HOME" && "$FIRST_INSTALL" == 0 ]]; then')
      expect(block).toContain('/bin/launchctl asuser "$TARGET_UID" /usr/bin/sudo -u "$TARGET_USER"')
      expect(block).toContain("/usr/local/bin/interceptor diagnose extension --prompt")
      expect(block).toContain("|| true")
    })
    test(`${pkg} first install opens the welcome window, the store tab only if the CLI cannot run`, () => {
      const script = readFileSync(resolve(import.meta.dir, `../scripts/release/postinstall-${pkg}`), "utf8")
      const block = script.slice(script.indexOf("# A preinstall marker exists only"), script.indexOf("# A browser profile that loaded the unpacked extension"))
      expect(block).toContain("FIRST_INSTALL=1")
      expect(block).toContain("/usr/local/bin/interceptor diagnose extension --welcome")
      expect(block.indexOf("--welcome")).toBeLessThan(block.indexOf(identities.chrome.listingUrl))
      expect(block).toContain("|| true")
    })
  }
})

describe("the warning dialog", () => {
  const src = readFileSync(resolve(import.meta.dir, "../cli/lib/extension-repair.ts"), "utf8")
  test("Return and Escape pick the first button (Later / OK); only a click restarts a browser", () => {
    expect(src).toContain('default button 1${buttons.length > 1 ? " cancel button 1" : ""}')
    expect(src).toContain('const buttons = auto.size ? ["Later", `Restart ${labels}`] : ["OK", openLabel]')
  })
  test("one dialog at a time, and steps by hand are shown once", () => {
    expect(src).toContain("if (!takeLock())")
    expect(src).toContain("if (manual.length && choice !== null) recordAcked(manual)")
    // The system dialog's first button is its cancel button: a click on it is an answer.
    expect(src).toContain('includes("(-128)") ? buttons[0] : null')
  })
  test("with a restart on offer, the Open button is promised on the next window, not this one", () => {
    expect(src).toContain("${auto.size ? `After the restart, ${openLabel} in the next window` : openLabel} copies the folder path")
    expect(src).toContain('const after = dialog(summary, manual.length ? ["OK", openLabel] : ["OK"]')
  })
  test("the access request is asked once per browser, not again at every update", () => {
    expect(src).toContain("const accessAck = (b: RepairBrowser) => `browser-data-access:${b.key}`")
    expect(src).not.toMatch(/browser-data-access:\$\{VERSION\}/)
  })
})

describe("the browser that owns a profile folder", () => {
  test("a SingletonLock left by a crash is not trusted: another host, or a live pid that is not the browser", () => {
    const udd = join(root, "stale-lock")
    mkdirSync(udd, { recursive: true })
    const lock = join(udd, "SingletonLock")
    symlinkSync(`another-host-${process.pid}`, lock)
    expect(instancePid(udd, brave)).toBeNull()
    rmSync(lock)
    // Alive and on this host, but the pid is this test runner, not Brave.
    symlinkSync(`${hostname()}-${process.pid}`, lock)
    expect(instancePid(udd, brave)).toBe(process.platform === "darwin" ? null : process.pid)
    rmSync(lock)
    symlinkSync(`${hostname()}-999999`, lock)
    expect(instancePid(udd, brave)).toBeNull()
    rmSync(lock)
  })
  // instancePid reads ps and plutil output; skip where this runner cannot capture a child's output.
  const canSpawn = spawnSync("/bin/echo", ["ok"], { encoding: "utf8" }).stdout === "ok\n"
  test.skipIf(process.platform !== "darwin" || !canSpawn)("a live pid whose app has the browser's bundle id is the owner (Finder stands in)", () => {
    const finder = Number((spawnSync("/usr/bin/pgrep", ["-x", "Finder"], { encoding: "utf8" }).stdout ?? "").split("\n")[0]) || 0
    if (!finder) return
    const udd = join(root, "live-lock")
    mkdirSync(udd, { recursive: true })
    symlinkSync(`${hostname()}-${finder}`, join(udd, "SingletonLock"))
    expect(instancePid(udd, { ...brave, bundleId: "com.apple.finder" })).toBe(finder)
    expect(instancePid(udd, brave)).toBeNull()
  })
})

describe("plain diagnose and the old-ID copy", () => {
  test("an old-ID copy that is the profile's only one is kept; diagnose extension tells two copies apart", () => {
    const line = legacyDevelopmentCopyLine("legacy", OLD)!
    expect(line).toContain("If it is the only Interceptor in that browser profile, keep it.")
    expect(line).toContain("'interceptor diagnose extension'")
    expect(line).not.toContain("Remove it on chrome://extensions")
  })
  test("plain diagnose never reads a folder macOS protects, and names what it skipped", () => {
    const src = readFileSync(resolve(import.meta.dir, "../cli/commands/diagnose.ts"), "utf8")
    expect(src).toContain("findProblems(undefined, extensionBlocked, true)")
    expect(src).toContain("extensionBlocked: extensionBlocked.map(b => b.key)")
  })
})

describe("asking for Full Disk Access (macOS 27)", () => {
  const entry = (name: string, version: string) =>
    `<dict><key>date</key><date>2026-01-01T00:00:00Z</date><key>displayName</key><string>${name}</string><key>displayVersion</key><string>${version}</string></dict>`
  test("only a Mac that installed a pre-1.0.1 package can have the old-ID entry", () => {
    expect(hadOldInstall(entry("Interceptor", "2.1.3") + entry("Interceptor", "0.24.13"))).toBe(true)
    expect(hadOldInstall(entry("Interceptor", "1.0.0"))).toBe(true)
    expect(hadOldInstall(entry("Interceptor", "1.0.1") + entry("Interceptor", "2.1.4") + entry("Other App", "0.1.0"))).toBe(false)
    expect(hadOldInstall("")).toBe(false)
  })

  test("the check hands itself to the bridge without a daemon, and the bridge's copy never hands itself on", () => {
    const src = readFileSync(resolve(import.meta.dir, "../cli/lib/extension-repair.ts"), "utf8")
    expect(src).toContain('process.env[VIA_BRIDGE_ENV] !== "1"')
    expect(src).toContain("bridgeSocketPathForDetection()")
    expect(src).not.toMatch(/sendCommand|from "\.\.\/transport"/)
    expect(src).toContain('["Later", "Open Settings"]')
  })
})

describe("the branded window (macOS)", () => {
  test("the first button is the default and the cancel; the last is the blue one", () => {
    const html = dialogPage({ title: "Interceptor needs a quick fix", items: [{ name: "Brave", detail: '"Personal"', chip: "lost at every start" }] }, ["Later", "Restart Brave"])
    expect(html).toContain('<button class="btn" autofocus data-cancel data-value="Later">Later</button>')
    expect(html).toContain('<button class="btn primary" data-value="Restart Brave">Restart Brave</button>')
    expect(html).toContain("e.key==='Escape'")
    expect(html.match(/@font-face/g)?.length).toBe(3)
  })
  test("text is escaped; commands, paths and extensions pages become code", () => {
    expect(rich("<b> 'interceptor diagnose extension' /Library/Application Support/Interceptor/extension-legacy. brave://extensions"))
      .toBe("&lt;b&gt; <code>interceptor diagnose extension</code> <code>/<wbr>Library/<wbr>Application Support/<wbr>Interceptor/<wbr>extension-legacy</code>. <code>brave://extensions</code>")
  })
  test("the host talks through the page title, never a message handler JXA cannot register", () => {
    const src = readFileSync(resolve(import.meta.dir, "../cli/lib/hvm-window.ts"), "utf8")
    expect(src).toContain("document.title='ix:'")
    expect(src).not.toContain("registerSubclass")
    expect(src).toContain("app.run")
  })
  test("the load-unpacked guide names the folder, the extensions page and the store", () => {
    const brave = REPAIR_BROWSERS.find(b => b.key === "brave")!
    const html = guidePage(brave, "/Library/Application Support/Interceptor/extension")
    expect(html).toContain("/Library/Application Support/Interceptor/extension")
    expect(html).toContain("<code>brave://extensions</code>")
    expect(html).toContain(identities.chrome.listingUrl)
    expect(html).not.toContain("window.ix")
  })
})

describe("asking for access keeps the user informed (macOS 27)", () => {
  const repair = readFileSync(resolve(import.meta.dir, "../cli/lib/extension-repair.ts"), "utf8")
  const welcome = readFileSync(resolve(import.meta.dir, "../cli/lib/extension-welcome.ts"), "utf8")
  const host = readFileSync(resolve(import.meta.dir, "../cli/lib/hvm-window.ts"), "utf8")
  test("the installer never reads a protected folder itself: only interceptor-bridge is listed in Files & Folders", () => {
    expect(repair).toContain('const skipDirect = (prompt || welcome) && PLATFORM === "darwin" && process.env[VIA_BRIDGE_ENV] !== "1"')
    expect(repair).toContain("findProblems(only, blocked, quiet || skipDirect)")
  })
  test("the access window stays open, checks the moment a switch is on, and comes back in front", () => {
    expect(repair).toContain('await runAccess(blocked, only) === "done"')
    expect(welcome).toContain("This window stays open and checks the moment you do.")
    expect(welcome).toContain("Use interceptor-bridge, not")
    expect(welcome).toContain('show({ view: "checking", checking: names, raise: ++raise })')
    expect(welcome).not.toContain("20_000) // the user may still be turning on the others")
    expect(host).toContain("if (st.close) { win.orderOut(null); return stop() }")
    expect(host).toContain("if (st.raise && st.raise !== raised)")
  })
  test("the welcome window stops re-reading profiles two minutes after a connection it cannot place", () => {
    expect(welcome).toContain('view === "connected" && !state.where && Date.now() - connectedAt < 120_000')
  })
  test("the summary waits for the reopened browser, so the browser does not cover it", () => {
    expect(repair).toContain("await waitFor(() => instancePid(userData, browser) !== null, 20_000)")
  })
})

describe("the single-dialog lock", () => {
  test("first run takes it with no lock file; a live holder blocks; a dead holder is taken over", () => {
    const home = join(root, "lock-home"), prev = process.env.HOME
    process.env.HOME = home
    try {
      expect(takeLock()).toBe(true) // no ~/.interceptor and no lock file yet
      expect(readFileSync(join(home, ".interceptor", "extension-repair.lock"), "utf8")).toBe(String(process.pid))
      const holder = Bun.spawn(["sleep", "30"]) // a live process this user owns
      try {
        writeFileSync(join(home, ".interceptor", "extension-repair.lock"), String(holder.pid))
        expect(takeLock()).toBe(false) // another live process holds it
      } finally { holder.kill() }
      writeFileSync(join(home, ".interceptor", "extension-repair.lock"), "999999")
      expect(takeLock()).toBe(true) // its holder is gone
    } finally {
      process.env.HOME = prev
    }
  })
})

describe("MCP tier", () => {
  test("reading is read; fixing restarts the browser, so it is destructive", () => {
    expect(classify("local", "diagnose", ["extension"]).tier).toBe("read")
    expect(classify("local", "diagnose", ["extension", "--json"]).tier).toBe("read")
    expect(classify("local", "diagnose", ["extension", "--fix"]).tier).toBe("destructive")
    expect(classify("local", "diagnose", ["extension", "--prompt"]).tier).toBe("destructive")
    expect(classify("local", "diagnose", ["extension", "--welcome"]).tier).toBe("destructive")
  })
})
