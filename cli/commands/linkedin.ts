/**
 * cli/commands/linkedin.ts — linkedin event, linkedin attendees, linkedin-event
 */

type Action = { type: string; [key: string]: unknown }

export function parseLinkedinCommand(filtered: string[]): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "linkedin":
      if (filtered[1] === "event") {
        return {
          type: "linkedin_event_extract",
          url: filtered[2],
          waitMs: filtered.includes("--wait")
            ? parseInt(filtered[filtered.indexOf("--wait") + 1])
            : undefined
        }
      }
      if (filtered[1] === "attendees") {
        return {
          type: "linkedin_attendees_extract",
          url: filtered[2],
          waitMs: filtered.includes("--wait")
            ? parseInt(filtered[filtered.indexOf("--wait") + 1])
            : undefined,
          enrichLimit: filtered.includes("--enrich-limit")
            ? parseInt(filtered[filtered.indexOf("--enrich-limit") + 1])
            : undefined
        }
      }
      console.error("error: unknown linkedin subcommand. Use: event, attendees")
      process.exit(1)
      break

    case "linkedin-event":
      return {
        type: "linkedin_event_extract",
        url: filtered[1],
        waitMs: filtered.includes("--wait")
          ? parseInt(filtered[filtered.indexOf("--wait") + 1])
          : undefined
      }

    default:
      console.error(`error: unknown linkedin command '${cmd}'`)
      process.exit(1)
  }
  throw new Error("unreachable")
}
