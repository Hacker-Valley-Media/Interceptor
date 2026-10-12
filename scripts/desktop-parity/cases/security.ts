// Vault and authentication: secret, auth, authdialog, sudo. Every subcommand and flag
// from the CLI inventory appears below or in securityExclusions with the reason.
// The vault is daemon-owned on every host; the owned secret is never printed.
import { join } from "node:path"
import { homedir } from "node:os"
import { type Ctx, type Exclusion, type Family, type Res, errorText, refuse, skip } from "../types"
import { pid, text, windowId } from "./helpers"

const NAME = "interceptor-parity-secret"
// ponytail: synthetic by default. A VM whose sudo needs a password sets
// INTERCEPTOR_PARITY_SUDO_PASSWORD so `sudo -S` can pass; it only travels on stdin.
const VALUE = process.env.INTERCEPTOR_PARITY_SUDO_PASSWORD || "parity-synthetic-value-not-a-password"
const LEASE = "0".repeat(64)
const PERSON = "needs a person at the Touch ID prompt"
const exposesValue = (r: Res) => text(r).includes(VALUE) ? "result exposes the secret value" : undefined

/** ctx.run has no stdin, so `secret set --stdin` is fed here. CLI path resolved as in run.ts. */
async function storeOwnedSecret(): Promise<void> {
  const i = process.argv.indexOf("--cli")
  const cli = i >= 0 ? process.argv[i + 1] : process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? "", "Programs", "Interceptor", "interceptor.exe")
    : process.platform === "linux" ? join(homedir(), ".local", "bin", "interceptor") : "/usr/local/bin/interceptor"
  const proc = Bun.spawn([cli, "--json", "desktop", "secret", "set", NAME, "--stdin", "--gate", "none", "--target", "sudo", "--reuse", "30"],
    { stdin: new Blob([VALUE]), stdout: "pipe", stderr: "pipe", timeout: 60_000 })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if (await proc.exited !== 0 || !out.includes('"stored": true')) throw new Error(`secret set --stdin failed: ${(out + err).replaceAll(VALUE, "<value>").slice(0, 300)}`)
}
const removeOwnedSecret = async (ctx: Ctx) => { await ctx.run(["secret", "rm", NAME]).catch(() => undefined) }

