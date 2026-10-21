// The native→page state contract. Native is the source of truth; the page renders
// it. Native sets a precise `step`; the WebUI owns ALL the friendly wording (so copy
// changes rebuild with `bun build-ui.ts`, no Swift rebuild). Unknown steps fall back
// to `phase` + `status`.

export type Phase =
  | "setup" // one-time setup not done (no pairing file / disk image)
  | "ready" // set up, ready to connect
  | "working" // busy, no user action needed right now
  | "needsUser" // waiting for the user to flip a switch on the phone
  | "connected" // linked to the computer — all clear
  | "failed";

// The exact moment, so the page can show the right screen. Native sets this.
export type Step =
  | "allClear"
  | "ready"
  | "startingVpn"
  | "cellularOff"
  | "preparing"
  | "cellularOn"
  | "installing"
  | "connecting"
  | "vpnOn"
  | "failed"
  | "setupNeeded";

export interface Snapshot {
  generation: number;
  phase: Phase;
  step: Step;
  pairingPresent: boolean;
  ddiPresent: boolean;
  ddiLabel: string;
  mountMethod: string;
  iosVersion: string;
  network: "wifi" | "cellular" | "none";
  status: string; // short native status line (fallback / detail)
  error: string | null;
  runnerPid: number | null;
  busy: boolean;
  progress: number | null; // 0..1 during a download/mount, else null
}

export type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue };

export function emptySnapshot(): Snapshot {
  return {
    generation: 0,
    phase: "setup",
    step: "setupNeeded",
    pairingPresent: false,
    ddiPresent: false,
    ddiLabel: "not set up",
    mountMethod: "personalized",
    iosVersion: "",
    network: "none",
    status: "",
    error: null,
    runnerPid: null,
    busy: false,
    progress: null,
  };
}
