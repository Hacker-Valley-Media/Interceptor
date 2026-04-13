type Action = { type: string; [key: string]: unknown }

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i === -1) return undefined
  return args[i + 1]
}

export function parseSseCommand(filtered: string[]): Action | null {
  const sub = filtered[1]
  if (!sub || sub === "help") {
    console.log(SSE_HELP)
    return null
  }

  switch (sub) {
    case "log":
      return {
        type: "sse_log",
        filter: flagValue(filtered, "--filter"),
        limit: filtered.includes("--limit") ? parseInt(filtered[filtered.indexOf("--limit") + 1]) : undefined
      }
    case "streams":
      return { type: "sse_streams" }
    case "tail": {
      const filter = flagValue(filtered, "--filter")
      const timeout = filtered.includes("--timeout") ? parseInt(filtered[filtered.indexOf("--timeout") + 1]) : 60000
      return { type: "sse_tail", filter, timeout }
    }
    default:
      console.error(`error: unknown sse subcommand '${sub}'. Try: log, streams, tail.`)
      process.exit(1)
  }
}

const SSE_HELP = `interceptor sse — inspect SSE (Server-Sent Events) streams

Usage:
  interceptor sse log [--filter <pattern>] [--limit N]   Show completed SSE streams
  interceptor sse streams                                  List active SSE streams
  interceptor sse tail [--filter <pattern>]                Live tail of SSE stream chunks

log       Show completed SSE streams from the buffer (up to 50 most recent).
streams   List currently active SSE streams with URL, chunk count, byte count.
tail      Poll for new SSE chunks every 200ms. Exits when stream completes.
          Use --filter to match a URL pattern (e.g. --filter f/conversation).
`
