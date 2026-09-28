import { describe, expect, test } from "bun:test"

import { runOverride } from "../cli/commands/override"

type OverrideAction = { type: string; [key: string]: unknown }
type OverrideSender = NonNullable<Parameters<typeof runOverride>[2]>
type SenderCall = {
  action: OverrideAction
  tabId?: number
  useWs?: boolean
  contextId?: string
}

function makeSender(calls: SenderCall[]): OverrideSender {
  return async (action, tabId, useWs, contextId) => {
    calls.push({ action, tabId, useWs, contextId })
    return { success: true }
  }
}

async function withMutedConsole(fn: () => Promise<void>): Promise<void> {
  const originalLog = console.log
  console.log = () => {}
  try {
    await fn()
  } finally {
    console.log = originalLog
  }
}

describe("runOverride", () => {
  test("passes context routing options when setting overrides", async () => {
    const calls: SenderCall[] = []

    await withMutedConsole(async () => {
      await runOverride(
        ["override", "*api*", "limit=50", "mode=debug"],
        { globalTabId: 7, useWs: true, contextId: "work" },
        makeSender(calls)
      )
    })

    expect(calls).toEqual([
      {
        action: {
          type: "set_net_overrides",
          rules: [
            {
              urlPattern: "*api*",
              queryAddOrReplace: { limit: "50", mode: "debug" },
            },
          ],
        },
        tabId: 7,
        useWs: true,
        contextId: "work",
      },
    ])
  })

  test("passes context routing options when clearing overrides", async () => {
    const calls: SenderCall[] = []

    await withMutedConsole(async () => {
      await runOverride(["override", "clear"], { contextId: "work" }, makeSender(calls))
    })

    expect(calls).toEqual([
      {
        action: { type: "clear_net_overrides" },
        tabId: undefined,
        useWs: undefined,
        contextId: "work",
      },
    ])
  })
})

describe("runOverride response flags", () => {
  const run = async (args: string[]) => {
    const calls: SenderCall[] = []
    await withMutedConsole(() => runOverride(["override", ...args], {}, makeSender(calls)))
    return (calls[0].action.rules as Record<string, unknown>[])[0]
  }

  // process.exit is how the CLI refuses; turn it into a throw for the test.
  const refused = async (args: string[]) => {
    const exit = process.exit
    const error = console.error
    const messages: string[] = []
    console.error = (m: unknown) => { messages.push(String(m)) }
    process.exit = ((code?: number) => { throw new Error(`exit ${code}`) }) as typeof process.exit
    try {
      await runOverride(["override", ...args], {}, makeSender([]))
      return "accepted"
    } catch {
      return messages.join("\n")
    } finally {
      process.exit = exit
      console.error = error
    }
  }

  test("--status, --body, --delay and --content-type become a response rule", async () => {
    expect(await run(["*api*", "--status", "503", "--body", '{"a":1}', "--delay", "250", "--content-type", "text/html"])).toEqual({
      urlPattern: "*api*", status: 503, body: '{"a":1}', delayMs: 250, contentType: "text/html",
    })
  })

  test("query pairs and response flags combine; a delay alone is a rule", async () => {
    expect(await run(["*api*", "page=2", "--delay", "100"])).toEqual({
      urlPattern: "*api*", queryAddOrReplace: { page: "2" }, delayMs: 100,
    })
  })

  test("bad values are refused with the reason", async () => {
    expect(await refused(["*api*", "--status", "99"])).toContain("--status must be an integer from 200 to 599")
    expect(await refused(["*api*", "--delay", "soon"])).toContain("--delay must be milliseconds")
    expect(await refused(["*api*", "--status"])).toContain("--status needs a value")
    expect(await refused(["*api*", "--body", "--status", "500"])).toContain("--body needs a value")
    expect(await refused(["*api*", "--content-type", "--delay", "100"])).toContain("--content-type needs a value")
    expect(await refused(["*api*", "--content-type", "text/html"])).toContain("--content-type only applies")
    expect(await refused(["*api*"])).toContain("needs a key=value query pair or a response flag")
  })
})

test("status=500 stays a query rewrite and says how to override the response", async () => {
  const calls: SenderCall[] = []
  const error = console.error
  const notes: string[] = []
  console.error = (m: unknown) => { notes.push(String(m)) }
  try {
    await withMutedConsole(() => runOverride(["override", "*api*", "status=500"], {}, makeSender(calls)))
  } finally {
    console.error = error
  }
  expect((calls[0].action.rules as unknown[])[0]).toEqual({ urlPattern: "*api*", queryAddOrReplace: { status: "500" } })
  expect(notes.join("\n")).toContain("use --status 500")
})
