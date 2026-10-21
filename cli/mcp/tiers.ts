/**
 * cli/mcp/tiers.ts — capability-tier classifier + operator-allowlist gate.
 *
 * Every Interceptor verb is classified into one of four tiers by (surface, verb,
 * sub-verb). The gate is the ONLY security boundary: READ + MUTATE run by
 * default; DESTRUCTIVE + EXEC fail-closed until the OPERATOR sets
 * INTERCEPTOR_MCP_ALLOW. A model-supplied `confirm` is a secondary speed-bump —
 * it can never lift a tier the operator did not allow.
 *
 * Fail-safe rule: a "mixed" verb family (its sub-verbs span tiers, e.g. `vm`,
 * `app`, `runtime`) defaults an UNKNOWN sub-verb to its HIGHEST tier, so a novel
 * sub-verb is gated, never silently run. Benign verbs default to MUTATE.
 *
 * Tier tables are grounded in the CLI surface (enumerated against cli/commands/*.ts,
 * native.ts, cdp.ts, ios*.ts). Keep in lockstep when verbs are added.
 */

import { normalizeArgsSplit } from "../normalize"
import { BUILTIN_BRIDGE_PREFIXES } from "../../shared/extensions"

export type Surface = "browser" | "macos" | "desktop" | "ios" | "local"
export type Tier = "read" | "mutate" | "destructive" | "exec"

const TIER_RANK: Record<Tier, number> = { read: 0, mutate: 1, destructive: 2, exec: 3 }

/** `surface:verb` or `surface:verb:sub` → tier. Most-specific key wins. */
type TierMap = Record<string, Tier>

// ── READ (no state change) ────────────────────────────────────────────────────
const READ_VERBS: Record<Surface, Set<string>> = {
  desktop: new Set(),
  browser: new Set([
    "state", "tree", "diff", "find", "text", "html", "links", "images",
    "forms", "query", "exists", "count", "table", "attr", "style", "screenshot",
    "net", "network", "headers", "inspect", "tabs", "read", "status", "meta",
    "info", "page_info", "events", "modals", "panels", "sessions", "capabilities",
    "delegate", "idle", "history", "bookmarks", "downloads", "frames", "canvas",
    "ocr", "what-at", "contexts", "manifest",
  ]),
  macos: new Set([
    "tree", "find", "inspect", "focused", "windows", "text", "menu", "apps",
    "frontmost", "screenshot", "vision", "nlp", "sensitive", "health", "files",
    "log", "sounds", "detect", "translate", "thumbnail", "read", "capture", "notifications", "audio", "vad", "listen", "trust", "stream",
  ]),
  ios: new Set([
    "tree", "find", "inspect", "screenshot", "apps", "status", "devices",
    "discover", "diag", "crash", "profiles", "springboard", "proc", "ps", "top",
    "gpu", "shot", "axtree", "screen", "backup", "logs", "notify",
    // The newest frame the stream already delivered; nothing is sent to the phone.
    "frame",
  ]),
  local: new Set([
    "status", "manifest", "diagnose", "extensions", "contexts", "capabilities",
  ]),
}
READ_VERBS.desktop = new Set([...READ_VERBS.macos, "status", "capabilities", "providers"])

// ── ARBITRARY-EXEC (runs attacker-or-model-authored code) ─────────────────────
const EXEC: TierMap = {
  "browser:eval": "exec", "browser:save": "exec", "browser:raw": "exec",
  "macos:script": "exec", "macos:intent": "exec", "macos:container": "exec",
  // issue #244: sudo runs an arbitrary command as root; reveal prints a secret
  // to a human and is refused for model callers anyway (INTERCEPTOR_MCP).
  "macos:sudo": "exec", "macos:secret:reveal": "exec",
  "macos:overlay:eval": "exec",
  "macos:vm:exec": "exec",
  "macos:cdp:raw": "exec",
  "ios:eval": "exec", "ios:spawn": "exec",
  "ios:web:eval": "exec", "ios:web:call": "exec",
}

