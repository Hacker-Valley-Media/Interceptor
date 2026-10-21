import { render } from "./render.ts";
import { setSnapshot, state } from "./state.ts";
import type { JSONValue, Snapshot } from "./types.ts";

// page → native
const handler = () => (window as any).webkit?.messageHandlers?.companion;
// The runner opens Safari to /?t=<token>; POST /action must send it back.
const token = new URLSearchParams(location.search).get("t") ?? "";

export function send(action: string, values: Record<string, JSONValue> = {}) {
  const message = { action, ...values };
  if (handler()) { handler().postMessage(message); return; } // native WKWebView host
  if (location.protocol.startsWith("http")) { // the runner's loopback server
    fetch("/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-interceptor-token": token },
      body: JSON.stringify(message),
    }).catch(() => {});
    return;
  }
  simulate(message); // pure browser preview (bun dev:ui), no host at all
}

// Browser-only preview so the UI can be built/iterated with `bun dev:ui`.
function simulate(message: Record<string, JSONValue>) {
  const s = state.snapshot;
  switch (String(message.action)) {
    case "connect":
      s.busy = true; s.phase = "working"; s.status = "Starting the loopback reflector…";
      render();
      setTimeout(() => { s.status = "Mounting the developer disk image…"; render(); }, 900);
      setTimeout(() => { s.busy = false; s.phase = "connected"; s.runnerPid = 580; s.status = "Connected. The runner is home over your VPN."; render(); }, 2000);
      return;
    case "importPairing": s.pairingPresent = true; s.phase = s.ddiPresent ? "ready" : "setup"; break;
    case "importDDI": s.ddiPresent = true; s.ddiLabel = "present (98 MB)"; s.phase = s.pairingPresent ? "ready" : "setup"; break;
    case "downloadDDI": s.ddiPresent = true; s.ddiLabel = "present (98 MB)"; s.phase = s.pairingPresent ? "ready" : "setup"; break;
    default: return;
  }
  render();
}

// native → page
export function installNativeBridge() {
  (window as any).InterceptorNative = {
    applySnapshot(next: Snapshot) {
      if (next.generation < state.snapshot.generation) return state.snapshot.generation;
      // Redraw only on change: a redraw every poll closed an open "What is this?".
      if (JSON.stringify(next) === JSON.stringify(state.snapshot)) return state.snapshot.generation;
      setSnapshot(next);
      render();
      return state.snapshot.generation;
    },
    heartbeat() { return state.snapshot.generation; },
    snapshot() { return state.snapshot; },
    setSafeArea(insets: { top: number; bottom: number; left: number; right: number }) {
      const st = document.documentElement.style;
      st.setProperty("--safe-top", `${Math.max(0, insets.top)}px`);
      st.setProperty("--safe-bottom", `${Math.max(0, insets.bottom)}px`);
      st.setProperty("--safe-left", `${Math.max(0, insets.left)}px`);
      st.setProperty("--safe-right", `${Math.max(0, insets.right)}px`);
      return true;
    },
  };
}
