import { readFileSync } from "node:fs"
import { join } from "node:path"

const fixtureRoot = process.env.BENCH_FIXTURES_DIR || join(new URL("..", import.meta.url).pathname, "fixtures")
const port = Number(process.env.BENCH_FIXTURE_PORT || 3241)

const baseRows = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Bravo" },
  { id: 3, name: "Charlie" },
  { id: 4, name: "Delta" },
  { id: 5, name: "Echo" },
]

function html(path: string): Response {
  return new Response(readFileSync(path, "utf-8"), { headers: { "content-type": "text/html; charset=utf-8" } })
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
}

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/health") return json({ ok: true, port })

    if (url.pathname === "/api/network/rows") {
      const count = Number(url.searchParams.get("count") || 3)
      return json({ count, rows: baseRows.slice(0, count) })
    }

    if (url.pathname === "/api/network/header-echo") {
      return json({ token: req.headers.get("x-bench-token") || null })
    }

    if (url.pathname === "/spa-lab/" || url.pathname === "/spa-lab") {
      return html(join(fixtureRoot, "spa-lab", "index.html"))
    }
    if (url.pathname === "/network-lab/" || url.pathname === "/network-lab") {
      return html(join(fixtureRoot, "network-lab", "index.html"))
    }
    if (url.pathname === "/editor-lab/" || url.pathname === "/editor-lab") {
      return html(join(fixtureRoot, "editor-lab", "index.html"))
    }
    if (url.pathname === "/trusted-input-lab/" || url.pathname === "/trusted-input-lab") {
      return html(join(fixtureRoot, "trusted-input-lab", "index.html"))
    }
    if (url.pathname === "/replay-lab/" || url.pathname === "/replay-lab") {
      return html(join(fixtureRoot, "replay-lab", "index.html"))
    }

    return new Response("Not found", { status: 404 })
  },
})

console.log(`bench-head-to-head fixture server listening on http://127.0.0.1:${port}`)