// ── DESTRUCTIVE (irreversible / high-impact / exfil) by exact key ─────────────
const DESTRUCTIVE_SUB: TierMap = {
  "local:upgrade": "destructive",
  "local:update:install": "destructive",
  // Deletes saved tab groups through the browser's own UI; there is no undo.
  "browser:group:prune": "destructive",
  // macOS app lifecycle
  "macos:app:quit": "destructive", "macos:app:terminate": "destructive",
  // macOS fs / display / tcc
  "macos:fs:write": "destructive", "macos:display:set": "destructive",
  "macos:tcc:profile": "destructive",
  // macOS vm lifecycle (list/get/inspect/read-ax/logs/screenshot are read; rest destructive)
  "macos:vm:create": "destructive", "macos:vm:delete": "destructive",
  "macos:vm:reset": "destructive", "macos:vm:stop": "destructive",
  "macos:vm:restore": "destructive", "macos:vm:start": "destructive",
  "macos:vm:clone": "destructive", "macos:vm:adopt": "destructive",
  "macos:vm:install": "destructive", "macos:vm:pull": "destructive",
  // macOS runtime (enable/disable re-sign + load; the exec ones are in EXEC)
  "macos:runtime:enable": "destructive", "macos:runtime:disable": "destructive",
  // macOS update install
  "macos:update:install": "destructive",
  // issue #244: vault deletion and filling the admin prompt.
  "macos:secret:rm": "destructive", "macos:authdialog:fill": "destructive",
  // iOS lifecycle / device-mutating
  "ios:app:terminate": "destructive",
  // iOS fs push (write into app container)
  "ios:fs:push": "destructive",
  // iOS web mutating raw call
  "ios:web:call:--mutating": "destructive",
}

// Personal-data CRUD sub-verbs that are destructive (create/update/delete/…).
const PD_WRITE_SUBS = new Set([
  "create", "update", "delete", "move", "reset", "create-calendar",
  "delete-calendar", "album-create", "album-delete", "album-rename",
  "group-create", "group-update", "group-delete", "group-add-member",
  "group-remove-member", "import", "import-video", "import-vcard", "favorite",
  "hide", "add-to-album", "remove-from-album", "complete", "uncomplete",
])
const PD_VERBS = new Set(["calendar", "reminders", "contacts", "photos"])
// macOS share = data exfiltration; these sub-verbs send.
const SHARE_SEND = new Set([
  "airdrop", "email", "message", "named", "text", "url", "reading-list", "desktop-picture",
])
// macOS pdf writers.
const PDF_WRITE = new Set(["annotate", "strip", "merge", "split", "forms_set"])

// "Mixed family" verbs: an unknown sub-verb defaults to the family floor (high).
const FAMILY_FLOOR: Record<string, Tier> = {
  "macos:vm": "destructive",
  "macos:runtime": "exec",
  "macos:cdp": "destructive",
  "macos:app": "destructive",
  "macos:share": "destructive",
  "macos:pdf": "destructive",
  "macos:tcc": "destructive",
  "macos:fs": "destructive",
  "macos:clipboard": "mutate",
  "macos:calendar": "destructive",
  "macos:reminders": "destructive",
  "macos:contacts": "destructive",
  "macos:photos": "destructive",
  // issue #244: the vault, the admin-prompt filler, and the Touch ID prompt.
  "macos:secret": "destructive",
  "macos:authdialog": "destructive",
  "macos:auth": "mutate",
  "macos:files": "mutate",
  "ios:app": "destructive",
  "ios:web": "mutate",
  "ios:fs": "destructive",
}

/** First non-flag token after the verb (the sub-verb), else "". */
function subVerbOf(args: string[]): string {
  for (const a of args) {
    if (!a.startsWith("-")) return a
    // `--mutating` etc. handled by caller via full-args scan
  }
  return ""
}

export type Classification = { tier: Tier; surface: Surface; verb: string; sub: string }

/**
 * Classify a call. `verb` is the top-level verb (for macos/ios this is args[0]
 * of the surface command, e.g. "vm"); `args` are the remaining tokens.
 */
