/**
 * cli/commands/network.ts — network on/off/log/override, net log/clear/headers, headers add/remove/clear
 */

type Action = { type: string; [key: string]: unknown }

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
        case "log":
          return {
            type: "net_log",
            filter: filtered.includes("--filter") ? filtered[filtered.indexOf("--filter") + 1] : undefined,
            since: filtered.includes("--since") ? parseInt(filtered[filtered.indexOf("--since") + 1]) : undefined,
            limit: filtered.includes("--limit") ? parseInt(filtered[filtered.indexOf("--limit") + 1]) : undefined
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
