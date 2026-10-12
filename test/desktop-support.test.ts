import { describe, expect, test } from "bun:test"
import { families } from "../scripts/desktop-parity/cases/index"
import { expectationFor, type Case, type Host } from "../scripts/desktop-parity/types"
import { SUPPORT_ROWS, desktopFamilyUnavailable, filterDesktopHelp, type DesktopOs } from "../shared/desktop-support"
import { renderSkill, renderText, supportTable, type Os } from "../scripts/gen-skills"
import { helpForCommand } from "../cli/help"
import { buildServer } from "../cli/mcp/server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const OSES: DesktopOs[] = ["win32", "linux"]
const kind = (c: Case, host: Host) => { const e = expectationFor(c, host); return "skip" in e ? "skip" : "refuse" in e ? "refuse" : "ok" }
const cases = new Map<string, { family: string; c: Case }>()
for (const f of families) for (const c of f.cases) cases.set(c.id, { family: f.family, c })

// Parity cases that refuse on one OS for a reason that is not a missing capability.
const NOT_A_GAP: Record<string, string> = {
  "contacts.me": "the test machines have no Me card",
  "location.current": "location services are off on the Windows test machine",
  "location.monitor-start": "location services are off on the Windows test machine",
  "location.significant-start": "location services are off on the Windows test machine",
  "app.launch-positional": "the case launches a Mac bundle id",
  "app.launch-bundle": "the case launches a Mac bundle id",
  "audio.output.start-app-save": "Linux records an app only while it plays sound, and the test app plays none",
  "reminders.delete-link": "it deletes the URL reminder Windows refused to create",
}

describe("desktop-support.json against the parity catalog", () => {
  test("every row is backed by the parity cases it cites, on both OSes", () => {
    for (const row of SUPPORT_ROWS) {
      const name = [row.family, row.sub, row.flag].filter(Boolean).join(" ")
      if (!row.sub && !row.flag) {
        // A family row: every case of the family refuses there, except the subcommands it keeps.
        const all = [...cases.values()].filter(x => x.family === row.family)
        expect(all.length, name).toBeGreaterThan(0)
        for (const os of OSES) for (const { c } of all) {
          const kept = row.except?.includes(c.sub)
          if (row[os] === "no" && !kept) expect(kind(c, os), `${name} ${c.id} on ${os}`).not.toBe("ok")
          if (kept) expect(kind(c, os), `${name} ${c.id} on ${os}`).toBe("ok")
        }
        continue
      }
      expect(row.cases?.length, `${name} cites no parity case`).toBeGreaterThan(0)
      for (const id of row.cases!) {
        const hit = cases.get(id)
        expect(hit, `${name} cites unknown case ${id}`).toBeDefined()
        expect(hit!.family, `${name} cites ${id}`).toBe(row.family)
      }
      // yes: every cited case passes there. no: every one refuses. partial: at least one refuses.
      for (const os of OSES) {
        const kinds = row.cases!.map(id => kind(cases.get(id)!.c, os))
        if (row[os] === "yes") expect(kinds.every(k => k === "ok"), `${name} is yes on ${os}: ${kinds}`).toBe(true)
        if (row[os] === "no") expect(kinds.every(k => k !== "ok"), `${name} is no on ${os}: ${kinds}`).toBe(true)
        if (row[os] === "partial") expect(kinds.some(k => k !== "ok"), `${name} is partial on ${os}: ${kinds}`).toBe(true)
      }
    }
  })

  test("every Windows or Linux refusal the Mac does not share is in the file or explained", () => {
    const missing: string[] = []
    for (const [id, { family, c }] of cases) for (const os of OSES) {
      const k = kind(c, os), mac = kind(c, "darwin")
      if (k === "ok" || mac === "refuse" || (k === "skip" && mac === "skip")) continue
      const covered = SUPPORT_ROWS.some(r => r.family === family && r[os] !== "yes" && (r.cases?.includes(id) || (!r.sub && !r.flag)))
      if (!covered && !NOT_A_GAP[id]) missing.push(`${os} ${id}`)
    }
    expect(missing).toEqual([])
  })

  test("rows give a reason for every OS where they are not yes", () => {
    for (const row of SUPPORT_ROWS) for (const os of OSES) {
      if (row[os] === "yes") continue
      const why = typeof row.why === "string" ? row.why : row.why[os]
      expect(why, `${row.family} ${row.sub ?? ""} ${row.flag ?? ""} on ${os}`).toBeTruthy()
    }
  })
})

