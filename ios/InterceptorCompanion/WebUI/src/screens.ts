// Every screen's friendly, plain-language content. Written for a first-time,
// non-technical person whose agent set this up. One clear idea per screen: what's
// happening, and the single thing (if any) to do.
//
// The main page asks how to connect (Wi-Fi, USB cable, VPN over cellular); each
// answer opens its own steps. The choice lives in the URL hash (#wifi, #usb,
// #cellular, #choose), so Safari's Back button works. While the runner is busy
// (Connect flow) or connected, its `step` wins over the hash.
import type { Snapshot, Step } from "./types.ts";

export type Tone = "ok" | "work" | "act" | "err" | "idle";

export interface Choice {
  href: string;
  icon: string;
  title: string;
  sub: string;
  tag?: string; // gold chip, e.g. "Requires VPN"
  now?: string; // green chip, e.g. "You're on Wi-Fi now"
}

export interface Screen {
  tone: Tone;
  eyebrow: string; // small label over the title (brand header), colored by tone
  title: string;
  lines: string[]; // short plain sentences
  working?: string; // spinner line on busy screens, like the Mac welcome's "Waiting for…"
  // Numbered steps for the person. `wait` adds "Waiting for you…" (the phone is
  // blocked until they do it); omit it when nothing is waiting.
  todo?: { head?: string; steps: string[]; reassure: string; wait?: boolean };
  button?: { label: string; action: string };
  choices?: Choice[];
  link?: { label: string; href: string };
  trouble?: string; // "Having trouble?" tap-to-expand
  about?: string; // "What is this?" tap-to-expand
}

const icons = {
  cellular: svg(`<rect x="9" y="28" width="5" height="8" rx="1" fill="currentColor"/><rect x="18" y="22" width="5" height="14" rx="1" fill="currentColor"/><rect x="27" y="16" width="5" height="20" rx="1" fill="currentColor"/><rect x="36" y="10" width="5" height="26" rx="1" fill="currentColor" opacity="0.4"/>`),
  wifi: svg(`<path d="M8 18a24 24 0 0132 0M14 25a15 15 0 0120 0M20 32a6 6 0 018 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="38" r="2.5" fill="currentColor"/>`),
  cable: svg(`<path d="M18 6v8M30 6v8M24 32v10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M14 14h20v8a10 10 0 01-20 0z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>`),
};

function svg(inner: string): string {
  return `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">${inner}</svg>`;
}

const back = { label: "Choose another way to connect", href: "#choose" };

// Older native builds send `phase`/`status` but no `step`. Derive a step so the
// friendly screens work against any build. Keyword-match the status for the
// user-action steps the old build expressed as free text.
function resolveStep(s: Snapshot): Step {
  if (s.step) return s.step;
  const t = (s.status || "").toLowerCase();
  if (s.phase === "connected") return "allClear";
  if (s.phase === "failed") return "failed";
  if (s.phase === "setup") return "setupNeeded";
  if (s.phase === "ready") return "ready";
  // working / needsUser: read the old status text
  if (/cellular data off|turn.*off/.test(t)) return "cellularOff";
  if (/cellular data (back )?on|turn.*on/.test(t)) return "cellularOn";
  if (/vpn|tailscale/.test(t)) return "vpnOn";
  if (/mount|install|disk image/.test(t)) return "installing";
  if (/reflector|private link|starting/.test(t)) return "startingVpn";
  if (/launch|connect/.test(t)) return "connecting";
  return s.phase === "needsUser" ? "vpnOn" : "connecting";
}

