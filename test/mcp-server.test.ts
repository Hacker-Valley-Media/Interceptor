import { describe, expect, test } from "bun:test"

import { COMMAND_SPECS } from "../cli/manifest"
import { buildServer } from "../cli/mcp/server"
import { withGlobalFlags } from "../cli/mcp/adapter"

describe("buildServer", () => {
  test("constructs without throwing and registers tools", () => {
    const server = buildServer()
    expect(server).toBeTruthy()
    // McpServer keeps registered tools on an internal map; assert the six routers exist.
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
    if (tools) {
      for (const name of ["interceptor_browser", "interceptor_macos", "interceptor_ios", "interceptor_read", "interceptor_local", "interceptor_raw"]) {
        expect(Object.keys(tools)).toContain(name)
      }
    }
  })

  test("browser verb menu is non-empty (enum source of truth)", () => {
    expect(COMMAND_SPECS.filter(c => c.surface === "browser").length).toBeGreaterThan(20)
  })

  test("MCP keeps its explicit hard group instead of relying on host session scope", () => {
    expect(withGlobalFlags(["open", "https://example.com"], { group: "mcp-1234" }))
      .toEqual(["open", "https://example.com", "--group", "mcp-1234"])
  })
})
