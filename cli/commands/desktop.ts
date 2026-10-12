import { runMacosCommand } from "./macos"
import { sendCommand } from "../transport"
import type { DesktopResult, DesktopHello } from "../../shared/desktop-contract"
import { BunSecretsVault } from "../../daemon/secrets"
import { existsSync } from "node:fs"

export async function runDesktopCommand(args: string[], opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; contextId?: string }): Promise<void> {
  if (args[1] === "cdp") {
    await runMacosCommand(["macos", ...args.slice(1)], { ...opts, desktop: true })
    return
  }
  if (["status", "capabilities", "providers"].includes(args[1])) {
    const { result } = await sendCommand({ type: process.platform === "darwin" ? "macos_desktop" : "desktop_hello", sub: "hello" })
    const hello = result.data as DesktopHello | undefined
    if(result.success && Array.isArray(hello?.capabilities) && !hello.capabilities.some(c=>c.operation==='secret')){
      // Effective when the credential store answers a lookup: a missing item reads as null, so nothing is unlocked or prompted.
      // A pending 3 s sleep kept the CLI alive for the full 3 s after the store answered; clear the timer.
      let deadline:ReturnType<typeof setTimeout>|undefined
      const vault=new BunSecretsVault(),answers=await Promise.race([vault.get('interceptor-capability-probe').then(()=>true,()=>false),new Promise<boolean>(resolve=>{deadline=setTimeout(()=>resolve(false),3000)})])
      clearTimeout(deadline)
      hello.capabilities.push({operation:'secret',compiled:true,present:true,permission:'not_applicable',session:hello.session,effective:answers,background:'semantic',provider:'interceptor-daemon-native-vault',versions:{bun:Bun.version,backend:vault.backend},limits:['Daemon-owned vault; native provider handshake does not route secret values.','Registration uses two masked native controls and requires a graphical login. Each credential store operation determines availability and unlock permission. Biometric-only approval remains unavailable on current Windows/Linux authentication backends.'],reason:answers?'Storage uses the current user native credential store.':'The native credential store did not answer a lookup within 3 s.'})
    }
    if (result.success && Array.isArray(hello?.capabilities) && !hello.capabilities.some(c => c.operation === "sudo")) {
      // sudo is daemon-owned: the vault value goes to `sudo -S` stdin. Windows elevation is UAC on the secure desktop.
      const sudo = process.platform !== "win32" && existsSync("/usr/bin/sudo")
      hello.capabilities.push({ operation: "sudo", compiled: true, present: sudo, permission: "not_applicable", session: hello.session, effective: sudo, background: "semantic", provider: "interceptor-daemon-vault-sudo", versions: { contract: "1" },
        limits: ["Runs /usr/bin/sudo -S with a vault secret that targets sudo; the value is never printed or passed on the command line."],
        ...(sudo ? {} : { reason: process.platform === "win32" ? "Windows has no sudo: elevation needs UAC consent on the secure desktop, which cannot be driven." : "/usr/bin/sudo is not installed." }) })
    }
    console.log(JSON.stringify(result.success ? result.data : result, null, 2))
    if (!result.success) process.exitCode = 1
    return
  }
  if (process.platform !== "darwin" && !["secret", "container", "sudo"].includes(args[1])) {
    // Qualify before the legacy parser can prompt for a secret, create monitor
    // metadata, or enter a macOS runtime/CDP implementation.
    let result = (await sendCommand({ type: "desktop_hello" })).result as DesktopResult
    const capabilities = (result.data as { capabilities?: { operation: string; compiled: boolean; present: boolean }[] } | undefined)?.capabilities
    // CLI family names that the provider reports under their contract operation name.
    const named: Record<string, string> = { script: "script_run", intent: "intent_dispatch", container: "container_run" }
    const operation = args[1] === "display" ? `display_${args[2] || "list"}` : args[1] === "inspect" && (!args[2] || args[2].startsWith("--")) ? "inspect_app" : named[args[1]] ?? args[1]
    if (result.success && !capabilities?.some(c => c.operation === operation && c.compiled && c.present)) {
      result = { success: false, code: "unsupported_operation", error: `desktop ${args[1]} is not implemented by this host provider` }
    }
    if (!result.success) {
      if (opts.jsonMode) console.log(JSON.stringify(result))
      else console.error(`error: ${result.error}`)
      process.exitCode = 1; return
    }
  }
  // One parser and output/monitor/secret path for both command names.
  await runMacosCommand(["macos", ...args.slice(1)], { ...opts, desktop: true })
}