// `route` is the URL hash without "#". It only matters while nothing is running.
export function screenFor(s: Snapshot, route = ""): Screen {
  const step = resolveStep(s);
  if (step === "ready" || step === "setupNeeded" || step === "failed") {
    if (route === "wifi") return wifi();
    if (route === "usb") return usb();
    if (route === "cellular") return cellular(s);
    if (step !== "failed" || route === "choose") return chooser(s);
  }
  switch (step) {
    case "allClear":
      return {
        tone: "ok", eyebrow: "All set",
        title: "You're connected",
        lines: [
          "This iPhone is now linked to your computer.",
          "You can close this page. There's nothing else to do.",
        ],
        about: "Your computer can see this screen and tap for you until the phone restarts or you turn things off. Nothing leaves your devices.",
      };

    case "startingVpn":
      return {
        tone: "work", eyebrow: "Working",
        title: "Getting ready",
        lines: ["Setting up a private link on your iPhone."],
        working: "This takes a few seconds…",
      };

    case "cellularOff":
      return {
        tone: "act", eyebrow: "Action needed",
        title: "Turn Cellular Data OFF",
        lines: ["Your iPhone only lets me set it up while Cellular Data is off for a moment."],
        todo: {
          steps: [
            "Swipe down from the top-right corner to open Control Center.",
            "Tap the Cellular Data button (the signal bars) so it turns grey.",
          ],
          reassure: "Leave Wi-Fi off too. I'll keep going the second it's off, no need to come back here.",
          wait: true,
        },
        about: "This is a known iPhone quirk on cellular. It's only for a few seconds, then you'll turn it back on.",
      };

    case "preparing":
      return {
        tone: "work", eyebrow: "Working",
        title: "Preparing your iPhone",
        lines: ["Turning on the tools your computer needs."],
        working: "About 20 seconds…",
      };

    case "cellularOn":
      return {
        tone: "act", eyebrow: "Action needed",
        title: "Turn Cellular Data back ON",
        lines: ["Now I need the internet to finish the setup."],
        todo: {
          steps: [
            "Open Control Center again (swipe down from the top-right).",
            "Tap the Cellular Data button so it turns green.",
          ],
          reassure: "I'll continue by myself once you're back online.",
          wait: true,
        },
      };

    case "installing":
      return {
        tone: "work", eyebrow: "Working",
        title: "Installing the setup",
        lines: ["Getting the pieces from Apple and installing them."],
        working: "This can take a minute…",
      };

    case "connecting":
      return {
        tone: "work", eyebrow: "Working",
        title: "Connecting to your computer",
        lines: ["This iPhone is reaching out to your computer. It keeps trying by itself."],
        working: "Connecting…",
        todo: s.network === "cellular"
          ? {
            head: "If it takes more than a minute",
            steps: ["Open your VPN app (for example Tailscale).", "Make sure it's turned on and connected."],
            reassure: "It connects as soon as your VPN is on.",
          }
          : {
            head: "If it takes more than a minute",
            steps: [
              "Make sure this iPhone is on the same Wi-Fi as your computer, or that your VPN is on.",
              "Keep your iPhone unlocked.",
            ],
            reassure: "It connects as soon as it can reach your computer.",
          },
      };

    case "vpnOn":
      return {
        tone: "act", eyebrow: "Action needed",
        title: "Turn your VPN back on",
        lines: [
          "Your iPhone reaches your computer through a VPN, a private secure connection.",
          "Setting up just now switched it off, so turn it back on.",
        ],
        todo: {
          steps: [
            "Open your VPN app (for example Tailscale).",
            "Make sure it's turned ON and connected.",
          ],
          reassure: "Then you're done. Your iPhone connects to your computer on its own.",
          wait: true,
        },
        about: "A VPN is a safe, private link between your own devices. Your agent set this up earlier. If you're on the same Wi-Fi as your computer, you may not need it at all.",
      };

    case "failed":
      return {
        tone: "err", eyebrow: "Problem",
        title: "That didn't work",
        lines: [s.error || "Something went wrong while connecting.", "You can try again, or connect another way."],
        todo: {
          head: "Before you try again",
          steps: [
            "If you turned Cellular Data off, turn it back on in Control Center.",
            "Open your VPN app and turn it back on. Setting up may have switched it off.",
          ],
          reassure: "Then tap Try again, or pick another way to connect.",
        },
        button: { label: "Try again", action: "connect" },
        link: back,
        trouble: "If it keeps failing, connect over Wi-Fi or with a cable instead. Those don't need this setup.",
      };

    default:
      return chooser(s);
  }
}

