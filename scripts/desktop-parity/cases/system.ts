// System families: notifications, health, update, trust, tcc, and the `desktop status|capabilities|providers`
// hello spellings. Every subcommand and flag from the CLI inventory appears below.
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Case, type Ctx, type Exclusion, type Family, type Res, macOnly, ok, refuse } from "../types"
import { contains } from "./helpers"

type Check = NonNullable<Case["check"]>
/** Runs a success check only when the host actually succeeded (checks also run after a passing refusal). */
const okc = (f: Check): Check => (r, ctx) => r.exit === 0 && r.json?.success !== false ? f(r, ctx) : undefined
const nope = refuse("unsupported_operation")
/** Parser-side refusal (cli/commands/macos.ts desktop branch prints code invalid_request). */
const bad = refuse("invalid_request")
/** Apple-only contract fields: Windows and Linux providers refuse with unsupported_operation. */
const apple = macOnly("unsupported_operation")

// --- notifications -------------------------------------------------------------------
const NS = "interceptor-parity"
const n = (...a: string[]) => ["notifications", ...a, "--namespace", NS]
const CATEGORY = "interceptor-parity-category"
const ACTIONS = JSON.stringify([{ identifier: "interceptor-parity-ack", title: "Interceptor Parity Ack" }])
/** Exact names each provider can observe (Linux/Windows accept only their native toast signals). */
const TAIL: Record<string, string> = {
  darwin: "com.apple.screenIsLocked",
  linux: "org.freedesktop.Notifications.NotificationClosed",
  win32: "Windows.UI.Notifications.ToastNotification.Dismissed",
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
/** A fresh owned 1x1 PNG per use (macOS moves attachment files into its own store). */
function image(ctx: Ctx, id?: string): string {
  const path = join(ctx.dir, `Interceptor Parity image ${(ctx.vars.images = (ctx.vars.images ?? 0) + 1)}.png`)
  writeFileSync(path, Buffer.from(PNG, "base64"))
  return id ? `${id}=${path}` : path
}
const content = (id: string) => ["--id", id, "--title", `Interceptor Parity ${id}`, "--subtitle", "Interceptor Parity subtitle", "--body", "Interceptor Parity body", "--user-info", JSON.stringify({ parity: true, id })]
const APPLE_CONTENT = ["--sound", "default", "--badge", "1", "--thread", "interceptor-parity-thread", "--interruption", "passive"]
const CONTENT_FLAGS = ["--id", "--title", "--subtitle", "--body", "--user-info", "--category", "--attachment", "--namespace"]
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()
/** Receipt identity check; records that the item exists so later inventory checks can expect it. */
const receipt = (id: string): Check => okc((r, ctx) => { ctx.vars[id] = true; return r.json?.identifier === id ? undefined : `receipt identifier ${r.json?.identifier} != ${id}` })
const listed = (...ids: string[]): Check => okc((r, ctx) => { for (const id of ids) if (ctx.vars[id]) { const e = contains(id)(r); if (e) return e } })
const removed = (id: string): Check => okc((r, ctx) => ctx.vars[id] && !r.json?.removed?.includes(id) ? `removal lacks ${id}: ${JSON.stringify(r.json).slice(0, 200)}` : undefined)
const status: Check = okc(r => r.json?.scope === "application" && r.json?.provider ? undefined : `status lacks application scope/provider: ${JSON.stringify(r.json).slice(0, 200)}`)
const entries: Check = okc(r => Array.isArray(r.json?.entries) ? undefined : "no entries array")
const badge = (count: number): Check => okc(r => r.json?.count === count ? undefined : `badge count ${r.json?.count} != ${count}`)

async function cleanNotifications(ctx: Ctx) {
  for (const args of [n("cancel-all"), n("dismiss-all"), n("categories", "clear"), n("untail", "--name", TAIL[ctx.host])]) await ctx.run(args).catch(() => {})
  if (ctx.vars.badged) await ctx.run(n("badge", "clear")).catch(() => {})
}

const notifications: Family = {
  family: "notifications",
  setup: cleanNotifications,
  teardown: cleanNotifications,
  cases: [
    { id: "notifications.status", sub: "status", args: n("status"), check: status },
    { id: "notifications.settings", sub: "settings", args: n("settings"), check: status },
    { id: "notifications.request-empty-options", sub: "request", args: n("request", "--options", ""), expect: { all: refuse("invalid_request", /at least one option/) } },
    { id: "notifications.request", sub: "request", args: n("request", "--options", "alert,sound,badge"), check: contains("authorizationStatus") },
    { id: "notifications.tail", sub: "tail", args: ctx => n("tail", "--name", TAIL[ctx.host]), flags: ["--name", "--namespace"], check: okc(r => r.json?.tailing === true ? undefined : "tail did not report tailing") },
    { id: "notifications.tail-no-name", sub: "tail", args: n("tail"), expect: { all: bad } },
    { id: "notifications.log", sub: "log", args: n("log", "--limit", "20"), check: entries },
    { id: "notifications.log-app", sub: "log", args: n("log", "--app", "Interceptor", "--limit", "5"), expect: { all: nope, darwin: ok }, check: entries },
    { id: "notifications.categories-default", sub: "categories", args: n("categories") },
    { id: "notifications.categories-register", sub: "categories", args: n("categories", "register", "--identifier", CATEGORY, "--actions", ACTIONS),
      check: okc(r => r.json?.identifier === CATEGORY ? undefined : "category receipt differs") },
    { id: "notifications.categories-register-apple", sub: "categories", expect: apple,
      args: n("categories", "register", "--identifier", "interceptor-parity-apple-category", "--actions", "[]", "--intent-identifiers", "interceptor.parity.intent", "--summary-format", "%u Interceptor Parity items", "--hidden-placeholder", "%u hidden") },
    { id: "notifications.categories-list", sub: "categories", args: n("categories", "list"), check: okc(contains(CATEGORY)) },
    { id: "notifications.post", sub: "post", args: n("post", ...content("interceptor-parity-post")), disruptive: true, check: receipt("interceptor-parity-post") },
    { id: "notifications.post-category-attachment", sub: "post", disruptive: true, flags: CONTENT_FLAGS, check: receipt("interceptor-parity-attach"),
      args: ctx => n("post", ...content("interceptor-parity-attach"), "--category", CATEGORY, "--attachment", image(ctx, "parity-image")) },
    { id: "notifications.post-sound", sub: "post", args: n("post", ...content("interceptor-parity-sound"), "--sound", "default"), disruptive: true,
      expect: { linux: nope }, check: receipt("interceptor-parity-sound") }, // mako advertises no "sound" capability
    { id: "notifications.post-apple", sub: "post", args: n("post", ...content("interceptor-parity-apple"), ...APPLE_CONTENT), disruptive: true, expect: apple },
    { id: "notifications.delivered", sub: "delivered", args: n("delivered", "--limit", "100"), check: listed("interceptor-parity-post", "interceptor-parity-attach") },
    { id: "notifications.dismiss-positional", sub: "dismiss", args: n("dismiss", "interceptor-parity-post"), check: removed("interceptor-parity-post") },
    { id: "notifications.dismiss-id", sub: "dismiss", args: n("dismiss", "--id", "interceptor-parity-attach"), check: removed("interceptor-parity-attach") },
    { id: "notifications.dismiss-all", sub: "dismiss-all", args: n("dismiss-all"), check: okc(r => Array.isArray(r.json?.removed) ? undefined : "no removed list") },
    { id: "notifications.schedule-after", sub: "schedule-after", disruptive: true, flags: [...CONTENT_FLAGS, "--seconds", "--repeats"], check: receipt("interceptor-parity-after"),
      args: ctx => n("schedule-after", ...content("interceptor-parity-after"), "--seconds", "3600", "--repeats", "--category", CATEGORY, "--attachment", image(ctx)) },
    { id: "notifications.schedule-after-apple", sub: "schedule-after", args: n("schedule-after", ...content("interceptor-parity-after-apple"), ...APPLE_CONTENT, "--seconds", "7200"), disruptive: true, expect: apple },
    { id: "notifications.schedule-at", sub: "schedule-at", disruptive: true, flags: [...CONTENT_FLAGS, "--date"], check: receipt("interceptor-parity-at"),
      args: ctx => n("schedule-at", ...content("interceptor-parity-at"), "--date", inHours(2), "--category", CATEGORY, "--attachment", image(ctx)) },
    { id: "notifications.schedule-at-apple", sub: "schedule-at", disruptive: true, expect: apple, flags: ["--date", ...APPLE_CONTENT.filter(a => a.startsWith("--"))],
      args: () => n("schedule-at", ...content("interceptor-parity-at-apple"), ...APPLE_CONTENT, "--date", inHours(3)) },
    { id: "notifications.schedule-at-repeats", sub: "schedule-at", expect: { all: bad }, flags: ["--date", "--repeats"],
      args: () => n("schedule-at", ...content("interceptor-parity-at-repeats"), "--date", inHours(2), "--repeats") },
    { id: "notifications.schedule-cron", sub: "schedule-cron", disruptive: true, flags: [...CONTENT_FLAGS, "--components", "--repeats"], check: receipt("interceptor-parity-cron"),
      args: ctx => n("schedule-cron", ...content("interceptor-parity-cron"), "--components", "hour=3,minute=17,second=0", "--repeats", "--category", CATEGORY, "--attachment", image(ctx)) },
    { id: "notifications.schedule-cron-apple", sub: "schedule-cron", disruptive: true, expect: apple,
      args: n("schedule-cron", ...content("interceptor-parity-cron-apple"), ...APPLE_CONTENT, "--components", "month=12,day=31,hour=23,minute=59,second=0") },
    { id: "notifications.pending", sub: "pending", args: n("pending", "--limit", "100"), check: listed("interceptor-parity-after", "interceptor-parity-at", "interceptor-parity-cron") },
    { id: "notifications.cancel-positional", sub: "cancel", args: n("cancel", "interceptor-parity-after"), check: removed("interceptor-parity-after") },
    { id: "notifications.cancel-id", sub: "cancel", args: n("cancel", "--id", "interceptor-parity-at"), check: removed("interceptor-parity-at") },
    { id: "notifications.cancel-all", sub: "cancel-all", args: n("cancel-all"), check: removed("interceptor-parity-cron") },
    // Freedesktop has no application badge API.
    { id: "notifications.badge-positional", sub: "badge", disruptive: true, expect: { linux: nope }, flags: ["--namespace"], check: badge(3),
      args: ctx => { ctx.vars.badged = true; return n("badge", "3") } },
    { id: "notifications.badge-count", sub: "badge", args: n("badge", "--count", "2"), disruptive: true, expect: { linux: nope }, check: badge(2) },
    { id: "notifications.badge-clear", sub: "badge", args: n("badge", "clear"), disruptive: true, expect: { linux: nope }, check: badge(0) },
    { id: "notifications.categories-clear", sub: "categories", args: n("categories", "clear") },
    { id: "notifications.untail", sub: "untail", args: ctx => n("untail", "--name", TAIL[ctx.host]), flags: ["--name", "--namespace"],
      check: okc(r => r.json?.tailing === false ? undefined : "untail still reports tailing") },
  ],
}

// --- health, update ------------------------------------------------------------------
const available: Check = okc(r => typeof r.json?.available === "boolean" ? undefined : "health lacks a boolean available")
const updateState: Check = okc(r => typeof r.json?.canCheckForUpdates === "boolean" && typeof r.json?.sessionInProgress === "boolean" ? undefined : `update state lacks canCheckForUpdates/sessionInProgress: ${JSON.stringify(r.json).slice(0, 200)}`)

// --- trust ---------------------------------------------------------------------------
const readOnlyTrust: Check = okc(r => {
  if (!Array.isArray(r.json?.permissions) || !r.json.permissions.length) return "no permission diagnostics"
  const changed = ["prompted", "opened", "pending_user_action"].filter(k => r.json[k]?.length)
  return changed.length ? `read-only trust reported ${changed.join(", ")}` : undefined
})

// --- desktop status ------------------------------------------------------------------
const rows = (r: Res): any[] => Array.isArray(r.json?.capabilities) ? r.json.capabilities : []
const hello: Check = (r, ctx) => {
  if (r.json?.host !== ctx.host || r.json?.protocolVersion !== 1) return `hello host/protocol ${r.json?.host}/${r.json?.protocolVersion}`
  const wanted = ["notifications", "health", "update", "trust", ...(ctx.host === "darwin" ? ["tcc"] : [])]
  const missing = wanted.filter(op => !rows(r).some(c => c.operation === op && c.compiled && c.present))
  return missing.length ? `operations not compiled+present: ${missing.map(op => `${op} (${rows(r).find(c => c.operation === op)?.reason ?? "no row"})`).join(", ")}` : undefined
}
/** Every row has its identity and flags, and every effective:false row says why. */
const honest: Check = r => {
  if (!rows(r).length) return "no capability rows"
  const wrong = rows(r).filter(c => typeof c.operation !== "string" || ["compiled", "present", "effective"].some(k => typeof c[k] !== "boolean") || (c.effective === false && !String(c.reason ?? "").trim()))
  return wrong.length ? `R3: ${wrong.length} rows lack operation/compiled/present/effective or a reason for effective:false: ${wrong.map(c => c.operation).join(", ")}` : undefined
}

export const system: Family[] = [
  {
    family: "desktop-status",
    cases: [
      { id: "desktop-status.status", sub: "status", args: ["status"], check: hello },
      { id: "desktop-status.capabilities", sub: "capabilities", args: ["capabilities"], check: honest },
      { id: "desktop-status.providers", sub: "providers", args: ["providers"], check: r => r.json?.provider && r.json?.version ? undefined : "hello lacks provider/version" },
    ],
  },
  {
    family: "health",
    cases: [
      { id: "health.default", sub: "status", args: ["health"], check: available },
      { id: "health.status", sub: "status", args: ["health", "status"], check: available },
      { id: "health.unknown-op", sub: "status", args: ["health", "read"], expect: { all: bad } },
    ],
  },
  {
    family: "update",
    cases: [
      { id: "update.default", sub: "status", args: ["update"], check: updateState },
      { id: "update.status", sub: "status", args: ["update", "status"], check: updateState },
      // Rust check reads release metadata only; Sparkle on the Mac may raise its update window, so it stays off a Mac someone is using.
      { id: "update.check", sub: "check", args: ["update", "check"], disruptive: true, timeoutMs: 60_000,
        check: okc((r, ctx) => updateState(r, ctx) ?? (r.json?.signatureVerified === true ? "metadata check claims a verified signature" : undefined)) },
      { id: "update.install-refused", sub: "check", args: ["update", "install"], expect: { all: bad } },
    ],
  },
  {
    family: "trust",
    cases: [
      { id: "trust.status", sub: "-", args: ["trust"], check: readOnlyTrust },
      { id: "trust.no-prompt-overrides", sub: "-", args: ["trust", "--no-prompt", "--prompt", "--walkthrough", "--accessibility-prompt", "--screen-prompt", "--microphone-prompt", "--speech-prompt"], check: readOnlyTrust },
      { id: "trust.prompt", sub: "-", args: ["trust", "--prompt"], disruptive: true, expect: apple },
      // Windows opens the native microphone privacy page: the explicit purpose of these two flags.
      { id: "trust.walkthrough", sub: "-", args: ["trust", "--walkthrough"], disruptive: true, focus: "allowed", expect: { linux: nope } },
      { id: "trust.microphone-prompt", sub: "-", args: ["trust", "--microphone-prompt"], disruptive: true, focus: "allowed", expect: { linux: nope } },
      { id: "trust.apple-prompts", sub: "-", args: ["trust", "--accessibility-prompt", "--screen-prompt", "--speech-prompt"], disruptive: true, expect: apple },
      { id: "trust.unknown-flag", sub: "-", args: ["trust", "--bogus"], expect: { all: bad } },
      { id: "trust.speech-read-only", sub: "speech", args: ["trust", "speech", "--no-prompt"], check: readOnlyTrust },
      { id: "trust.speech", sub: "speech", args: ["trust", "speech"], disruptive: true, expect: apple },
      { id: "trust.speech-prompt", sub: "speech", args: ["trust", "speech", "--prompt"], disruptive: true, expect: apple },
    ],
  },
  {
    family: "tcc",
    cases: [
      { id: "tcc.default", sub: "status", args: ["tcc"], expect: apple, check: okc(contains("serviceMatrix")) },
      { id: "tcc.status-target", sub: "status", args: ["tcc", "status", "--target", "host"], expect: apple, check: okc(contains("serviceMatrix")) },
      { id: "tcc.profile-out", sub: "profile generate", expect: apple,
        flags: ["--target", "--service", "--out", "--bundle-id", "--identifier-type", "--code-requirement", "--include-user-only"],
        args: ctx => ["tcc", "profile", "generate", "--target", "host", "--service", "Accessibility,PostEvent", "--service", "SystemPolicyDesktopFolder",
          "--out", (ctx.vars.tccOut = join(ctx.dir, "Interceptor Parity TCC.mobileconfig")), "--bundle-id", "com.interceptor.parity-fixture",
          "--identifier-type", "bundleID", "--code-requirement", 'identifier "com.interceptor.parity-fixture"', "--include-user-only"],
        check: okc((_r, ctx) => existsSync(ctx.vars.tccOut) ? undefined : "profile file was not written") },
      { id: "tcc.profile-path-full-disk", sub: "profile generate", expect: apple, flags: ["--target", "--identifier-type", "--app-path", "--full-disk"],
        args: ctx => ["tcc", "profile", "generate", "--target", "guest", "--identifier-type", "path", "--app-path", join(ctx.dir, "..", "InterceptorParityFixture.app"), "--full-disk"],
        check: okc(contains("SystemPolicyAllFiles")) },
      { id: "tcc.unknown", sub: "status", args: ["tcc", "bogus"], expect: { all: refuse() } },
    ],
  },
  notifications,
]

/** Every inventory flag of these families is exercised; Apple-only ones refuse on Windows/Linux above. */
export const systemExclusions: Exclusion[] = []
