// Data families: clipboard, files, fs, thumbnail, url, log. Every subcommand and flag from
// the CLI inventory appears below or in dataExclusions. Clipboard writes are disruptive (a Mac
// someone is using skips them); everything else stays inside ctx.dir or reads well-known public endpoints.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, normalize } from "node:path"
import { pathToFileURL } from "node:url"
import { type Ctx, type Exclusion, type Family, type Res, refuse } from "../types"
import { list, pid } from "./helpers"

const P = "Interceptor Parity"
const at = (ctx: Ctx, name: string) => join(ctx.dir, `${P} ${name}`)
const norm = (p: string) => process.platform === "win32" ? normalize(p).toLowerCase() : normalize(p)
const same = (a: unknown, b: string) => typeof a === "string" && norm(a) === norm(b)
const since = (ctx: Ctx) => new Date(Date.now() - (ctx.host === "darwin" ? 20_000 : 120_000)).toISOString()
const READ_TEXT = `${P} fs read\n`
const RTF = `{\\rtf1\\ansi ${P} rtf}`
// 64x48 RGB PNG (two-tone checker), decodable by ImageIO, WIC, image-rs and GdkPixbuf.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAUUlEQVR42u3QMQ0AMAwDwSDpXEzFVHSdCyYcInk76XfrXOu+aP/saAUAAAAAAAAAAAAAAAAAAAAAMAKkB9IHAQAAAAAAAAAAAAAAAAAAAACMaujMHQB4PAxSAAAAAElFTkSuQmCC"
function png(ctx: Ctx, name = "image.png"): string {
  const p = at(ctx, name)
  if (!existsSync(p)) writeFileSync(p, Buffer.from(PNG, "base64"))
  return p
}

/** Re-runs `args` until `test` holds (the first result counts), for native observers that lag. */
async function until(ctx: Ctx, r: Res, args: string[], test: (r: Res) => boolean, what: string, ms = 3000): Promise<string | void> {
  const end = Date.now() + ms
  while (!test(r)) {
    if (Date.now() > end) return `never observed ${what}: ${JSON.stringify(r.json ?? r.stdout).slice(0, 300)}`
    await ctx.sleep(200); r = await ctx.run(args)
  }
}