export function classify(surface: Surface, verb: string, args: string[]): Classification {
  if (surface === "desktop") {
    if (["status", "capabilities", "providers"].includes(verb)) return { tier: "read", surface, verb, sub: subVerbOf(args) }
    return { ...classify("macos", verb, args), surface }
  }
  // Notification reads require the operation first. A leading flag's value
  // must never classify a later post/cancel as a read-only operation.
  const sub = surface === "macos" && verb === "notifications" ? args[0] ?? "" : subVerbOf(args)
  const key3 = `${surface}:${verb}:${sub}`
  const key2 = `${surface}:${verb}`

  if(surface==='macos'&&verb==='overlay'){
    if(['list','status','verbs'].includes(args[0]))return mk('read')
    if(['stop','ctl'].includes(args[0]))return mk('mutate')
    // HTML and URLs can execute page code; malformed/unknown selectors
    // cannot inherit a lower tier from a flag value.
    return mk('exec')
  }
  if(surface==='macos'&&verb==='audio')return mk(['input','output','both'].includes(args[0])&&['level','devices'].includes(args[1])?'read':'mutate')
  if(surface==='macos'&&verb==='vad')return mk(args[0]===undefined||args[0]==='status'?'read':'mutate')
  if(surface==='macos'&&verb==='listen')return mk(args[0]===undefined||['status','transcript','tail'].includes(args[0])||args[0]==='vocab'&&(args[1]===undefined||args[1]==='list')?'read':'mutate')
  if(surface==='macos'&&verb==='trust'){
    const flags=new Set(['--no-prompt','--prompt','--walkthrough','--accessibility-prompt','--screen-prompt','--microphone-prompt','--speech-prompt'])
    if(args.some((value,index)=>!flags.has(value)&&(index!==0||value!=='speech')))return mk('mutate')
    return mk(args.includes('--no-prompt')||args.length===0?'read':'mutate')
  }
  if(surface==='macos'&&verb==='stream')return mk(args[0]===undefined||['status','list','frame','fps','resolution'].includes(args[0])||args[0]==='record'&&(args[1]===undefined||args[1]==='status')?'read':'mutate')
  if(surface==='macos'&&verb==='sounds')return mk(args[0]===undefined||['status','tail','log'].includes(args[0])?'read':'mutate')
  if(surface==='macos'&&verb==='sensitive')return mk(args[0]===undefined||args[0]==='check'||args[0]==='monitor'&&(args[1]===undefined||args[1]==='status')?'read':'mutate')
  if((surface==='macos'||surface==='local')&&verb==='update'&&args.length<=1&&(args[0]===undefined||['check','status'].includes(args[0])))return mk('read')
  if((surface==='macos'||surface==='local')&&verb==='location')return mk(['status','current','geocode','reverse','distance','postal-geocode'].includes(args[0])||args[0]==='monitor'&&args[1]==='tail'?'read':'mutate')
  if((surface==='macos'||surface==='local')&&verb==='maps')return mk(['search','complete','directions','eta','reverse'].includes(args[0])?'read':'mutate')
  if((surface==='macos'||surface==='local')&&verb==='music')return mk(['status','subscription','library','library-search','queue','now-playing'].includes(args[0])?'read':'mutate')

  if (surface === 'macos' && verb === 'notifications') {
    // Bare notifications starts a subscription, and category registration
    // must never inherit the read tier of category listing.
    if (['status','settings','log','pending','delivered'].includes(sub)) return mk('read')
    if (sub === 'categories') return mk(args[1] === undefined || args[1] === 'list' ? 'read' : 'mutate')
    return mk('mutate')
  }

  if ((surface === "browser" || surface === "local") && verb === "monitor") {
    const normalized = normalizeArgsSplit([verb, ...args]).argv
    if (normalized[1] === "task") {
      const op = normalized[2]
      if (op === "resume") return mk("read")
      if (["create", "checkpoint", "attach", "snapshot", "repair", "quality", "diagnose", "compile-blueprint"].includes(op)) return mk("mutate")
      // verify/complete execute stored author-supplied JavaScript. Unknown task verbs fail closed.
      return mk("exec")
    }
  }

  if (["macos","local","desktop"].includes(surface) && verb === "share") return mk(sub === "services" ? "read" : "destructive")

  // 1. exec (highest) — exact sub, then whole verb.
  if (EXEC[key3]) return mk("exec")
  if (EXEC[key2]) return mk("exec")
  // `ios web call --mutating` special: exec already covers `ios:web:call`.

  // 2. destructive — exact sub overrides.
  if (DESTRUCTIVE_SUB[key3]) return mk("destructive")
  if (DESTRUCTIVE_SUB[key2]) return mk("destructive")
  if (surface === "macos" && verb === "thumbnail" && args.some(arg => arg === "--save" || arg === "--out" || arg.startsWith("--out="))) return mk("destructive")
  if (["macos","local","desktop"].includes(surface) && verb === "share" && SHARE_SEND.has(sub)) return mk("destructive")
  if (surface === "macos" && verb === "pdf" && PDF_WRITE.has(sub)) return mk("destructive")
  if (surface === "macos" && verb === "pdf" && args[0] === "forms" && args[1] === "set") return mk("destructive")
  if (surface === "macos" && PD_VERBS.has(verb) && PD_WRITE_SUBS.has(sub)) return mk("destructive")
  if (surface === "ios" && (verb === "setup" || verb === "refresh" || verb === "install" ||
      verb === "login" || verb === "logout" || verb === "kill")) return mk("destructive")
  if (surface === "ios" && verb === "location" && sub === "set") return mk("destructive")
  if (surface === "ios" && verb === "profiles" && (sub === "install" || sub === "remove")) return mk("destructive")
  // `diagnose extension --fix/--prompt` quits and restarts the user's browser; --welcome opens browser tabs.
  if (surface === "local" && verb === "diagnose" && (args.includes("--fix") || args.includes("--prompt") || args.includes("--welcome"))) return mk("destructive")

  // 3. read — whole verb reads, unless a mixed family says otherwise.
  if (READ_VERBS[surface]?.has(verb)) {
    // Mixed families keep read for their read sub-verbs but floor unknown subs.
    if (!FAMILY_FLOOR[key2]) return mk("read")
  }
  // Mixed-family read sub-verbs (e.g. `vm list`, `runtime status`).
  if (FAMILY_FLOOR[key2] && isFamilyRead(surface, verb, sub)) return mk("read")
  // Mixed-family known-safe mutate sub-verbs (e.g. `app activate`).
  if (FAMILY_FLOOR[key2] && isFamilyMutate(surface, verb, sub)) return mk("mutate")

  // 4. mixed-family floor for an unknown sub-verb (fail-safe high).
  if (FAMILY_FLOOR[key2] && sub) return mk(FAMILY_FLOOR[key2])
  if (FAMILY_FLOOR[key2] && !sub) return mk("read") // bare family verb = its listing/help

  // Private or unknown native prefixes can run operator code. The existing
  // router registry covers core prefixes; open/act are its compound CLI aliases.
  // Do not depend on a manifest appearing before classification or cache it.
  return mk(surface === "macos" && !BUILTIN_BRIDGE_PREFIXES.has(verb) &&
    !["open", "act"].includes(verb) ? "exec" : "mutate")

  function mk(tier: Tier): Classification { return { tier, surface, verb, sub } }
}

