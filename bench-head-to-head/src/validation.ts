import type { CommandPolicy, ConditionDef } from "./types"

function splitShell(command: string): string[] {
  return command
    .split(/\n|&&|\|\||;/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, ""))
}

function matchesPrefix(command: string, prefix: string): boolean {
  const candidates = prefix.includes(" ") ? [prefix] : [prefix, `/bin/zsh -lc ${prefix}`, `zsh -lc ${prefix}`]
  return splitShell(command).some((segment) => candidates.some((candidate) => segment === candidate || segment.includes(candidate + " ") || segment.endsWith(candidate)))
}

function checkPolicy(policy: CommandPolicy | undefined, commands: string[]): string | null {
  if (!policy) return null
  if ((policy.requireAnyPrefix ?? []).length > 0) {
    const matched = commands.some((command) => (policy.requireAnyPrefix ?? []).some((prefix) => matchesPrefix(command, prefix)))
    if (!matched) return `No command matched required prefixes: ${(policy.requireAnyPrefix ?? []).join(", ")}`
  }
  for (const command of commands) {
    if ((policy.forbidAnyPrefix ?? []).some((prefix) => matchesPrefix(command, prefix))) {
      return `Forbidden command prefix detected: ${command}`
    }
    if ((policy.forbidSubstrings ?? []).some((piece) => command.includes(piece))) {
      return `Forbidden command substring detected: ${command}`
    }
  }
  return null
}

export function validateCommandPolicy(condition: ConditionDef, commands: string[]): string | null {
  return checkPolicy(condition.commandPolicy, commands)
}