// The main page: how do you want to connect?
function chooser(s: Snapshot): Screen {
  return {
    tone: "idle", eyebrow: "iPhone setup",
    title: "How do you want to connect Interceptor?",
    lines: ["Pick the one that fits where your iPhone is right now."],
    choices: [
      {
        href: "#wifi", icon: icons.wifi, title: "Wi-Fi",
        sub: "Your iPhone and your computer are on the same Wi-Fi.",
        now: s.network === "wifi" ? "You're on Wi-Fi now" : undefined,
      },
      {
        href: "#usb", icon: icons.cable, title: "USB cable",
        sub: "Your iPhone is plugged into your computer.",
      },
      {
        href: "#cellular", icon: icons.cellular, title: "VPN over cellular",
        sub: "You're away from your Wi-Fi. Needs a VPN app on this iPhone and your computer.",
        tag: "Requires VPN",
        now: s.network === "cellular" ? "You're on cellular now" : undefined,
      },
    ],
    about: "Interceptor lets your computer see this iPhone's screen and tap for you, so your agent can use your apps. Wi-Fi and a cable need nothing extra. Cellular needs a VPN, a private secure link between your own devices (for example Tailscale).",
  };
}

function wifi(): Screen {
  return {
    tone: "idle", eyebrow: "iPhone setup",
    title: "Connect over Wi-Fi",
    lines: ["Your computer reaches this iPhone over your Wi-Fi."],
    todo: {
      steps: [
        "Join the same Wi-Fi network as your computer.",
        "Keep your iPhone unlocked. To stop it locking, open Settings, then Display & Brightness, then Auto-Lock, and pick Never.",
        "If your iPhone asks to find devices on your local network, tap Allow.",
      ],
      reassure: "That's it. Your computer connects by itself whenever your agent needs the phone. You can close this page.",
    },
    link: back,
    trouble: "Just restarted your iPhone? Plug it into your computer with a cable for a moment, then unplug it. That helps your computer find it on Wi-Fi again. Still stuck? Open Settings, then Privacy & Security, then Local Network, and turn on InterceptorRunner.",
  };
}

function usb(): Screen {
  return {
    tone: "idle", eyebrow: "iPhone setup",
    title: "Connect with a cable",
    lines: ["The most dependable way, and the one to use the very first time."],
    todo: {
      head: "What to do",
      steps: [
        "Plug your iPhone into your computer with a USB cable.",
        "If your iPhone asks \"Trust This Computer?\", tap Trust and enter your passcode.",
        "Keep your iPhone unlocked.",
      ],
      reassure: "That's it. Your computer takes it from here. Once your iPhone trusts your computer, Wi-Fi works too.",
    },
    link: back,
    trouble: "Nothing happening? Unlock your iPhone and try another cable or port. Some cables only charge and can't carry data.",
  };
}

function cellular(s: Snapshot): Screen {
  if (!s.pairingPresent || !s.ddiPresent) {
    return {
      tone: "idle", eyebrow: "iPhone setup",
      title: "Cellular needs a one-time setup",
      lines: ["Your computer has to prepare this iPhone for cellular first."],
      todo: {
        head: "What to do",
        steps: [
          "Connect once over Wi-Fi or with a cable.",
          "Ask your agent to set up Interceptor for cellular on this iPhone.",
          "Come back here and pick VPN over cellular.",
        ],
        reassure: "You only do this once.",
      },
      link: back,
      about: "This puts a few files from your computer onto this iPhone, so it can start Interceptor by itself when you're away from Wi-Fi.",
    };
  }
  return {
    tone: "idle", eyebrow: "iPhone setup",
    title: "Connect with VPN over cellular",
    lines: ["Away from your Wi-Fi, your iPhone reaches your computer through a VPN, a private secure connection."],
    todo: {
      head: "Before you start",
      steps: [
        "Make sure your VPN app (for example Tailscale) is turned on, on this iPhone and on your computer.",
        "Tap Connect below. I may ask you to switch Cellular Data off and back on, and then to turn your VPN back on.",
      ],
      reassure: "About a minute. I'll tell you exactly what to do at each step.",
    },
    button: { label: "Connect my iPhone", action: "connect" },
    link: back,
    about: "Each time your iPhone restarts, it needs this short setup before your computer can reach it over cellular. Until the next restart, your iPhone connects on its own when you open Interceptor.",
  };
}
