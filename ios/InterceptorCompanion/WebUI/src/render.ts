import { send } from "./native.ts";
import { screenFor, type Choice, type Screen } from "./screens.ts";
import { state } from "./state.ts";
import type { Snapshot } from "./types.ts";

const app = () => document.getElementById("app")!;

// Same page shape as the Mac welcome window (cli/lib/hvm-window.ts brandHeader):
// logo + eyebrow + Balboa title, then text, cards, and buttons.
export function render() {
  const s = state.snapshot;
  const sc = screenFor(s, location.hash.slice(1));
  app().innerHTML = `
    <main class="screen tone-${sc.tone}">
      <header class="brand">
        <span class="logo" aria-hidden="true"></span>
        <div>
          <div class="eyebrow">${esc(sc.eyebrow)}</div>
          <h1>${esc(sc.title)}</h1>
        </div>
      </header>

      <div class="leads">${sc.lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>
      ${s.progress != null ? `<div class="bar"><div class="fill" style="width:${Math.round(s.progress * 100)}%"></div></div>` : ""}
      ${sc.working ? status(sc.working) : ""}
      ${sc.choices ? choicesBlock(sc.choices) : ""}
      ${sc.todo ? todoBlock(sc.todo) : ""}
      ${sc.button || sc.link ? `<div class="actions">
        ${sc.button ? `<button class="btn primary" data-action="${sc.button.action}">${esc(sc.button.label)}</button>` : ""}
        ${sc.link ? `<a class="btn" href="${sc.link.href}">${esc(sc.link.label)}</a>` : ""}
      </div>` : ""}
      ${sc.trouble ? disclosure("Having trouble?", sc.trouble) : ""}
      ${sc.about ? disclosure("What is this?", sc.about) : ""}

      <footer class="foot">${deviceLine(s)}</footer>
    </main>
  `;
  wire();
}

const status = (text: string) => `<div class="status"><span class="spin"></span>${esc(text)}</div>`;

function choicesBlock(cs: Choice[]): string {
  return `
    <nav class="choices">
      ${cs.map((c) => `
        <a class="card choice" href="${c.href}">
          <span class="choice-icon">${c.icon}</span>
          <span class="choice-text">
            <span class="choice-title">${esc(c.title)}</span>
            <span class="choice-sub">${esc(c.sub)}</span>
            ${c.tag || c.now ? `<span class="chips">${c.tag ? `<span class="chip">${esc(c.tag)}</span>` : ""}${c.now ? `<span class="chip ok">${esc(c.now)}</span>` : ""}</span>` : ""}
          </span>
          <span class="chev" aria-hidden="true">›</span>
        </a>`).join("")}
    </nav>
  `;
}

function todoBlock(t: NonNullable<Screen["todo"]>): string {
  return `
    <section class="card todo">
      <div class="eyebrow">${esc(t.head ?? "On your iPhone")}</div>
      <ol class="steps">
        ${t.steps.map((st, i) => `<li><span class="num">${i + 1}</span><span>${esc(st)}</span></li>`).join("")}
      </ol>
      <p class="note">${esc(t.reassure)}</p>
      ${t.wait ? status("Waiting for you…") : ""}
    </section>
  `;
}

function disclosure(label: string, text: string): string {
  return `
    <details class="card more">
      <summary>${esc(label)}</summary>
      <p>${esc(text)}</p>
    </details>
  `;
}

function deviceLine(s: Snapshot): string {
  const net = s.network === "wifi" ? "Wi-Fi" : s.network === "cellular" ? "Cellular" : "No network";
  // The runner sends iOS's own string, "Version 27.2 (Build 24B5099f)".
  const ios = s.iosVersion ? `iOS ${esc(s.iosVersion.replace(/^Version /, ""))}` : "";
  return [ios, net].filter(Boolean).join(" · ");
}

function wire() {
  for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-action]"))) {
    el.addEventListener("click", () => {
      // Drop the chosen route so the flow's own screens, and its result, show.
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      el.disabled = true;
      el.textContent = "Starting…";
      send(el.dataset.action!);
    });
  }
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
