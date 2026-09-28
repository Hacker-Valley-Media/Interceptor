import { afterEach, describe, expect, test } from "bun:test"
import { parseSince } from "../cli/commands/network"
import { sendNetAllFrames } from "../extension/src/background/content-bridge"

describe("parseSince", () => {
  const now = 1_790_000_000_000
  test("durations count back from now", () => {
    expect(parseSince("500ms", now)).toBe(now - 500)
    expect(parseSince("30s", now)).toBe(now - 30_000)
    expect(parseSince("5m", now)).toBe(now - 300_000)
    expect(parseSince("2H", now)).toBe(now - 7_200_000)
    expect(parseSince("1d", now)).toBe(now - 86_400_000)
  })
  test("an epoch-ms timestamp passes through; no flag is undefined", () => {
    expect(parseSince("1790000000123", now)).toBe(1_790_000_000_123)
    expect(parseSince(undefined, now)).toBeUndefined()
  })
  test("a bare small number or junk is refused, not read as 1970", () => {
    const exit = process.exit
    const error = console.error
    console.error = () => {}
    process.exit = ((code?: number) => { throw new Error(`exit ${code}`) }) as typeof process.exit
    try {
      expect(() => parseSince("30", now)).toThrow("exit 1")
      expect(() => parseSince("soon", now)).toThrow("exit 1")
    } finally {
      process.exit = exit
      console.error = error
    }
  })
})

describe("sendNetAllFrames", () => {
  const original = (globalThis as { chrome?: unknown }).chrome
  afterEach(() => { (globalThis as { chrome?: unknown }).chrome = original })

  function fakeChrome(replies: Record<number, unknown>, frames: number[] | undefined) {
    const asked: number[] = []
    const runtime: { lastError?: { message: string } } = {}
    ;(globalThis as { chrome: unknown }).chrome = {
      runtime,
      webNavigation: frames ? { getAllFrames: async () => frames.map((frameId) => ({ frameId })) } : undefined,
      tabs: {
        sendMessage: (_tab: number, _msg: unknown, opts: { frameId: number }, cb: (r: unknown) => void) => {
          asked.push(opts.frameId)
          const reply = replies[opts.frameId]
          if (reply === undefined) runtime.lastError = { message: "Receiving end does not exist." }
          cb(reply)
          runtime.lastError = undefined
        },
      },
    }
    return asked
  }

  test("merges child-frame entries in time order and skips frames with no buffer", async () => {
    const asked = fakeChrome({
      0: { success: true, data: [{ url: "/top-a", timestamp: 10 }, { url: "/top-b", timestamp: 30 }] },
      4: { success: true, data: [{ url: "/frame", timestamp: 20 }] },
    }, [0, 4, 9])
    const result = await sendNetAllFrames(1, { type: "get_net_log" }) as { data: { url: string }[] }
    expect(result.data.map((e) => e.url)).toEqual(["/top-a", "/frame", "/top-b"])
    expect(asked).toEqual([0, 4, 9])
  })

  test("writes reach every frame and return the top frame's reply", async () => {
    const asked = fakeChrome({ 0: { success: true }, 4: { success: true } }, [0, 4])
    expect(await sendNetAllFrames(1, { type: "set_net_overrides", rules: [] })).toEqual({ success: true })
    expect(asked).toEqual([0, 4])
  })

  test("no webNavigation (Electron, some Safari builds) falls back to the top frame", async () => {
    const asked = fakeChrome({ 0: { success: true, data: [{ url: "/top", timestamp: 1 }] } }, undefined)
    const result = await sendNetAllFrames(1, { type: "get_net_log" }) as { data: unknown[] }
    expect(result.data.length).toBe(1)
    expect(asked).toEqual([0])
  })
})

// net-buffer registers listeners on import, so it runs in its own process.
test("get_sse_chunk pins one stream and returns the tail of a finished one", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import assert from "node:assert/strict";
    import { GlobalRegistrator } from "@happy-dom/global-registrator";
    GlobalRegistrator.register({ url: "https://page.test/" });
    let handler;
    globalThis.chrome = { runtime: { onMessage: { addListener: (fn) => { handler = fn } } } };
    await import("./extension/src/content/net-buffer.ts");
    const ask = (msg) => new Promise((r) => handler({ type: "get_sse_chunk", ...msg }, {}, r));
    const emit = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail }));
    const began = Date.now();

    let r = await ask({ after: began });
    assert.equal(r.data.active, false, "no stream yet");
    assert.equal(r.data.stream, undefined);

    emit("__interceptor_sse", { url: "/sse", chunk: "a", seq: 0, timestamp: began + 5 });
    emit("__interceptor_sse", { url: "/sse", chunk: "b", seq: 1, timestamp: began + 6 });
    r = await ask({ after: began });
    assert.equal(r.data.active, true);
    assert.equal(r.data.text, "ab");
    const stream = r.data.stream;
    assert.equal(stream, began + 5);

    // The last chunk and the end of the stream land between two polls.
    emit("__interceptor_sse", { url: "/sse", chunk: "c", seq: 2, timestamp: began + 7 });
    emit("__interceptor_sse_done", { url: "/sse", totalChunks: 3, totalBytes: 3, duration: 2 });
    r = await ask({ after: began, stream, since: 2 });
    assert.equal(r.data.active, false);
    assert.equal(r.data.text, "c", "the final chunk is still delivered");

    // A later stream on the same URL is not mistaken for the pinned one.
    emit("__interceptor_sse", { url: "/sse", chunk: "z", seq: 0, timestamp: began + 50 });
    r = await ask({ after: began, stream, since: 3 });
    assert.equal(r.data.active, false);
    assert.equal(r.data.text, "");

    // A plain poll (older CLI) keeps the old shape for an active stream.
    r = await ask({});
    assert.equal(r.data.active, true);
    assert.equal(r.data.text, "z");
  `], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
})