/** Puts a non-text format on the VM clipboard with the host's own tools (write is text-only by contract). */
function seed(ctx: Ctx, kind: "files" | "image" | "rtf", path?: string) {
  if (ctx.host === "darwin") throw new Error("clipboard seeding never runs on the shared Mac")
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  const forms = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
  const cmd = ctx.host === "win32"
    ? ["powershell.exe", "-NoProfile", "-STA", "-Command", kind === "files" ? `Set-Clipboard -LiteralPath ${q(path!)}`
      : kind === "image" ? `${forms}[System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile(${q(path!)}))`
      : `${forms}[System.Windows.Forms.Clipboard]::SetData([System.Windows.Forms.DataFormats]::Rtf, ${q(RTF)})`]
    : kind === "files" ? ["wl-copy", "--type", "text/uri-list", pathToFileURL(path!).href]
    : kind === "rtf" ? ["wl-copy", "--type", "text/rtf", RTF] : ["wl-copy", "--type", "image/png"]
  // wl-copy forks a server that outlives the call; never hand it a pipe we would wait on.
  // WAYLAND_DISPLAY comes from the launcher (PARITY_WAYLAND_DISPLAY in launch.ts).
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}` }
  const r = Bun.spawnSync(cmd, { stdin: kind === "image" && ctx.host === "linux" ? Bun.file(path!) : "ignore", stdout: "ignore", stderr: "ignore", env })
  if (r.exitCode !== 0) throw new Error(`clipboard ${kind} seed failed: ${cmd[0]} exited ${r.exitCode}`)
}

export const data: Family[] = [
  {
    family: "clipboard",
    cases: [
      { id: "clipboard.types", sub: "types", args: ["clipboard", "types"], check: r => Array.isArray(r.json) ? undefined : "types is not a list" },
      // --limit 0 keeps any earlier tail's previews of a live clipboard out of the evidence.
      { id: "clipboard.history.zero", sub: "history", args: ["clipboard", "history", "--limit", "0"], check: r => list(r).length ? "limit 0 returned entries" : undefined },
      // tail starts a recorder that lives as long as the provider: never on a bridge someone is using.
      { id: "clipboard.tail", sub: "tail", args: ["clipboard", "tail"], disruptive: true, check: r => r.json?.tailing === true ? undefined : "tail did not report tailing" },
      { id: "clipboard.write", sub: "write", disruptive: true, args: ctx => ["clipboard", "write", (ctx.vars.clip = `${P} clipboard é🙂 ${Date.now()}`)],
        check: async (_r, ctx) => { const back = await ctx.run(["clipboard"]); return back.json === ctx.vars.clip ? undefined : `default read returned ${JSON.stringify(back.json)}` } },
      { id: "clipboard.read.text", sub: "read", disruptive: true, args: ["clipboard", "read", "--type", "text"], check: (r, ctx) => r.json === ctx.vars.clip ? undefined : `read ${JSON.stringify(r.json)}` },
      { id: "clipboard.history.after-write", sub: "history", disruptive: true, args: ["clipboard", "history", "--limit", "10"],
        check: (r, ctx) => until(ctx, r, ["clipboard", "history", "--limit", "10"], x => list(x).some(e => String(e.preview).includes(String(ctx.vars.clip).slice(0, 40))), "the written text in history") },
      { id: "clipboard.read.files", sub: "read", disruptive: true, flags: ["--type"],
        args: ctx => { const f = at(ctx, "clip.txt"); writeFileSync(f, "clip"); seed(ctx, "files", f); return ["clipboard", "read", "--type", "files"] },
        check: (r, ctx) => list(r).some(p => same(p, at(ctx, "clip.txt"))) ? undefined : `files ${JSON.stringify(r.json)}` },
      { id: "clipboard.read.image", sub: "read", disruptive: true, flags: ["--type"], args: ctx => { seed(ctx, "image", png(ctx)); return ["clipboard", "read", "--type", "image"] },
        check: r => String(r.json).startsWith("data:image/") ? undefined : `image ${String(r.json).slice(0, 80)}` },
      { id: "clipboard.read.rtf", sub: "read", disruptive: true, flags: ["--type"], args: ctx => { seed(ctx, "rtf"); return ["clipboard", "read", "--type", "rtf"] },
        check: r => String(r.json).includes(`${P} rtf`) ? undefined : `rtf ${String(r.json).slice(0, 80)}` },
      { id: "clipboard.clear", sub: "clear", disruptive: true, args: ["clipboard", "clear"] },
      { id: "clipboard.history.limit-range", sub: "history", args: ["clipboard", "history", "--limit", "501"], expect: { all: refuse("invalid_request") } },
      // An unknown type never reads pasteboard contents, so this is safe on the Mac.
      { id: "clipboard.read.bad-type", sub: "read", args: ["clipboard", "read", "--type", "bogus"], expect: { all: refuse("invalid_request"), darwin: refuse() } },
    ],
  },
  {
    family: "files",
    async setup(ctx) { writeFileSync(at(ctx, "watched.txt"), "watched\n") },
    async teardown(ctx) { for (const p of [at(ctx, "watched.txt"), ctx.dir]) await ctx.run(["files", "unwatch", p]).catch(() => {}) },
    cases: [
      { id: "files.recent.default", sub: "recent", args: ["files"], check: r => Array.isArray(r.json) ? undefined : "recent is not a list" },
      { id: "files.watch.file", sub: "watch", args: ctx => ["files", "watch", at(ctx, "watched.txt")],
        check: (r, ctx) => same(r.json?.watching, at(ctx, "watched.txt")) && r.json?.eventPath ? undefined : `watch ${JSON.stringify(r.json)}` },
      { id: "files.watch.dir", sub: "watch", args: ctx => ["files", "watch", ctx.dir], check: (r, ctx) => same(r.json?.watching, ctx.dir) ? undefined : `watch ${JSON.stringify(r.json)}` },
      { id: "files.recent.limit", sub: "recent", flags: ["--limit"],
        args: async ctx => { appendFileSync(at(ctx, "watched.txt"), `change ${Date.now()}\n`); await ctx.sleep(500); return ["files", "recent", "--limit", "200"] },
        check: (r, ctx) => until(ctx, r, ["files", "recent", "--limit", "200"], x => list(x).some(e => same(e.path, at(ctx, "watched.txt"))), "a change event for the watched file") },
      { id: "files.open.limit", sub: "open", args: ["files", "open", "--limit", "5"],
        check: r => Array.isArray(r.json?.files) && r.json.count === r.json.files.length && r.json.count <= 5 ? undefined : `open ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "files.open.pid", sub: "open", flags: ["--pid", "--limit"], args: ctx => ["files", "open", "--pid", pid(ctx), "--limit", "100"],
        check: r => Array.isArray(r.json?.files) && r.json.processesInspected <= 1 ? undefined : `open --pid ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "files.unwatch.file", sub: "unwatch", args: ctx => ["files", "unwatch", at(ctx, "watched.txt")], check: r => r.json?.removed === true ? undefined : `unwatch ${JSON.stringify(r.json)}` },
      { id: "files.unwatch.dir", sub: "unwatch", args: ctx => ["files", "unwatch", ctx.dir], check: r => r.json?.removed === true ? undefined : `unwatch ${JSON.stringify(r.json)}` },
      { id: "files.unwatch.again", sub: "unwatch", args: ctx => ["files", "unwatch", at(ctx, "watched.txt")], check: r => r.json?.removed === false ? undefined : `second unwatch ${JSON.stringify(r.json)}` },
      { id: "files.recent.pid-refused", sub: "recent", args: ["files", "recent", "--pid", "1"], expect: { all: refuse("invalid_request") } },
      { id: "files.watch.selector-refused", sub: "watch", flags: ["--limit"], args: ctx => ["files", "watch", ctx.dir, "--limit", "5"], expect: { all: refuse("invalid_request") } },
      { id: "files.open.legacy-filter", sub: "open", args: ["files", "open", "--filter", "parity"], expect: { all: refuse("invalid_request") } },
    ],
  },
  {
    family: "fs",
    async setup(ctx) { writeFileSync(at(ctx, "read.txt"), READ_TEXT) },
    cases: [
      { id: "fs.read.utf8", sub: "read", flags: ["--encoding"], args: ctx => ["fs", "read", at(ctx, "read.txt"), "--encoding", "utf8"],
        check: r => r.json?.content === READ_TEXT ? undefined : `content ${JSON.stringify(r.json?.content)}` },
      { id: "fs.read.base64-range", sub: "read", flags: ["--encoding", "--byte-range"], args: ctx => ["fs", "read", at(ctx, "read.txt"), "--encoding", "base64", "--byte-range", "0,11"],
        check: r => r.json?.content === Buffer.from("Interceptor").toString("base64") ? undefined : `content ${JSON.stringify(r.json?.content)}` },
      { id: "fs.write.content", sub: "write", flags: ["--content"], args: ctx => ["fs", "write", at(ctx, "write.txt"), "--content", `${P} fs write\n`],
        check: (r, ctx) => readFileSync(at(ctx, "write.txt"), "utf8") === `${P} fs write\n` && r.json?.written === Buffer.byteLength(`${P} fs write\n`) ? undefined : `wrote ${JSON.stringify(r.json)}` },
      { id: "fs.write.base64", sub: "write", flags: ["--base64"], args: ctx => ["fs", "write", at(ctx, "bytes.bin"), "--base64", "AAEC/w=="],
        check: (_r, ctx) => Buffer.compare(readFileSync(at(ctx, "bytes.bin")), Buffer.from([0, 1, 2, 255])) === 0 ? undefined : "decoded bytes differ" },
      // Every host refuses append today (Rust filesystem.rs, Swift DesktopFilesystemValidation.swift); the product scope lists no such reason.
      { id: "fs.write.content-and-base64", sub: "write", args: ctx => ["fs", "write", at(ctx, "both.txt"), "--content", "X", "--base64", "QQ=="], expect: { all: refuse("invalid_request", /not both/) } },
      { id: "fs.write.directory", sub: "write", args: ctx => ["fs", "write", ctx.dir, "--content", "nope"], expect: { all: refuse("unsupported_target") } },
      { id: "fs.write.append", sub: "write", flags: ["--content", "--append"], args: ctx => ["fs", "write", at(ctx, "write.txt"), "--content", "more", "--append"],
        expect: { all: refuse("unsupported_operation"), darwin: refuse() },
        check: (_r, ctx) => readFileSync(at(ctx, "write.txt"), "utf8") === `${P} fs write\n` ? undefined : "refused append still changed the file" },
      { id: "fs.search.path", sub: "search", flags: ["--scope", "--paths", "--limit", "--timeout-ms"],
        args: ctx => ["fs", "search", "Parity read", "--scope", "path", "--paths", ctx.dir, "--limit", "20", "--timeout-ms", "5000"],
        check: r => r.json?.matches?.some((m: any) => m.name === `${P} read.txt`) ? undefined : `matches ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "fs.search.cwd-kinds", sub: "search", flags: ["--scope", "--cwd", "--kinds"], args: ctx => ["fs", "search", P, "--scope", "cwd", "--cwd", ctx.dir, "--kinds", "public.plain-text"],
        check: r => { const m: any[] = r.json?.matches ?? []; return m.some(x => x.name === `${P} read.txt`) && m.every(x => x.name.endsWith(".txt")) ? undefined : `matches ${JSON.stringify(m.map(x => x.name))}` } },
      { id: "fs.search.wildcard-dir", sub: "search", flags: ["--scope"], args: ctx => ["fs", "search", "*", "--scope", ctx.dir],
        check: r => r.json?.matches?.some((m: any) => m.name === `${P} read.txt`) ? undefined : `listing ${JSON.stringify(r.json).slice(0, 200)}` },
      // Search: Spotlight on the Mac, Windows Search on Windows, plocate on Linux.
      { id: "fs.search.everywhere", sub: "search", args: ["fs", "search", "hosts", "--scope", "everywhere", "--limit", "5", "--timeout-ms", "8000"],
        check: r => Array.isArray(r.json?.matches) ? undefined : "no matches list" },
      { id: "fs.read.bad-range", sub: "read", args: ctx => ["fs", "read", at(ctx, "read.txt"), "--byte-range", "5"], expect: { all: refuse("invalid_request") } },
      { id: "fs.search.relative-scope", sub: "search", args: ["fs", "search", "parity", "--scope", "relative/dir"], expect: { all: refuse("invalid_request"), darwin: refuse() } },
    ],
  },
  {
    family: "thumbnail",
    async setup(ctx) { png(ctx); png(ctx, "image-2.png") },
    cases: [
      { id: "thumbnail.generate.default", sub: "<path> (generate)", args: ctx => ["thumbnail", png(ctx)],
        check: r => r.json?.type === "thumbnail" && String(r.json?.dataUrl).startsWith("data:image/png;base64,") ? undefined : `thumbnail ${JSON.stringify(r.json).slice(0, 160)}` },
      { id: "thumbnail.generate.size-scale-jpeg", sub: "<path> (generate)", flags: ["--size", "--scale", "--format"], args: ctx => ["thumbnail", png(ctx), "--size", "32x24", "--scale", "1", "--format", "jpeg"],
        check: r => r.json?.format === "jpeg" && r.json.width <= 32 && r.json.height <= 24 ? undefined : `thumbnail ${JSON.stringify(r.json).slice(0, 160)}` },
      { id: "thumbnail.generate.types-thumbnail", sub: "<path> (generate)", flags: ["--types"], args: ctx => ["thumbnail", png(ctx), "--types", "thumbnail,lowQualityThumbnail"] },
      { id: "thumbnail.generate.types-icon", sub: "<path> (generate)", flags: ["--types"], args: ctx => ["thumbnail", png(ctx), "--types", "icon", "--size", "64"], check: r => Number(r.json?.bytes) > 0 ? undefined : "icon thumbnail produced no bytes" },
      { id: "thumbnail.generate.heic", sub: "<path> (generate)", flags: ["--format"], expect: { win32: refuse(), linux: refuse() }, args: ctx => ["thumbnail", png(ctx), "--format", "heic"],
        check: r => r.json?.format === "heic" ? undefined : `format ${r.json?.format}` },
      { id: "thumbnail.generate.save-out", sub: "<path> (generate)", flags: ["--save", "--out"], args: ctx => ["thumbnail", png(ctx), "--save", "--out", at(ctx, "thumb-out.png")],
        check: (r, ctx) => existsSync(at(ctx, "thumb-out.png")) && basename(String(r.json?.filePath)) === basename(at(ctx, "thumb-out.png")) ? undefined : `saved ${JSON.stringify(r.json)}` },
      { id: "thumbnail.generate.save-beside", sub: "<path> (generate)", flags: ["--save"], args: ctx => ["thumbnail", png(ctx, "image-2.png"), "--save"],
        check: r => existsSync(String(r.json?.filePath)) ? undefined : `saved ${JSON.stringify(r.json)}` },
      { id: "thumbnail.batch", sub: "batch", flags: ["--size", "--scale", "--types", "--format"],
        args: ctx => ["thumbnail", "batch", png(ctx), png(ctx, "image-2.png"), "--size", "48", "--scale", "1", "--types", "thumbnail", "--format", "png"],
        check: r => r.json?.results?.length === 2 && r.json.results.every((x: any) => x.ok) ? undefined : `batch ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "thumbnail.batch.save", sub: "batch", flags: ["--save"], args: ctx => ["thumbnail", "batch", png(ctx), png(ctx, "image-2.png"), "--save", "--format", "jpeg"],
        check: r => r.json?.results?.length === 2 && r.json.results.every((x: any) => x.ok && existsSync(String(x.result?.data?.filePath))) ? undefined : `batch ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "thumbnail.batch.out-refused", sub: "batch", flags: ["--save", "--out"], args: ctx => ["thumbnail", "batch", png(ctx), "--save", "--out", at(ctx, "batch-out.png")], expect: { all: refuse("invalid_request") } },
      { id: "thumbnail.generate.bad-scale", sub: "<path> (generate)", args: ctx => ["thumbnail", png(ctx), "--scale", "9"], expect: { all: refuse("invalid_request") } },
    ],
  },
  {
    family: "url",
    cases: [
      // Nothing listens on the discard port: a definite failure, not an unknown outcome.
      { id: "url.get.refused", sub: "get", args: ["url", "get", "http://127.0.0.1:9/parity"], expect: { all: refuse("provider_failed", /could not connect/i) } },
      // Windows answers a refused loopback connect only after ~2 s of SYN retries; a 1 s timeout must still say nothing was sent.
      { id: "url.get.refused-short-timeout", sub: "get", args: ["url", "get", "http://127.0.0.1:9/parity", "--timeout", "1000"], expect: { all: refuse("provider_failed", /could not connect/i) } },
      { id: "url.get.default", sub: "get", args: ["url", "get", "https://example.com/"], check: r => r.json?.status === 200 ? undefined : `status ${r.json?.status}` },
      { id: "url.get.headers-timeout", sub: "get", flags: ["--header", "-H", "--timeout"], args: ["url", "get", "https://httpbin.org/get", "--header", "X-Interceptor-Parity: get", "-H", "X-Parity-Short: yes", "--timeout", "20000"],
        check: r => r.json?.status === 200 && JSON.stringify(r.json).includes("X-Interceptor-Parity") && JSON.stringify(r.json).includes("X-Parity-Short") ? undefined : `echo ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "url.get.method-body", sub: "get", flags: ["--method", "--body", "--content-type"], args: ["url", "get", "https://httpbin.org/anything", "--method", "PUT", "--body", `${P} body`, "--content-type", "text/plain"],
        check: r => r.json?.status === 200 && JSON.stringify(r.json).includes('\\"method\\": \\"PUT\\"') && JSON.stringify(r.json).includes(`${P} body`) ? undefined : `echo ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "url.post", sub: "post", flags: ["--header", "-H", "--timeout", "--body", "--content-type"],
        args: ["url", "post", "https://httpbin.org/post", "--body", JSON.stringify({ parity: P }), "--content-type", "application/json", "--header", "X-Interceptor-Parity: post", "-H", "X-Parity-Short: yes", "--timeout", "20000"],
        check: r => r.json?.status === 200 && JSON.stringify(r.json).includes(P) && JSON.stringify(r.json).includes("X-Parity-Short") ? undefined : `echo ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "url.get.duplicate-header", sub: "get", flags: ["-H"], args: ["url", "get", "https://example.com/", "-H", "X-Parity: 1", "--header", "x-parity: 2"], expect: { all: refuse("invalid_request") } },
      { id: "url.get.not-http", sub: "get", args: ["url", "get", "file:///etc/hosts"], expect: { all: refuse("invalid_request") } },
    ],
  },
  {
    family: "log",
    cases: [
      { id: "log.query.recent", sub: "query", flags: ["--since", "--limit"], args: ctx => ["log", "query", "--since", since(ctx), "--limit", "5"],
        check: r => Array.isArray(r.json?.entries) && r.json.count === r.json.entries.length && r.json.count <= 5 ? undefined : `log ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "log.query.info-debug", sub: "query", flags: ["--since", "--limit", "--include-info", "--include-debug"], args: ctx => ["log", "query", "--since", since(ctx), "--limit", "10", "--include-info", "--include-debug"],
        check: r => Array.isArray(r.json?.entries) ? undefined : "no entries list" },
      // Linux writes one owned journal line first (logger: identifier = subsystem, facility user = category "1").
      // Windows needs admin to register an Event Log source and the Mac log stays untouched, so those only filter.
      { id: "log.query.predicate", sub: "query", flags: ["--predicate", "--since", "--limit"],
        args: async ctx => {
          if (ctx.host === "linux") { Bun.spawnSync(["logger", "-t", "interceptor-parity", `${P} log ${Date.now()}`]); await ctx.sleep(1000) }
          return ["log", "query", "--predicate", `message CONTAINS "${P} log"`, "--since", since(ctx), "--limit", "5"]
        },
        check: (r, ctx) => { const e: any[] = r.json?.entries ?? []; return e.every(x => String(x.message).includes(`${P} log`)) && (ctx.host !== "linux" || e.length) ? undefined : `entries ${JSON.stringify(e).slice(0, 200)}` } },
      { id: "log.query.subsystem-category", sub: "query", flags: ["--subsystem", "--category", "--since", "--limit"],
        args: ctx => ["log", "query", "--subsystem", ctx.host === "darwin" ? "com.interceptor.parity" : ctx.host === "linux" ? "interceptor-parity" : P,
          "--category", ctx.host === "darwin" ? "parity" : ctx.host === "linux" ? "1" : "Application", "--since", since(ctx), "--limit", "5"],
        check: (r, ctx) => { const e: any[] = r.json?.entries ?? []; return Array.isArray(r.json?.entries) && (ctx.host !== "linux" || e.length) ? undefined : `entries ${JSON.stringify(r.json).slice(0, 200)}` } },
      { id: "log.query.bad-since", sub: "query", args: ["log", "query", "--since", "yesterday"], expect: { all: refuse("invalid_request") } },
      { id: "log.query.predicate-and-shortcut", sub: "query", args: ["log", "query", "--predicate", `message CONTAINS "x"`, "--subsystem", "x"], expect: { all: refuse("invalid_request") } },
    ],
  },
]

