// Dev preview server (bun WebUI/server.ts). Mirrors the loopback server the runner
// embeds, and walks the full step sequence so the Connect flow can be reviewed in a
// desktop browser. Mac-only; for building/iterating the UI.
import index from "./index.html";

type Snap = Record<string, unknown>;
function base(step: string, phase: string, extra: Snap = {}): Snap {
  return {
    generation: Date.now(), phase, step, pairingPresent: true, ddiPresent: true,
    ddiLabel: "ready (98 MB)", mountMethod: "personalized", iosVersion: "27.2",
    network: "cellular", status: "", error: null, runnerPid: null, busy: phase === "working",
    progress: null, ...extra,
  };
}
let snapshot: Snap = base("ready", "ready");

// A scripted connect flow for the preview: each step, with a pause.
function runConnectDemo() {
  const seq: [number, Snap][] = [
    [0, base("startingVpn", "working")],
    [1200, base("cellularOff", "needsUser")],
    [3000, base("preparing", "working")],
    [4600, base("cellularOn", "needsUser")],
    [6200, base("installing", "working", { progress: 0.4 })],
    [8000, base("connecting", "working")],
    [9200, base("vpnOn", "needsUser")],
    [11000, base("allClear", "connected", { runnerPid: 580 })],
  ];
  for (const [at, snap] of seq) setTimeout(() => { snapshot = snap; }, at);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4319),
  routes: { "/": index },
  development: { hmr: true, console: true },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/snapshot") return Response.json(snapshot);
    if (url.pathname === "/action" && req.method === "POST") {
      const msg = await req.json().catch(() => ({}));
      if (msg.action === "connect") runConnectDemo();
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`Interceptor WebUI at ${server.url}  (try ?step=cellularOff, ?connect=1)`);