export const security: Family[] = [
  {
    family: "secret",
    // The Mac keychain is never written: storage and removal run on the VMs only.
    setup: async ctx => { if (ctx.host !== "darwin") { await ctx.run(["secret", "status"]); await storeOwnedSecret().catch(() => storeOwnedSecret()) } },
    teardown: async ctx => { if (ctx.host !== "darwin") await removeOwnedSecret(ctx) },
    cases: [
      { id: "secret.status", sub: "status", args: ["secret", "status"],
        check: r => typeof r.json?.metadata === "string" && Number.isInteger(r.json?.secrets) && r.json?.backend ? undefined : `vault status incomplete: ${text(r).slice(0, 200)}` },
      { id: "secret.list-owned-policy", sub: "list", args: ["secret", "list"], check: (r, ctx) => {
        if (exposesValue(r) || ctx.host === "darwin") return exposesValue(r)
        const e = (r.json?.secrets ?? []).find((s: any) => s.name === NAME)
        return e?.gate === "none" && JSON.stringify(e.targets) === '["sudo"]' && e.reuseSeconds === 30 ? undefined : `stored policy missing or wrong: ${JSON.stringify(e)}`
      } },
      // The positive set runs in setup (the runner gives cases no stdin); here stdin is empty.
      { id: "secret.set-empty-stdin", sub: "set", args: ["secret", "set", NAME, "--stdin", "--gate", "none", "--target", "sudo", "--reuse", "30"], expect: { all: refuse(undefined, /on stdin/) } },
      { id: "secret.register-bad-gate", sub: "register", args: ["secret", "register", NAME, "--gate", "retina", "--target", "sudo", "--reuse", "60"], expect: { all: refuse("invalid_request") } },
      { id: "secret.unlock-missing", sub: "unlock", args: ["secret", "unlock", "interceptor-parity-missing", "--for", "30m"], expect: { all: refuse("target_gone") } },
      { id: "secret.lock-owned", sub: "lock", args: ["secret", "lock", NAME], check: r => Array.isArray(r.json?.locked) ? undefined : "no locked list" },
      { id: "secret.lock-all", sub: "lock", args: ["secret", "lock"], disruptive: true, check: r => Array.isArray(r.json?.locked) ? undefined : "no locked list" },
      { id: "secret.reveal-json-refused", sub: "reveal", args: ["secret", "reveal", NAME], expect: { all: refuse(undefined, /refused under --json/) }, check: exposesValue },
      { id: "secret.rm-owned", sub: "rm", args: ["secret", "rm", NAME], disruptive: true, check: r => r.json?.removed === true ? undefined : "owned secret not removed" },
      { id: "secret.list-after-rm", sub: "list", args: ["secret", "list"], check: r => text(r).includes(`"${NAME}"`) ? "owned secret still listed after rm" : undefined },
    ],
  },
  {
    family: "auth",
    cases: [
      { id: "auth.status", sub: "status", args: ["auth", "status"], check: r => typeof r.json?.canEvaluate === "boolean" ? undefined : "no canEvaluate" },
      { id: "auth.status-policy-any", sub: "status", args: ["auth", "status", "--policy", "any"], check: r => r.json?.policy === "any" ? undefined : `policy ${r.json?.policy}` },
      { id: "auth.status-policy-biometry", sub: "status", args: ["auth", "status", "--policy", "biometry"],
        check: (r, ctx) => ctx.host === "darwin" || r.json?.canEvaluate === false ? undefined : "Windows/Linux must not claim biometric-only approval" },
      { id: "auth.status-prompt-fields", sub: "status", args: ["auth", "status", "--fallback-title", "Use password", "--cancel-title", "Not now", "--reuse", "10"], expect: { all: refuse("invalid_request") } },
      // Windows refuses custom titles and Linux refuses a fallback title before any prompt.
      { id: "auth.confirm-titles", sub: "confirm", disruptive: true, args: ["auth", "confirm", "Interceptor Parity confirm", "--policy", "any", "--fallback-title", "Use password", "--cancel-title", "Not now", "--reuse", "0"],
        expect: { all: refuse("unsupported_operation"), darwin: skip(PERSON) } },
      { id: "auth.confirm-biometry", sub: "confirm", disruptive: true, args: ["auth", "confirm", "Interceptor Parity confirm", "--policy", "biometry"],
        expect: { all: refuse("unsupported_operation"), darwin: skip(PERSON) } },
      { id: "auth.confirm-bad-reuse", sub: "confirm", args: ["auth", "confirm", "Interceptor Parity confirm", "--reuse", "301"], expect: { all: refuse("invalid_request") } },
      // On the Mac this drops the cached LocalAuthentication reuse the person may be relying on.
      { id: "auth.invalidate", sub: "invalidate", args: ["auth", "invalidate"], disruptive: true, check: r => r.json?.invalidated === true ? undefined : "not invalidated" },
      { id: "auth.invalidate-prompt-fields", sub: "invalidate", args: ["auth", "invalidate", "--policy", "any", "--fallback-title", "Use password", "--cancel-title", "Not now", "--reuse", "10"], expect: { all: refuse("invalid_request") } },
      { id: "auth.domain-state", sub: "domain-state", args: ["auth", "domain-state"],
        check: (r, ctx) => ctx.host === "darwin" || r.json?.available === false ? undefined : "Windows/Linux expose no biometric domain state" },
      { id: "auth.domain-state-prompt-fields", sub: "domain-state", args: ["auth", "domain-state", "--policy", "any", "--fallback-title", "Use password", "--cancel-title", "Not now", "--reuse", "10"], expect: { all: refuse("invalid_request") } },
    ],
  },
  {
    family: "authdialog",
    cases: [
      { id: "authdialog.status", sub: "status", args: ["authdialog", "status"], check: r => typeof r.json?.present === "boolean" ? undefined : "no present flag" },
      // --app/--pid/--window/--ref exist only on Windows/Linux; the fixture is not an authentication dialog.
      { id: "authdialog.status-pid-window", sub: "status", args: async ctx => ["authdialog", "status", "--pid", pid(ctx), "--window", await windowId(ctx)], flags: ["--pid", "--window"],
        expect: { darwin: refuse("invalid_request") }, check: r => r.json?.present === false ? undefined : "fixture reported as an authentication dialog" },
      { id: "authdialog.status-app", sub: "status", args: ctx => ["authdialog", "status", "--app", ctx.fixture.app], flags: ["--app"],
        expect: { darwin: refuse("invalid_request") }, check: r => r.json?.present === false ? undefined : "fixture reported as an authentication dialog" },
      { id: "authdialog.status-ref-not-dialog", sub: "status", args: async ctx => ["authdialog", "status", "--ref", await ctx.ref("Fixture password")], flags: ["--ref"], expect: { all: refuse() } },
      { id: "authdialog.fill-not-dialog", sub: "fill", expect: { all: refuse() },
        args: async ctx => ["authdialog", "fill", "--secret", NAME, "--submit", "--app", ctx.fixture.app, "--pid", pid(ctx), "--window", await windowId(ctx), "--ref", await ctx.ref("Fixture password"), "--secret-lease", LEASE],
        flags: ["--secret", "--submit", "--app", "--pid", "--window", "--ref", "--secret-lease"],
        check: (r, ctx) => ctx.host !== "darwin" && /daemon IPC cannot proxy/.test(errorText(r)) ? "fill is refused at daemon/index.ts:2027 before the native dialog binding (index.ts:775) runs" : exposesValue(r) },
    ],
  },
  {
    family: "sudo",
    // In scope on Linux through the vault (`sudo -S`), out of scope on Windows (UAC).
    // The owned secret is a placeholder, so the VM's test account needs `<user> ALL=(root) NOPASSWD: /usr/bin/id` for the run to succeed.
    setup: async ctx => { if (ctx.host === "linux") { await ctx.run(["secret", "status"]); await storeOwnedSecret().catch(() => storeOwnedSecret())
      if (Bun.spawnSync(["sudo", "-n", "-l", "/usr/bin/id"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) ctx.vars.sudoRule = "this account has no passwordless sudo rule for /usr/bin/id (the owned secret is a placeholder)" } },
    teardown: async ctx => { if (ctx.host === "linux") await removeOwnedSecret(ctx) },
    cases: [
      { id: "sudo.id", sub: "-", disruptive: true, needs: ctx => ctx.vars.sudoRule, args: ["sudo", "--secret", NAME, "--", "/usr/bin/id", "-u"], expect: { win32: refuse("unsupported_operation") },
        check: r => String(r.json?.stdout ?? "").trim() === "0" ? undefined : `id -u under sudo printed ${JSON.stringify(r.json?.stdout)}` },
      { id: "sudo.keep", sub: "-", disruptive: true, needs: ctx => ctx.vars.sudoRule, args: ["sudo", "--secret", NAME, "--keep", "--", "/usr/bin/id", "-u"], expect: { win32: refuse("unsupported_operation") },
        check: r => String(r.json?.stdout ?? "").trim() === "0" && r.json?.keep === true ? undefined : `keep run printed ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "sudo.no-command", sub: "-", args: ["sudo", "--secret", NAME], expect: { all: refuse() } },
    ],
  },
]

export const securityExclusions: Exclusion[] = [
  { family: "secret", sub: "register", reason: "A successful register needs a person to type the value twice into the masked native form; only the parse refusal runs. Storage is covered by set --stdin in setup." },
  { family: "secret", sub: "unlock", reason: "A successful unlock always raises the native approval prompt (daemon handleSecretAction unlock -> gateViaBridge); needs a person to approve. Only the missing-name refusal runs." },
  { family: "secret", sub: "reveal", reason: "reveal prints only to a terminal, is refused under --json (the runner always passes it), and is always gated by a native prompt that needs a person." },
  { family: "auth", sub: "confirm", reason: "needs a person to approve (Windows Hello/CredUI, PAM, Touch ID); only the pre-prompt refusals run." },
  { family: "authdialog", sub: "fill", reason: "A successful fill needs a live native credential dialog (CredentialUIBroker on the ordinary desktop, a standalone Polkit agent, or SecurityAgent) raised by a real privileged request, plus a graphical-session lease no CLI verb returns; only the refusal against a non-dialog field runs." },
]
