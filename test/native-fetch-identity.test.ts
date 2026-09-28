import { expect, test } from "bun:test"

// inject-net patches the page's globals when it is imported, and other suites
// mock modules for the whole process, so it runs in its own Bun process against
// happy-dom. Pages such as Upwork's sign-in bootstrap check that fetch still
// prints as native code and take a requestAnimationFrame fallback otherwise,
// which never runs in a hidden tab.
test("inject-net's fetch looks native and still captures and rewrites", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import assert from "node:assert/strict";
    import { GlobalRegistrator } from "@happy-dom/global-registrator";
    GlobalRegistrator.register({ url: "https://page.test/" });

    // The check as it ships in Upwork's bundles.
    const looksNative = (f) => typeof f === "function" &&
      Function.prototype.toString.call(f).replace(/[\\n ]/g, "").substr(-16) === "(){[nativecode]}";
    const seen = [];
    // An async function has no prototype and is not a constructor, like fetch.
    const stub = async function fetch(input) {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    };
    assert.equal(looksNative(stub), false, "control: a plain function fails the check");
    window.fetch = stub;
    await import("./extension/src/inject-net.ts");

    const f = window.fetch;
    assert.notEqual(f, stub, "the wrapper is installed");
    assert.equal(looksNative(f), true, "fetch prints as native code");
    assert.equal(f.name, "fetch");
    assert.equal(f.length, stub.length);
    assert.equal(f.prototype, undefined);
    assert.throws(() => new f("https://api.test/x"), TypeError);

    const nets = [];
    const heads = [];
    document.addEventListener("__interceptor_net", (e) => nets.push(e.detail));
    document.addEventListener("__interceptor_headers", (e) => heads.push(e.detail));
    const until = async (ready) => {
      for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
    };

    const res = await window.fetch("https://api.test/items?page=1", { headers: { "X-Probe": "1" } });
    assert.equal(res.status, 200);
    await until(() => nets.length > 0);
    assert.equal(nets.length, 1, "one capture entry per request");
    assert.equal(nets[0].url, "https://api.test/items?page=1");
    assert.equal(nets[0].type, "fetch");
    assert.equal(nets[0].body, '{"ok":true}');
    assert.equal(heads[0].headers["X-Probe"], "1");

    await f("https://api.test/unbound");
    assert.equal(seen.at(-1), "https://api.test/unbound", "unbound call reaches fetch");
    await f.call(window, "https://api.test/bound");
    assert.equal(seen.at(-1), "https://api.test/bound");

    document.dispatchEvent(new CustomEvent("__interceptor_set_overrides", {
      detail: [{ urlPattern: "*api.test/items*", queryAddOrReplace: { page: "7" } }],
    }));
    await window.fetch("https://api.test/items?page=1");
    assert.equal(seen.at(-1), "https://api.test/items?page=7", "override rewrites the request");
  `], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
})
