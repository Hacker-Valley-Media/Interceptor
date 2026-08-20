/**
 * cli/commands/network.ts — network on/off/log/override, net log/clear/headers, headers add/remove/clear
 */

type Action = { type: string; [key: string]: unknown }

function flagValue(filtered: string[], flag: string): string | undefined {
  const idx = filtered.indexOf(flag)
  return idx !== -1 ? filtered[idx + 1] : undefined
}

function flagPresent(filtered: string[], flag: string): boolean {
  return filtered.includes(flag)
}

function splitPatterns(raw: string | undefined): string[] {
  if (!raw) return ["<all_urls>"]
  return raw.split(",").map((p) => p.trim()).filter(Boolean)
}

function pageCommPatterns(filtered: string[]): string[] {
  return splitPatterns(
    flagValue(filtered, "--pattern") ||
    flagValue(filtered, "--patterns") ||
    flagValue(filtered, "--filter")
  )
}

export function parseNetworkCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "network":
      switch (filtered[1]) {
        case "on":
          return { type: "network_intercept", patterns: filtered.slice(2), enabled: true }
        case "off":
          return { type: "network_intercept", patterns: [], enabled: false }
        case "log":
          return {
            type: "network_log",
            since: filtered.includes("--since") ? parseInt(filtered[filtered.indexOf("--since") + 1]) : undefined,
            limit: filtered.includes("--limit") ? parseInt(filtered[filtered.indexOf("--limit") + 1]) : undefined
          }
        case "override":
          if (filtered[2] === "on") {
            return { type: "network_override", enabled: true, rules: JSON.parse(filtered[3] || "[]") }
          }
          if (filtered[2] === "off") {
            return { type: "network_override", enabled: false, rules: [] }
          }
          console.error("error: unknown network override subcommand. Use: on, off")
          process.exit(1)
          break
        default:
          console.error("error: unknown network subcommand. Use: on, off, log, override")
          process.exit(1)
      }
      break

    case "net":
      switch (filtered[1]) {
        case "monitor": {
          const sub = filtered[2]
          if (sub === "on") {
            return {
              type: "page_comm_enable",
              reload: flagPresent(filtered, "--reload") || flagPresent(filtered, "--from-start"),
              patterns: pageCommPatterns(filtered),
              persistAcrossSessions: flagPresent(filtered, "--persist")
            }
          }
          if (sub === "off") return { type: "page_comm_disable" }
          if (sub === "status") return { type: "page_comm_status" }
          console.error("error: unknown net monitor subcommand. Use: on, off, status")
          process.exit(1)
        }
        case "page-comm": {
          const sub = filtered[2]
          if (sub === "log") {
            return {
              type: "page_comm_log",
              filter: flagValue(filtered, "--filter"),
              entryType: flagValue(filtered, "--type"),
              since: flagValue(filtered, "--since") ? parseInt(flagValue(filtered, "--since")!) : undefined,
              limit: flagValue(filtered, "--limit") ? parseInt(flagValue(filtered, "--limit")!) : undefined
            }
          }
          if (sub === "clear") return { type: "page_comm_clear" }
          console.error("error: unknown net page-comm subcommand. Use: log, clear")
          process.exit(1)
        }
        case "log": {
          const formatRaw = filtered.includes("--format") ? filtered[filtered.indexOf("--format") + 1] : undefined
          const allowedFormats = new Set(["text", "json", "har", "pcapng"])
          if (formatRaw && !allowedFormats.has(formatRaw)) {
            console.error(`error: --format must be one of text|json|har|pcapng (got '${formatRaw}')`)
            process.exit(1)
          }
          return {
            type: "net_log",
            filter: filtered.includes("--filter") ? filtered[filtered.indexOf("--filter") + 1] : undefined,
            since: filtered.includes("--since") ? parseInt(filtered[filtered.indexOf("--since") + 1]) : undefined,
            limit: filtered.includes("--limit") ? parseInt(filtered[filtered.indexOf("--limit") + 1]) : undefined,
            format: formatRaw,
            out: filtered.includes("--out") ? filtered[filtered.indexOf("--out") + 1] : undefined,
            // exports keep captured auth headers by default; this opt-in
            // strips credentials from the encoded output (issue #160).
            redactAuth: filtered.includes("--redact-auth") || undefined
          }
        }
        case "clear":
          return { type: "net_clear" }
        case "headers":
          return {
            type: "net_headers",
            filter: filtered.includes("--filter") ? filtered[filtered.indexOf("--filter") + 1] : undefined
          }
        default:
          console.error("error: unknown net subcommand. Use: log, clear, headers")
          process.exit(1)
      }
      break

    case "headers":
      switch (filtered[1]) {
        case "add":
          return { type: "headers_modify", rules: [{ operation: "set", header: filtered[2], value: filtered[3] }] }
        case "remove":
          return { type: "headers_modify", rules: [{ operation: "remove", header: filtered[2] }] }
        case "clear":
          return { type: "headers_modify", rules: [] }
        default:
          console.error("error: unknown headers subcommand. Use: add, remove, clear")
          process.exit(1)
      }
      break

    default:
      console.error(`error: unknown network command '${cmd}'`)
      process.exit(1)
  }
  // TypeScript requires a return — unreachable after process.exit
  throw new Error("unreachable")
}
