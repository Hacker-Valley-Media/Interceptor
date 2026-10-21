import { installNativeBridge } from "./native.ts";
import { render } from "./render.ts";
import { setSnapshot, state } from "./state.ts";
import { emptySnapshot, type Step } from "./types.ts";

// Opening state for the browser preview before the runner's server pushes the real
// snapshot. `?step=<name>` forces any screen (for design review / screenshots).
const seed = emptySnapshot();
Object.assign(seed, {
  generation: 1, phase: "ready", step: "ready",
  pairingPresent: true, ddiPresent: true, ddiLabel: "ready (98 MB)",
  iosVersion: "27.2", network: "wifi", status: "Ready to connect.",
});
const params = new URLSearchParams(location.search);
const forced = params.get("step") as Step | null;
if (forced) {
  seed.step = forced;
  if (forced === "allClear") seed.phase = "connected";
  else if (forced === "failed") { seed.phase = "failed"; seed.error = "The private link didn't come up. Check that Wi-Fi or Cellular Data is on, then try again."; }
  else if (forced === "setupNeeded") { seed.phase = "setup"; seed.pairingPresent = false; seed.ddiPresent = false; seed.ddiLabel = "not added"; }
  else if (["startingVpn","preparing","installing","connecting"].includes(forced)) seed.phase = "working";
  else if (["cellularOff","cellularOn","vpnOn"].includes(forced)) { seed.phase = "needsUser"; seed.network = "cellular"; }
}
const net = params.get("net"); // preview: ?net=cellular|wifi|none
if (net) seed.network = net as typeof seed.network;
setSnapshot(seed);

installNativeBridge();
render();
// The chooser and its answers live in the hash (#wifi, #usb, #cellular, #choose).
addEventListener("hashchange", () => { scrollTo(0, 0); render(); });

// The runner's loopback build polls /snapshot. In the pure preview this 404s and the
// seed stands. `?connect=1` auto-starts the flow; the runner only accepts it with
// the page's own `?t=<token>`.
async function poll() {
  try {
    const r = await fetch("/snapshot", { cache: "no-store" });
    if (r.ok) (window as any).InterceptorNative.applySnapshot(await r.json());
  } catch {}
}
if (location.protocol.startsWith("http") && !forced) {
  poll();
  setInterval(poll, 1500);
  if (new URLSearchParams(location.search).has("connect")) {
    import("./native.ts").then((n) => n.send("connect"));
  }
}

void state;
