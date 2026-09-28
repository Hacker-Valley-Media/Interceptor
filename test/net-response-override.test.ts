import { expect, test } from "bun:test"

// inject-net patches page globals on import, so it runs in its own Bun process
// against happy-dom (see native-fetch-identity.test.ts).
async function runInPage(body: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", `
    import assert from "node:assert/strict";
    import { GlobalRegistrator } from "@happy-dom/global-registrator";
    GlobalRegistrator.register({ url: "https://page.test/" });
    const sent = [];
    window.fetch = async function fetch(input) {
      const url = String(input instanceof Request ? input.url : input);
      sent.push({ url, at: Date.now() });
      if (url.includes("down.test")) throw new TypeError("Failed to fetch");
      return new Response("real", { status: 200, headers: { "content-type": "text/plain" } });
    };
    await import("./extension/src/inject-net.ts");
    const nets = [];
    document.addEventListener("__interceptor_net", (e) => nets.push(e.detail));
    const until = async (ready) => { for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 10)) };
    const setRules = (rules) => document.dispatchEvent(new CustomEvent("__interceptor_set_overrides", { detail: rules }));
    ${body}
  `], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
}

test("fetch: --status/--body answer locally, never send, and are marked mocked", async () => {
  await runInPage(`
    setRules([{ urlPattern: "*api.test/items*", status: 503, body: '{"error":"down"}' }]);
    const res = await window.fetch("https://api.test/items?page=1");
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(await res.json(), { error: "down" });
    assert.equal(sent.length, 0, "a mocked request never reaches the network");
    await until(() => nets.length > 0);
    assert.equal(nets[0].status, 503);
    assert.equal(nets[0].mocked, true);
    assert.equal(nets[0].body, '{"error":"down"}');

    const other = await window.fetch("https://api.test/other");
    assert.equal(await other.text(), "real", "non-matching requests pass through");
    assert.equal(sent.at(-1).url, "https://api.test/other", "a response-only rule does not rewrite other URLs");

    setRules([{ urlPattern: "*api.test/empty*", status: 204, body: "ignored" }]);
    const empty = await window.fetch("https://api.test/empty");
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), "", "null-body statuses drop the body instead of throwing");
  `)
})

test("fetch: --delay holds the real request; a status override can be delayed too", async () => {
  await runInPage(`
    setRules([{ urlPattern: "*slow.test*", delayMs: 150 }]);
    const t0 = Date.now();
    const res = await window.fetch("https://slow.test/a");
    assert.equal(await res.text(), "real");
    assert.ok(sent.at(-1).at - t0 >= 140, "sent only after the delay: " + (sent.at(-1).at - t0));

    setRules([{ urlPattern: "*slow.test*", delayMs: 120, status: 500 }]);
    const t1 = Date.now();
    const failed = await window.fetch("https://slow.test/b");
    assert.equal(failed.status, 500);
    assert.ok(Date.now() - t1 >= 110);
  `)
})

test("fetch: a failed request is logged as status 0 with its error, and still rejects", async () => {
  await runInPage(`
    await assert.rejects(window.fetch("https://down.test/x"), (e) => e instanceof TypeError);
    await until(() => nets.length > 0);
    assert.equal(nets[0].status, 0);
    assert.equal(nets[0].url, "https://down.test/x");
    assert.equal(nets[0].error, "TypeError: Failed to fetch");
  `)
})

test("xhr: response overrides fire load with the mocked status and body", async () => {
  await runInPage(`
    setRules([{ urlPattern: "*api.test/x*", status: 418, body: '{"tea":true}' }]);
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.test/x");
    xhr.responseType = "json";
    const loaded = new Promise((r) => { xhr.onload = () => r("onload") });
    let states = 0;
    xhr.addEventListener("readystatechange", () => states++);
    xhr.send();
    assert.equal(await loaded, "onload");
    assert.equal(xhr.status, 418);
    assert.equal(xhr.readyState, 4);
    assert.deepEqual(xhr.response, { tea: true });
    assert.equal(xhr.getResponseHeader("Content-Type"), "application/json");
    assert.equal(states, 1);
    await until(() => nets.length > 0);
    assert.equal(nets[0].type, "xhr");
    assert.equal(nets[0].status, 418);
    assert.equal(nets[0].mocked, true);
  `)
})