const FAMILY_READ_SUBS: Record<string, Set<string>> = {
  "macos:vm": new Set(["list", "get", "inspect", "read-ax", "logs", "screenshot"]),
  "macos:runtime": new Set([
    "discover", "status", "signid", "tree", "layers", "screenshot", "ping", "ax",
    "file", "hooks", "events", "domains", "net",
  ]),
  "macos:cdp": new Set(["targets", "status", "discover"]),
  "macos:app": new Set([]),
  "macos:share": new Set(["services"]),
  "macos:pdf": new Set(["info", "text", "outline", "annotations", "forms", "images", "find", "attributes", "permissions"]),
  "macos:tcc": new Set(["status"]),
  "macos:fs": new Set(["read", "search"]),
  "macos:clipboard": new Set(["read"]),
  "macos:calendar": new Set(["status", "list", "default", "sources", "events", "event", "event-by-external", "tail"]),
  "macos:reminders": new Set(["status", "lists", "default", "all", "incomplete", "completed"]),
  "macos:contacts": new Set(["status", "containers", "default-container", "groups", "group", "list", "contact", "me", "find", "vcard", "current-token", "changes"]),
  "macos:photos": new Set(["status", "albums", "album", "assets", "asset", "thumbnail", "export", "export-video", "export-live", "current-token", "changes"]),
  "macos:secret": new Set(["list", "status"]),
  "macos:authdialog": new Set(["status"]),
  "macos:auth": new Set(["status", "domain-state"]),
  "macos:files": new Set(["recent", "open"]),
  "ios:app": new Set([]),
  "ios:web": new Set(["targets", "status", "explain", "read", "text", "find", "inspect", "console", "network", "screenshot"]),
  "ios:fs": new Set(["ls"]),
}
const FAMILY_MUTATE_SUBS: Record<string, Set<string>> = {
  "macos:app": new Set(["activate", "launch", "focus", "hide", "unhide"]),
  "macos:tcc": new Set([]),
  "macos:secret": new Set(["register", "set", "unlock", "lock"]),
  "macos:auth": new Set(["confirm", "invalidate"]),
  "macos:files": new Set(["watch", "unwatch"]),
  "ios:app": new Set(["launch", "activate"]),
  "ios:web": new Set(["attach", "detach", "click", "type", "keys", "scroll", "calibrate"]),
  "ios:fs": new Set(["pull"]),
}
function isFamilyRead(surface: Surface, verb: string, sub: string): boolean {
  return FAMILY_READ_SUBS[`${surface}:${verb}`]?.has(sub) ?? false
}
function isFamilyMutate(surface: Surface, verb: string, sub: string): boolean {
  return FAMILY_MUTATE_SUBS[`${surface}:${verb}`]?.has(sub) ?? false
}

