import { afterEach, expect, test } from "bun:test"
import { CdpManager } from "../daemon/cdp/manager"

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

function endpoint(marker: string, url = "http://localhost/") {
  const handshake = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  let rejectHandshake = false
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req, s) {
      const path = new URL(req.url).pathname
      if (path === "/json/version") return Response.json({ Browser: "fixture" })
      if (path === "/json/list") return Response.json([{
        type: "page", id: marker, url, webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/page`,
      }])
      handshake.resolve()
      await ready.promise
      if (!rejectHandshake && s.upgrade(req)) return
      return new Response("closed", { status: 403 })
    },
    websocket: {
      message(ws, raw) {
        const { id } = JSON.parse(String(raw))
        ws.send(JSON.stringify({ id, result: { result: { type: "string", value: marker } } }))
      },
    },
  })
  cleanup.push(() => { void server.stop(true) })
  return {
    port: server.port!, handshake: handshake.promise, accept: ready.resolve,
    rejectNext: () => { rejectHandshake = true },
    sockets: () => server.pendingWebSockets, stop: () => server.stop(true),
  }
}

function fixture() {
  const events: string[] = []
  const manager = new CdpManager({
    emit: event => { events.push(event) }, hasExtensionContext: () => false,
    dropExtensionContext() {}, mv2ExtensionDir: () => "",
  })
  return {
    manager, events,
    connect: (port: number, app?: string, host?: string) => manager.handle({ type: "cdp_connect", port, app, host }),
    read: async (id: string) => (await manager.executeVerb(id, { type: "text" })).data,
  }
}

test("same-host endpoints keep separate routes and a reconnect keeps the suffixed id", async () => {
  const a = endpoint("A"), b = endpoint("B")
  a.accept()
  b.accept()
  const { connect, manager, read } = fixture()
  const bare = "cdp:localhost", suffix = `${bare}-${b.port}`
  expect(await connect(a.port)).toMatchObject({ success: true, data: { contextId: bare } })
  expect(await connect(b.port)).toMatchObject({ success: true, data: { contextId: suffix } })
  expect((await manager.handle({ type: "cdp_status" })).data).toMatchObject([
    { contextId: bare, port: a.port }, { contextId: suffix, port: b.port },
  ])
  expect(await read(bare)).toBe("A")
  expect(await read(suffix)).toBe("B")
  await manager.handle({ type: "cdp_detach", contextId: bare })
  expect(await connect(b.port)).toMatchObject({ data: { contextId: suffix } })
  expect(manager.contextIds()).toEqual([suffix])
  b.rejectNext()
  expect((await connect(b.port)).success).toBe(false)
  expect(await read(suffix)).toBe("B")
})

test("explicit slug aliases and two different host strings on the same port cannot displace a holder", async () => {
  const a = endpoint("A"), b = endpoint("B")
  a.accept()
  b.accept()
  const { connect, read, events } = fixture()
  expect((await connect(a.port, "QA Lane")).success).toBe(true)
  for (const other of [() => connect(b.port, "qa-lane.app"), () => connect(a.port, "QA Lane", "localhost")]) {
    const result = await other()
    expect(result.success).toBe(false)
    expect(result.error).toContain(`127.0.0.1:${a.port}`)
    expect(result.error).toContain("--app")
    expect(result.error).toContain("detach")
    expect(await read("cdp:qa-lane")).toBe("A")
  }
  expect(events).not.toContain("cdp_disconnected")
  await a.stop()
  await waitUntil(() => events.includes("cdp_disconnected"))
  expect(await connect(b.port, "QA Lane")).toMatchObject({ success: true, data: { contextId: "cdp:qa-lane" } })
})

test("an occupied implicit suffix and a reserved hostless id preserve the holder", async () => {
  const a = endpoint("A"), b = endpoint("B"), blank = endpoint("blank", "about:blank")
  a.accept()
  b.accept()
  blank.accept()
  const { connect, read, events } = fixture()
  for (const name of ["localhost", `localhost-${b.port}`, `app-${blank.port}`]) {
    expect((await connect(a.port, name)).success).toBe(true)
  }
  expect((await connect(b.port)).success).toBe(false)
  expect((await connect(blank.port)).success).toBe(false)
  expect(await read(`cdp:localhost-${b.port}`)).toBe("A")
  expect(await read(`cdp:app-${blank.port}`)).toBe("A")
  expect(events).not.toContain("cdp_disconnected")
})

async function waitUntil(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}

for (const explicit of [false, true]) {
  for (const first of [0, 1]) {
    test(`overlapping ${explicit ? "explicit" : "derived"} names, endpoint ${first} opens first`, async () => {
      const endpoints = [endpoint("A"), endpoint("B")]
      const { connect, manager, events } = fixture()
      const calls = endpoints.map(e => connect(e.port, explicit ? "fixture" : undefined))
      await Promise.all(endpoints.map(e => e.handshake))
      endpoints[first]!.accept()
      const base = explicit ? "cdp:fixture" : "cdp:localhost"
      expect(await calls[first]).toMatchObject({ data: { contextId: base } })
      const second = 1 - first
      endpoints[second]!.accept()
      if (explicit) {
        expect(await calls[second]).toMatchObject({ success: false })
        await waitUntil(() => endpoints[second]!.sockets() === 0)
        expect(manager.contextIds()).toEqual([base])
      } else {
        expect(await calls[second]).toMatchObject({ data: { contextId: `${base}-${endpoints[second]!.port}` } })
        expect(manager.contextIds()).toHaveLength(2)
      }
      expect(events).not.toContain("cdp_disconnected")
    })
  }
}