describe("desktop help and MCP menu on Windows and Linux", () => {
  const page = helpForCommand("desktop")!
  test("help leaves out what the OS does not have and keeps the rest", () => {
    for (const os of OSES) {
      const help = filterDesktopHelp(page, os)
      for (const gone of [/desktop runtime /, /--jxa/, /--script '/, /desktop appintent /, /desktop maps /, /music library-search/, /\[--virtual/, /auth confirm/, /share airdrop/])
        expect(help, `${os} ${gone}`).not.toMatch(gone)
      for (const kept of [/desktop script run --jsc/, /desktop tree /, /desktop cdp discover/, /music status\|request\|play\|pause/, /photos status$/m, /location status\|request\|current/])
        expect(help, `${os} ${kept}`).toMatch(kept)
    }
    const win = filterDesktopHelp(page, "win32"), linux = filterDesktopHelp(page, "linux")
    expect(win).not.toMatch(/desktop sudo /)
    expect(linux).toMatch(/desktop sudo /)
    expect(win).not.toMatch(/contacts status\|request\|containers\|groups/)
    expect(linux).toMatch(/contacts status\|request\|containers\|groups/)
    expect(win).toMatch(/trust --walkthrough/)
    expect(linux).not.toMatch(/trust --walkthrough/)
  })

  test("the MCP desktop menu drops only families the OS cannot use", () => {
    for (const os of OSES) {
      for (const family of ["runtime", "tcc", "appintent", "vm", "photos", "maps"]) expect(desktopFamilyUnavailable(family, os)).toBe(true)
      for (const family of ["contacts", "music", "script", "location", "notifications"]) expect(desktopFamilyUnavailable(family, os)).toBe(false)
    }
    expect(desktopFamilyUnavailable("sudo", "win32")).toBe(true)
    expect(desktopFamilyUnavailable("sudo", "linux")).toBe(false)
  })

  test("the MCP server offers the macOS and iOS tools only on a Mac", async () => {
    const tools = async (platform: string) => {
      const server = buildServer(platform), client = new Client({ name: "os", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(a); await client.connect(b)
      const list = (await client.listTools()).tools
      await client.close(); await server.close()
      return list
    }
    const verbs = (list: any[], name: string) => (list.find(t => t.name === name)?.inputSchema.properties?.verb as { enum?: string[] })?.enum ?? []
    const mac = await tools("darwin")
    expect(mac.map(t => t.name)).toEqual(expect.arrayContaining(["interceptor_macos", "interceptor_ios", "interceptor_desktop"]))
    expect(verbs(mac, "interceptor_desktop")).toContain("runtime")
    for (const os of OSES) {
      const list = await tools(os)
      expect(list.map(t => t.name)).not.toContain("interceptor_macos")
      expect(list.map(t => t.name)).not.toContain("interceptor_ios")
      expect(verbs(list, "interceptor_desktop")).not.toContain("runtime")
      expect(verbs(list, "interceptor_desktop")).toContain("contacts")
      const read = list.find(t => t.name === "interceptor_read")!.inputSchema.properties?.surface as { enum?: string[] }
      expect(read.enum).toEqual(["browser", "desktop"])
    }
  })
})

describe("generated skills", () => {
  const ships: Record<Os, string[]> = {
    darwin: ["interceptor", "interceptor-browser", "interceptor-research", "interceptor-macos", "interceptor-ios"],
    win32: ["interceptor", "interceptor-browser", "interceptor-research", "interceptor-desktop"],
    linux: ["interceptor", "interceptor-browser", "interceptor-research", "interceptor-desktop"],
  }
  // Provenance keys say where a file came from, not what the OS can do; the generator skips them too.
  const text = (os: Os, skill: string, file = "SKILL.md") => String(renderSkill(skill, os).get(file)).split("\n")
    .filter(l => !/^\s*(author|generated_by|created|updated|status|reviewed|source):/.test(l)).join("\n")

  test("every OS's skills render; the generator rejects markers and another OS's surface", () => {
    for (const [os, skills] of Object.entries(ships) as [Os, string[]][]) for (const skill of skills) expect(renderSkill(skill, os).size).toBeGreaterThan(0)
    expect(() => renderSkill("interceptor-desktop", "darwin")).toThrow()
    expect(() => renderSkill("interceptor-macos", "win32")).toThrow()
  })

  test("each router points at that OS's skills", () => {
    expect(text("darwin", "interceptor")).toContain("`interceptor-macos`")
    expect(text("darwin", "interceptor")).not.toContain("interceptor-desktop")
    for (const os of ["win32", "linux"] as const) {
      const router = text(os, "interceptor")
      expect(router).toContain("`interceptor-desktop`")
      expect(router).toMatch(/^description: ".*interceptor-desktop/m)
      expect(router).not.toMatch(/interceptor-(macos|ios)|Safari/)
    }
  })

  test("the desktop skill lists only its own OS's gaps", () => {
    const win = text("win32", "interceptor-desktop"), linux = text("linux", "interceptor-desktop")
    for (const t of [win, linux]) {
      expect(t).not.toContain("Filled at build time")
      expect(t).toContain(supportTable(t === win ? "win32" : "linux", "no"))
    }
    expect(win).toContain("`contacts groups`")
    expect(linux).not.toContain("`contacts groups`")
    expect(linux).toContain("`notifications badge`")
    expect(win).not.toContain("`notifications badge`")
    expect(win).not.toMatch(/\bLinux\b|Hyprland/)
    expect(linux).not.toMatch(/\bWindows\b/)
  })
})

test("a CRLF checkout (Windows) renders the same skill text as an LF one", async () => {
  const source = await Bun.file(new URL("../.agents/skills/interceptor/SKILL.md", import.meta.url)).text()
  for (const os of ["darwin", "win32", "linux"] as Os[])
    expect(renderText(source.replace(/\n/g, "\r\n"), os, "interceptor/SKILL.md")).toBe(renderText(source, os, "interceptor/SKILL.md"))
})