// ── Operator allowlist gate ───────────────────────────────────────────────────

export type AllowSet = {
  tiers: Set<Tier>
  verbs: Set<string> // "surface:verb"
  raw: boolean
  all: boolean
}

/** Parse INTERCEPTOR_MCP_ALLOW into an allow set. Unset ⇒ empty (read+mutate still run). */
export function parseAllow(env: string | undefined): AllowSet {
  const tiers = new Set<Tier>()
  const verbs = new Set<string>()
  let raw = false
  let all = false
  for (const tokRaw of (env || "").split(",")) {
    const tok = tokRaw.trim().toLowerCase()
    if (!tok) continue
    if (tok === "all") { all = true; continue }
    if (tok === "raw" || tok === "ext") { raw = true; continue }
    if (tok === "destructive") { tiers.add("destructive"); continue }
    if (tok === "exec" || tok === "arbitrary-exec") { tiers.add("exec"); continue }
    if (tok === "read") { tiers.add("read"); continue }
    if (tok === "mutate") { tiers.add("mutate"); continue }
    if (tok.includes(":")) { verbs.add(tok); continue } // surface:verb
  }
  return { tiers, verbs, raw, all }
}

export type GateResult = { allowed: boolean; needsConfirm: boolean; reason?: string }

/**
 * Decide whether a classified call may run.
 * - read/mutate: always allowed (the default posture).
 * - destructive/exec: allowed ONLY if the operator allowed the tier / verb / all;
 *   then additionally require confirm:true as a speed-bump.
 */
export function gate(c: Classification, allow: AllowSet, confirm: boolean): GateResult {
  if (c.tier === "read" || c.tier === "mutate") return { allowed: true, needsConfirm: false }

  const verbKey = `${c.surface}:${c.verb}`
  const operatorAllowed = allow.all || allow.tiers.has(c.tier) || allow.verbs.has(verbKey)
  if (!operatorAllowed) {
    const flag = c.tier === "exec" ? "arbitrary-exec" : "destructive"
    return {
      allowed: false,
      needsConfirm: false,
      reason: `'${c.surface} ${c.verb}${c.sub ? " " + c.sub : ""}' is ${c.tier.toUpperCase()} and disabled. ` +
        `The OPERATOR (not the model) must relaunch interceptor-mcp with ` +
        `INTERCEPTOR_MCP_ALLOW=${flag} (or =${verbKey}, or =all) to enable it.`,
    }
  }
  if (!confirm) {
    return {
      allowed: false,
      needsConfirm: true,
      reason: `'${c.surface} ${c.verb}${c.sub ? " " + c.sub : ""}' is ${c.tier.toUpperCase()} and operator-allowed, ` +
        `but requires confirm:true on this call to proceed.`,
    }
  }
  return { allowed: true, needsConfirm: false }
}

export { TIER_RANK, READ_VERBS }
