import { describe, expect, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { COMMAND_SPECS } from "../cli/manifest"
import { buildServer } from "../cli/mcp/server"
import { withGlobalFlags } from "../cli/mcp/adapter"

describe("buildServer", () => {
  test("local installations require operator allowance and explicit confirmation", async () => {
    const previousAllow = process.env.INTERCEPTOR_MCP_ALLOW
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({
      stdout: new Response("{}").body, stderr: new Response("").body,
      exited: Promise.resolve(0),
    }) as ReturnType<typeof Bun.spawn>)
    try {
      for (const allow of ["", "raw", "destructive", "raw,destructive"]) {
        process.env.INTERCEPTOR_MCP_ALLOW = allow
        const server = buildServer()
        if (previousAllow === undefined) delete process.env.INTERCEPTOR_MCP_ALLOW
        else process.env.INTERCEPTOR_MCP_ALLOW = previousAllow
        const client = new Client({ name: "local-policy", version: "1" })
        const [a, b] = InMemoryTransport.createLinkedPair()
        try {
          await server.connect(a); await client.connect(b)
          const tool = (await client.listTools()).tools.find(t => t.name === "interceptor_local")!
          for (const confirm of [false, true]) {
            const permitted = allow.includes("destructive") && confirm
            const before = spawn.mock.calls.length
            const result = await client.callTool({ name: "interceptor_local", arguments: { verb: "upgrade", args: ["--full"], confirm } })
            assert.equal(result.isError === true, !permitted)
            assert.equal(spawn.mock.calls.length - before, Number(permitted))
            if (!permitted) assert.match(JSON.stringify(result), /destructive|confirm/i)
          }
          if (allow.includes("raw")) {
            for (const args of [["upgrade", "--full"], ["--json", "upgrade", "--full"], ["update", "install"]]) {
              for (const confirm of [false, true]) {
                const permitted = allow.includes("destructive") && confirm
                const before = spawn.mock.calls.length
                const result = await client.callTool({ name: "interceptor_raw", arguments: { args, confirm } })
                assert.equal(result.isError === true, !permitted)
                assert.equal(spawn.mock.calls.length - before, Number(permitted))
                if (permitted) assert.deepEqual(spawn.mock.calls[before][0].slice(-args.length), args)
                else assert.match(JSON.stringify(result), /destructive|confirm/i)
              }
            }
          }
          const before = spawn.mock.calls.length
          const read = await client.callTool({ name: "interceptor_local", arguments: { verb: "manifest" } })
          assert.notEqual(read.isError, true)
          assert.equal(spawn.mock.calls.length - before, 1)
          assert.notEqual(tool.annotations?.readOnlyHint, true)
        } finally { await client.close(); await server.close() }
      }
    } finally {
      if (previousAllow === undefined) delete process.env.INTERCEPTOR_MCP_ALLOW
      else process.env.INTERCEPTOR_MCP_ALLOW = previousAllow
      spawn.mockRestore()
    }
  })

  test("raw global flags cannot bypass execution or destructive gates", async () => {
    const previousAllow = process.env.INTERCEPTOR_MCP_ALLOW
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Raw policy reached the CLI") })
    process.env.INTERCEPTOR_MCP_ALLOW = "raw"
    const server = buildServer()
    if (previousAllow === undefined) delete process.env.INTERCEPTOR_MCP_ALLOW
    else process.env.INTERCEPTOR_MCP_ALLOW = previousAllow
    const client = new Client({ name: "raw-policy", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(a); await client.connect(b)
      for (const [args, reason] of [
        [["--json", "macos", "fixturex", "run"], /arbitrary-exec/],
        [["--context", "owned", "--group", "owned", "desktop", "fixturex", "run"], /arbitrary-exec/],
        [["--frame=0", "--json", "ios", "eval", "1+1"], /arbitrary-exec/],
        [["--json", "--tab", "42", "eval", "1+1"], /arbitrary-exec/],
        [["--json", "desktop", "fs", "write", "/owned.txt", "value"], /destructive/],
      ] as [string[], RegExp][]) {
        const result = await client.callTool({ name: "interceptor_raw", arguments: { args, confirm: true } })
        assert.equal(result.isError, true)
        assert.match(JSON.stringify(result), reason)
      }
      expect(spawn).not.toHaveBeenCalled()
      // A permitted read retains native JSON payloads and literal arguments.
      spawn.mockImplementation(() => ({
        stdout: new Response("{}").body, stderr: new Response("").body,
        exited: Promise.resolve(0),
      }) as ReturnType<typeof Bun.spawn>)
      const original = ["--json", "desktop", "translate", "batch", "--json", '["owned"]', "--", "--group", "literal"]
      const read = await client.callTool({ name: "interceptor_raw", arguments: { args: original } })
      assert.notEqual(read.isError, true)
      assert.deepEqual(spawn.mock.calls[0][0].slice(-original.length - 1), ["--json", ...original])
      assert.equal((await client.listTools()).tools.length, 7)
    } finally {
      spawn.mockRestore()
      await client.close(); await server.close()
    }
  })

  test("a global flag's value is never classified as the sub-verb", async () => {
    const previousAllow = process.env.INTERCEPTOR_MCP_ALLOW
    delete process.env.INTERCEPTOR_MCP_ALLOW
    const server = buildServer("darwin")
    if (previousAllow !== undefined) process.env.INTERCEPTOR_MCP_ALLOW = previousAllow
    const client = new Client({ name: "global-flag-policy", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Global flag value reached the CLI") })
    try {
      await server.connect(a); await client.connect(b)
      for (const flag of ["--frame", "--context", "--tab", "--group", "--group-color"]) {
        // The CLI strips `<flag> <value>` and executes the destructive sub-verb behind it.
        for (const [name, verb, args] of [
          ["interceptor_macos", "vm", [flag, "list", "delete", "owned"]],
          ["interceptor_desktop", "vm", [flag, "list", "delete", "owned"]],
          ["interceptor_ios", "fs", [flag, "ls", "push", "a", "b"]],
        ] as [string, string, string[]][]) {
          const result = await client.callTool({ name, arguments: { verb, args, confirm: true } })
          assert.equal(result.isError, true)
          assert.match(JSON.stringify(result), /destructive/)
        }
        const read = await client.callTool({ name: "interceptor_read", arguments: { surface: "macos", verb: "files", args: [flag, "recent", "watch", "/owned"] } })
        assert.equal(read.isError, true)
        assert.match(JSON.stringify(read), /not a read-only operation/)
      }
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
      await client.close(); await server.close()
    }
  })

  test("read-only tools refuse mixed-family mutations before spawning the CLI", async () => {
    const previousAllow = process.env.INTERCEPTOR_MCP_ALLOW
    process.env.INTERCEPTOR_MCP_ALLOW = "all"
    const server = buildServer()
    if (previousAllow === undefined) delete process.env.INTERCEPTOR_MCP_ALLOW
    else process.env.INTERCEPTOR_MCP_ALLOW = previousAllow
    const client = new Client({ name: "read-policy", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Read wrapper reached the CLI") })
    try {
      await server.connect(a); await client.connect(b)
      const readTool = (await client.listTools()).tools.find(t => t.name === "interceptor_read")!
      assert((readTool.inputSchema.properties!.verb as {enum:string[]}).enum.includes("notifications"))
      for (const surface of ["macos", "desktop"]) {
        for (const args of [[], ["post", "--id", "owned"], ["categories", "register"], ["--namespace", "pending", "post", "--id", "owned"], ["--namespace", "status", "cancel-all"], ["--namespace", "categories", "categories", "clear"]]) {
          const result = await client.callTool({name:"interceptor_read",arguments:{surface,verb:"notifications",args}})
          assert.equal(result.isError,true)
          assert.match(JSON.stringify(result),/not a read-only operation/)
        }
        for (const args of [["watch", "/owned.txt"], ["unwatch", "/owned.txt"], ["unknown-action"]]) {
          const result = await client.callTool({ name: "interceptor_read", arguments: { surface, verb: "files", args } })
          assert.equal(result.isError, true)
          assert.match(JSON.stringify(result), /not a read-only operation/)
        }
        const result = await client.callTool({ name: "interceptor_read", arguments: { surface, verb: "thumbnail", args: ["/owned.txt", "--out", "/owned.png"] } })
        assert.equal(result.isError, true)
        assert.match(JSON.stringify(result), /not a read-only operation/)
      }
      const result = await client.callTool({ name: "interceptor_read", arguments: { surface: "ios", verb: "profiles", args: ["remove", "owned"] } })
      assert.equal(result.isError, true)
      assert.match(JSON.stringify(result), /not a read-only operation/)
      expect(spawn).not.toHaveBeenCalled()
      assert.equal((await client.listTools()).tools.length, 7)
    } finally {
      spawn.mockRestore()
      await client.close(); await server.close()
    }
  })

  test("invalid monitor flags return errors without terminating the MCP process", async () => {
      const previousAllow = process.env.INTERCEPTOR_MCP_ALLOW;
      process.env.INTERCEPTOR_MCP_ALLOW = "";
      const server = buildServer();
      if (previousAllow === undefined) delete process.env.INTERCEPTOR_MCP_ALLOW;
      else process.env.INTERCEPTOR_MCP_ALLOW = previousAllow;
      const client = new Client({ name: "regression", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a); await client.connect(b);
      for (const flag of ["--typo", "--json=true"]) {
        const result = await client.callTool({ name: "interceptor_browser", arguments: { verb: "monitor", args: ["task", "resume", "task-123", flag] } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /unknown flag|does not take a value/);
        assert.equal((await client.listTools()).tools.length, 7);
      }
      const gated = await client.callTool({ name: "interceptor_browser", arguments: { verb: "monitor", args: ["--json", "task", "verify", "task-123"] } });
      assert.equal(gated.isError, true);
      assert.match(JSON.stringify(gated), /arbitrary-exec/);
      await client.close(); await server.close();
  })

  test("constructs without throwing and registers tools", () => {
    const server = buildServer()
    expect(server).toBeTruthy()
    // McpServer keeps registered tools on an internal map; assert the seven routers exist.
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
    if (tools) {
      for (const name of ["interceptor_browser", "interceptor_macos", "interceptor_desktop", "interceptor_ios", "interceptor_read", "interceptor_local", "interceptor_raw"]) {
        expect(Object.keys(tools)).toContain(name)
      }
    }
  })


  test("iOS verb menu covers the runner stream and multi-touch verbs", async () => {
      const previousAllow = process.env.INTERCEPTOR_MCP_ALLOW;
      process.env.INTERCEPTOR_MCP_ALLOW = "";
      const server = buildServer();
      if (previousAllow === undefined) delete process.env.INTERCEPTOR_MCP_ALLOW;
      else process.env.INTERCEPTOR_MCP_ALLOW = previousAllow;
      const client = new Client({ name: "menu", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a); await client.connect(b);
      const ios = (await client.listTools()).tools.find((t) => t.name === "interceptor_ios");
      assert.ok(ios);
      const schema = ios.inputSchema.properties?.verb as { enum?: string[] } | undefined;
      assert.ok(schema?.enum);
      const verbs = schema.enum;
      for (const v of ["stream", "frame", "gesture", "screenshot", "click", "drag"]) assert.ok(verbs.includes(v), v);
      await client.close(); await server.close();
  })

  test("browser verb menu is non-empty (enum source of truth)", () => {
    expect(COMMAND_SPECS.filter(c => c.surface === "browser").length).toBeGreaterThan(20)
  })

  test("MCP keeps its explicit hard group instead of relying on host session scope", () => {
    expect(withGlobalFlags(["open", "https://example.com"], { group: "mcp-1234" }))
      .toEqual(["open", "https://example.com", "--group", "mcp-1234"])
  })
})