const onlyHistory = "only `history` reads limit (the CLI range-checks it for every clipboard subcommand); this subcommand ignores it on every host"
const onlyRead = "only `read` reads contentType; this subcommand ignores it on every host"
const legacy = "macOS legacy `macos files` selector, not in DesktopFilesAction; the desktop parser refuses it on every host (files.open.legacy-filter)"
const selectors = "inventory selector; the contract forbids it on watch/unwatch (files.watch.selector-refused shows the refusal)"
export const dataExclusions: Exclusion[] = [
  { family: "clipboard", flag: "--image", reason: "parsed into action.image but no provider reads it (ClipboardDomain.swift, interceptor-desktop/src/clipboard*.rs); there is no behavior to exercise" },
  ...["write", "tail", "clear", "types"].map(sub => ({ family: "clipboard", sub, flag: "--type", reason: onlyRead })),
  { family: "clipboard", sub: "history", flag: "--type", reason: onlyRead },
  ...["read", "write", "tail", "clear", "types"].map(sub => ({ family: "clipboard", sub, flag: "--limit", reason: onlyHistory })),
  { family: "files", flag: "--filter", reason: legacy },
  { family: "files", flag: "--app", reason: legacy },
  { family: "files", sub: "watch", flag: "--pid", reason: selectors },
  { family: "files", sub: "unwatch", flag: "--limit", reason: selectors },
  { family: "files", sub: "unwatch", flag: "--pid", reason: selectors },
]
