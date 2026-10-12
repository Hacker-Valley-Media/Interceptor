// Service families: location, maps, music, share, pdf, container, vm, cdp, runtime.
// Scope follows the Windows/Linux product scope. Every subcommand and flag from the CLI inventory
// appears below; flags that cannot share one valid request (recipient aliases, snapshot
// modes) are split across cases or covered by a parser refusal that opens no UI.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Case, type Ctx, type Exclusion, type Family, macOnly, ok, refuse, skip } from "../types"
import { closeLeftovers, contains, list, pid } from "./helpers"

// --- location: status/request/current/monitor/distance/significant/visits In; geocoding Out ---
const APPLE_PARK = "37.3349,-122.0090", EMPIRE_STATE = "40.7484,-73.9857"
// significant: Windows OS movement threshold, Linux GeoClue 500 m threshold; visits: dwell detection on both.
/// The Windows test VM cannot grant location: Settings hangs on its splash screen and current
/// Windows ignores the registry consent, so fixes refuse there with the documented permission_denied.
const VM_LOCATION_OFF = { win32: refuse("permission_denied") }
// A Mac with Location Services off refuses with the setting to change.
const MAC_LOCATION_OFF: Case["expect"] = { ...VM_LOCATION_OFF, darwin: { ok: true, orRefuse: { code: "permission_denied", error: /turn on Location Services/ } } }

const location: Family = {
  family: "location",
  cases: [
    { id: "location.status", sub: "status", args: ["location", "status"] },
    { id: "location.request", sub: "request", args: ["location", "request", "--level", "whenInUse"], disruptive: true, focus: "allowed", timeoutMs: 50_000 },
    { id: "location.request-always", sub: "request", args: ["location", "request", "--level", "always"], disruptive: true, expect: { all: refuse("unsupported_operation"), darwin: ok } },
    { id: "location.request-temporary-accuracy", sub: "request-temporary-accuracy", args: ["location", "request-temporary-accuracy", "--purpose", "InterceptorParity"], expect: macOnly(), disruptive: true },
    { id: "location.current", sub: "current", expect: VM_LOCATION_OFF, args: ["location", "current"], disruptive: true, timeoutMs: 50_000,
      check: r => Array.isArray(r.json?.coordinate) ? undefined : `no coordinate: ${r.stdout.slice(0, 200)}` },
    { id: "location.monitor-start", sub: "monitor start", expect: MAC_LOCATION_OFF, args: ["location", "monitor", "start", "--accuracy", "hundredmeters"], disruptive: true, timeoutMs: 50_000,
      check: r => r.json?.monitoring === true ? undefined : "monitor start did not report monitoring" },
    { id: "location.monitor-tail", sub: "monitor tail", args: ["location", "monitor", "tail"], check: r => Array.isArray(r.json?.locations) ? undefined : "no locations array" },
    { id: "location.monitor-stop", sub: "monitor stop", args: ["location", "monitor", "stop"] },
    { id: "location.significant-start", sub: "significant start", expect: MAC_LOCATION_OFF, args: ["location", "significant", "start"], disruptive: true, timeoutMs: 50_000 },
    { id: "location.significant-stop", sub: "significant stop", args: ["location", "significant", "stop"] },
    { id: "location.visits-start", sub: "visits start", expect: { darwin: MAC_LOCATION_OFF?.darwin }, args: ["location", "visits", "start"], disruptive: true, timeoutMs: 50_000 },
    { id: "location.visits-stop", sub: "visits stop", args: ["location", "visits", "stop"] },
    // No compass on any qualified host: every provider answers ok:false with a note, as macOS does.
    { id: "location.heading-start", sub: "heading start", args: ["location", "heading", "start"] },
    { id: "location.heading-stop", sub: "heading stop", args: ["location", "heading", "stop"] },
    { id: "location.geocode", sub: "geocode", args: ["location", "geocode", "1 Apple Park Way, Cupertino, CA", "--locale", "en_US", "--region", `${APPLE_PARK},5000`], expect: macOnly() },
    { id: "location.reverse", sub: "reverse", args: ["location", "reverse", APPLE_PARK, "--locale", "en_US"], expect: macOnly() },
    { id: "location.postal-geocode", sub: "postal-geocode", expect: macOnly(),
      args: ["location", "postal-geocode", JSON.stringify({ street: "1 Apple Park Way", city: "Cupertino", state: "CA", postalCode: "95014", country: "United States" }), "--locale", "en_US"] },
    { id: "location.distance", sub: "distance", args: ["location", "distance", "--from", APPLE_PARK, "--to", EMPIRE_STATE],
      check: r => r.json?.meters > 4.0e6 && r.json?.meters < 4.25e6 ? undefined : `unexpected geodesic distance ${r.json?.meters}` },
    { id: "location.distance-out-of-range", sub: "distance", args: ["location", "distance", "--from", "91,0", "--to", "0,0"], expect: { all: refuse("invalid_request") } },
  ],
  // On Windows `location request` opens the Settings privacy page, which then holds the foreground; close it.
  async teardown(ctx) { for (const kind of ["monitor", "significant", "visits"]) await ctx.run(["location", kind, "stop"]); await closeLeftovers(ctx) },
}

// --- maps: Out on Windows/Linux (needs self-hosted Photon/Valhalla/Nominatim); MapKit on the Mac ---
const maps: Family = {
  family: "maps",
  cases: [
    { id: "maps.search", sub: "search", expect: macOnly(), args: ["maps", "search", "coffee", "--region", `${APPLE_PARK},0.05,0.05`, "--types", "pointOfInterest", "--poi-categories", "cafe", "--limit", "3"],
      check: (r, ctx) => { ctx.vars.mapItemId = r.json?.results?.[0]?.id } },
    // Address include and exclude are mutually exclusive, so each selector gets one case per filter.
    { id: "maps.search-address-include", sub: "search", expect: macOnly(), args: ["maps", "search", "Cupertino", "--types", "address", "--address-include", "locality,postalCode", "--limit", "2"] },
    { id: "maps.search-address-exclude", sub: "search", expect: macOnly(), args: ["maps", "search", "Cupertino", "--types", "address", "--address-exclude", "country", "--limit", "2"] },
    { id: "maps.complete", sub: "complete", expect: macOnly(),
      args: ["maps", "complete", "Apple Park", "--region", `${APPLE_PARK},0.2,0.2`, "--types", "address,pointOfInterest", "--poi-categories", "park", "--address-exclude", "country", "--limit", "5"] },
    { id: "maps.complete-address-include", sub: "complete", expect: macOnly(), args: ["maps", "complete", "1 Apple Park", "--types", "address", "--address-include", "locality"] },
    { id: "maps.directions", sub: "directions", expect: macOnly(), args: ["maps", "directions", "--from", APPLE_PARK, "--to", "37.3318,-122.0312", "--transport", "walking", "--requests-alternates"] },
    { id: "maps.eta", sub: "eta", expect: macOnly(), args: ["maps", "eta", "--from", "1 Apple Park Way, Cupertino, CA", "--to", "37.3318,-122.0312", "--transport", "auto"] },
    // The parser accepts --requests-alternates for eta but the shared validator refuses it on every host.
    { id: "maps.eta-alternates", sub: "eta", expect: { all: refuse("invalid_request") }, args: ["maps", "eta", "--from", APPLE_PARK, "--to", "37.3318,-122.0312", "--requests-alternates"] },
    // Without a search service no item exists, so the provider refuses the made-up id as stale.
    { id: "maps.mapitem-open", sub: "mapitem-open", expect: macOnly(["unsupported_operation", "not_installed", "background_unavailable", "stale_reference"]), disruptive: true, args: ctx => ["maps", "mapitem-open", ctx.vars.mapItemId ?? "interceptor-parity-item"] },
    { id: "maps.reverse", sub: "reverse", expect: macOnly(), args: ["maps", "reverse", APPLE_PARK] },
    { id: "maps.limit-out-of-range", sub: "search", expect: { all: refuse("invalid_request") }, args: ["maps", "search", "coffee", "--limit", "40"] },
  ],
}

// --- music: system player (GSMTC / MPRIS) In; library, library-search, play <id>, queue, subscription Out ---
// Transport controls act on the system player: an owned MPRIS player (Linux) or a WinRT
// MediaPlayer session (Windows) is started for the family and records each control.
const musicCalls = (ctx: Ctx, want: RegExp) => async () => {
  if (ctx.host !== "linux") return
  for (let i = 0; i < 15; i++) { const f = join(ctx.dir, "music.json"); if (existsSync(f) && want.test(readFileSync(f, "utf8"))) return; await ctx.sleep(200) }
  return `owned player never recorded ${want}`
}
const MUSIC_CONSENT = (ctx: Ctx) => ctx.vars.musicConsent as string | undefined
const music: Family = {
  family: "music",
  async setup(ctx) {
    if (ctx.host === "linux") ctx.vars.player = ctx.spawn(["gjs", join(ctx.fixtures, "linux-mpris-fixture.js"), ctx.dir])
    if (ctx.host === "win32") ctx.vars.player = ctx.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ctx.fixtures, "windows-media-fixture.ps1"), ctx.dir])
    if (ctx.vars.player) await ctx.sleep(4000)
    // The Apple Music privacy acknowledgement is a person-only consent sheet: SKError.privacyAcknowledgementRequired,
    // "the user has not yet acknowledged Apple's privacy policy for Apple Music" (apple-developer-docs/StoreKit/SKError).
    if (ctx.host === "darwin" && /Privacy acknowledgement required/i.test(String((await ctx.run(["music", "subscription"])).json?.error))) ctx.vars.musicConsent = "Apple Music privacy acknowledgement has not been accepted on this Mac"
  },
  async teardown(ctx) { ctx.vars.player?.kill() },
  cases: [
    { id: "music.status", sub: "status", args: ["music", "status"] },
    { id: "music.request", sub: "request", args: ["music", "request"], disruptive: true },
    { id: "music.subscription", sub: "subscription", args: ["music", "subscription"], expect: macOnly(), needs: MUSIC_CONSENT },
    { id: "music.library-songs", sub: "library", args: ["music", "library", "--kind", "song", "--limit", "5", "--offset", "0", "--sort", "title", "--ascending"], expect: macOnly() },
    { id: "music.library-albums", sub: "library", args: ["music", "library", "--type", "album", "--limit", "3", "--sort", "artistName", "--include-tracks"], expect: macOnly() },
    { id: "music.library-playlists", sub: "library", args: ["music", "library", "--kind", "playlist", "--filter", "Interceptor Parity", "--sort", "name"], expect: macOnly() },
    { id: "music.library-search", sub: "library-search", args: ["music", "library-search", "Interceptor Parity", "--types", "song,album", "--limit", "5", "--top", "--include-tracks"], expect: macOnly() },
    { id: "music.queue", sub: "queue", args: ["music", "queue"], expect: macOnly() },
    { id: "music.now-playing", sub: "now-playing", args: ["music", "now-playing"] },
    { id: "music.now-playing-system", sub: "now-playing", args: ["music", "now-playing", "--include-system"] },
    // System-player play is in scope; the shared validator still requires one library id.
    { id: "music.play-system", sub: "play", args: ["music", "play"], expect: { all: refuse() } },
    { id: "music.pause", sub: "pause", args: ["music", "pause"], disruptive: true, check: (_r, ctx) => musicCalls(ctx, /"Pause"/)() },
    { id: "music.resume", sub: "resume", args: ["music", "resume"], disruptive: true, check: (_r, ctx) => musicCalls(ctx, /"Play"/)() },
    { id: "music.seek", sub: "seek", args: ["music", "seek", "--time", "0"], disruptive: true },
    { id: "music.next", sub: "next", args: ["music", "next"], disruptive: true, check: (_r, ctx) => musicCalls(ctx, /"Next"/)() },
    { id: "music.previous", sub: "previous", args: ["music", "previous"], disruptive: true },
    { id: "music.repeat-all", sub: "repeat", args: ["music", "repeat", "all"], disruptive: true, check: (_r, ctx) => musicCalls(ctx, /LoopStatus=Playlist/)() },
    { id: "music.repeat-off", sub: "repeat", args: ["music", "repeat", "off"], disruptive: true },
    { id: "music.shuffle-songs", sub: "shuffle", args: ["music", "shuffle", "songs"], disruptive: true },
    { id: "music.shuffle-off", sub: "shuffle", args: ["music", "shuffle", "off"], disruptive: true },
    { id: "music.play-song", sub: "play", args: ["music", "play", "--song", "Interceptor Parity song"], expect: macOnly(), disruptive: true },
    { id: "music.play-album", sub: "play", args: ["music", "play", "--album", "Interceptor Parity album"], expect: macOnly(), disruptive: true },
    { id: "music.play-playlist", sub: "play", args: ["music", "play", "--playlist", "Interceptor Parity playlist"], expect: macOnly(), disruptive: true },
    { id: "music.stop", sub: "stop", args: ["music", "stop"], disruptive: true },
    // Apple Music catalog: MusicKit on the Mac; until the MusicKit App Service is enabled on the
    // App ID the Mac refuses with that requirement. Windows and Linux refuse: no MusicKit there.
    ...([["search", "Beatles", "--types", "song,album", "--limit", "3", "--offset", "0", "--top"], ["search-suggest", "beat"], ["charts", "--limit", "2"], ["recommendations"], ["song", "1441164426"], ["album", "1441164359"], ["artist", "136975"], ["playlist", "pl.f4d106fed2bd41149aaacabb233eb5eb"]] as const).map(([sub, ...rest]): Case => (
      { id: `music.catalog-${sub}`, sub, args: ["music", sub, ...rest], expect: { all: refuse("unsupported_operation", /only Apple's MusicKit on macOS/), darwin: { ok: true, orRefuse: { code: "permission_required", error: /MusicKit App Service|privacy acknowledgement required/ } } } })),
    { id: "music.include-tracks-artist", sub: "library", args: ["music", "library", "--kind", "artist", "--include-tracks"], expect: { all: refuse("invalid_request") } },
    { id: "music.repeat-bad-mode", sub: "repeat", args: ["music", "repeat", "sideways"], expect: { all: refuse("invalid_request") } },
  ],
}

// --- share: text/url/email/message/named/desktop-picture In where a handler exists; AirDrop and Reading List Mac-only ---
const SHARE_TXT = "Interceptor Parity Share.txt", SHARE_PNG = "Interceptor Parity Picture.png"
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
const MAIL = "parity@example.invalid", MAIL2 = "parity2@example.invalid", PHONE = "+15555550100", PHONE2 = "+15555550101"
const PARITY_URL = "https://example.com/interceptor-parity"
const BODY = ["--text", "Interceptor Parity text", "--url", PARITY_URL, "--body", "Interceptor Parity body"]
const SUBJECT = ["--subject", "Interceptor Parity subject"]
const txt = (ctx: Ctx) => join(ctx.dir, SHARE_TXT), png = (ctx: Ctx) => join(ctx.dir, SHARE_PNG)
// Compose and share UI comes forward by design (like the macOS share sheet), and it can appear a
// moment after the call returns, so the case waits for it before the next case runs.
/// Email with an attachment needs Simple MAPI; the Windows VM has no MAPI mail program, so it refuses there.
const NO_MAPI = { win32: refuse("not_installed") }
const compose = { disruptive: true, timeoutMs: 70_000, focus: "allowed" as const, check: async (_r: unknown, ctx: Ctx) => { await ctx.sleep(3000) } }
/** --recipient with --recipients is refused by the parser before any UI; covers --items and both aliases. */
const recipientAliases = (sub: string, item: (ctx: Ctx) => string, a: string, b: string): Case =>
  ({ id: `share.${sub}-recipient-aliases`, sub, args: ctx => ["share", sub, "--items", item(ctx), "--recipient", a, "--recipients", b], flags: ["--items", "--recipient", "--recipients"], expect: { all: refuse("invalid_request") } })

const share: Family = {
  family: "share",
  async setup(ctx) {
    writeFileSync(txt(ctx), "Interceptor Parity share attachment\n")
    writeFileSync(png(ctx), Buffer.from(PNG_1X1, "base64"))
  },
  cases: [
    { id: "share.services", sub: "services", args: ["share", "services"], check: r => list(r).length ? undefined : "no sharing services listed" },
    { id: "share.services-for", sub: "services", args: ctx => ["share", "services", "--for", txt(ctx)], flags: ["--for"] },
    { id: "share.email", sub: "email", ...compose, expect: NO_MAPI, args: ctx => ["share", "email", txt(ctx), ...BODY, ...SUBJECT, "--to", MAIL], flags: ["--text", "--url", "--body", "--subject", "--to"] },
    recipientAliases("email", txt, MAIL, MAIL2),
    { id: "share.message", sub: "message", ...compose, expect: { linux: refuse("not_installed"), win32: { ok: true, orRefuse: { code: "not_installed", error: /no default app is set for sms/ } } }, check: r => r.json?.success === false || r.json?.service === "message" ? undefined : "share message did not reach a handler", args: ["share", "message", "Interceptor Parity message", ...BODY, "--to", PHONE] },
    { id: "share.message-subject", sub: "message", ...compose, args: ["share", "message", "--text", "Interceptor Parity text", "--recipient", PHONE, ...SUBJECT],
      expect: { all: refuse("unsupported_target"), darwin: ok } },
    recipientAliases("message", () => "Interceptor Parity message", PHONE, PHONE2),
    { id: "share.airdrop", sub: "airdrop", ...compose, expect: macOnly(), args: ctx => ["share", "airdrop", txt(ctx), ...BODY, ...SUBJECT, "--to", MAIL], flags: ["--text", "--url", "--body", "--subject", "--to"] },
    recipientAliases("airdrop", txt, MAIL, MAIL2),
    { id: "share.reading-list", sub: "reading-list", ...compose, expect: macOnly(), args: ["share", "reading-list", "Interceptor Parity item", ...BODY, ...SUBJECT, "--to", MAIL] },
    recipientAliases("reading-list", () => PARITY_URL, MAIL, MAIL2),
    { id: "share.desktop-picture", sub: "desktop-picture", ...compose, expect: { linux: refuse("unsupported_target") }, args: ctx => ["share", "desktop-picture", png(ctx)] },
    { id: "share.desktop-picture-compose-fields", sub: "desktop-picture", ...compose, expect: { all: refuse("invalid_request"), darwin: refuse() },
      args: ctx => ["share", "desktop-picture", "--items", png(ctx), ...BODY, ...SUBJECT, "--to", MAIL], flags: ["--items", "--text", "--url", "--body", "--subject", "--to"] },
    recipientAliases("desktop-picture", png, MAIL, MAIL2),
    { id: "share.named", sub: "named", ...compose, expect: NO_MAPI, args: ctx => ["share", "named", "email", txt(ctx), ...BODY, ...SUBJECT, "--to", MAIL], flags: ["--text", "--url", "--body", "--subject", "--to"] },
    { id: "share.named-service-flag-aliases", sub: "named", expect: { all: refuse("invalid_request") },
      args: ctx => ["share", "named", "--service", "email", "--items", txt(ctx), "--recipient", MAIL, "--recipients", MAIL2], flags: ["--service", "--items", "--recipient", "--recipients"] },
    { id: "share.text", sub: "text", ...compose, args: ["share", "text", "Interceptor Parity text", "--service", "email", ...SUBJECT, "--recipient", MAIL] },
    { id: "share.text-repeated-recipients", sub: "text", expect: { all: refuse("invalid_request") }, args: ["share", "text", "Interceptor Parity text", "--service", "email", "--to", MAIL, "--recipients", MAIL2] },
    { id: "share.url", sub: "url", ...compose, args: ["share", "url", PARITY_URL, "--service", "email", ...SUBJECT, "--recipient", MAIL] },
    { id: "share.url-repeated-recipients", sub: "url", expect: { all: refuse("invalid_request") }, args: ["share", "url", PARITY_URL, "--service", "email", "--to", MAIL, "--recipients", MAIL2] },
  ],
}

// --- pdf: In everywhere (PDFKit on the Mac, staged PDFium elsewhere) against an owned two-page PDF ---
/** Two pages of Helvetica text, an outline, a Text note, one AcroForm text field and document info. */
function parityPdf(): string {
  const page1 = "BT /F1 24 Tf 72 700 Td (Interceptor Parity PDF) Tj ET", page2 = "BT /F1 24 Tf 72 700 Td (Second parity page) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R /AcroForm << /Fields [8 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [7 0 R 8 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 10 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
    "<< /Type /Annot /Subtype /Text /Rect [72 620 92 640] /Contents (Interceptor Parity note) /P 3 0 R >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Interceptor Parity field) /V (initial) /Rect [72 560 300 584] /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) >>",
    "<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>",
    `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
    "<< /Title (Interceptor Parity outline) /Parent 9 0 R /Dest [3 0 R /Fit] >>",
    "<< /Title (Interceptor Parity PDF) /Author (Interceptor Parity) /Subject (Desktop parity fixture) /Creator (Interceptor parity runner) >>",
  ]
  let out = "%PDF-1.7\n"
  const offsets = objects.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`
  return out + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 12 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}
const pdfPath = (ctx: Ctx, name = "Interceptor Parity.pdf") => join(ctx.dir, name)
const SRC = (ctx: Ctx) => pdfPath(ctx), FILLED = (ctx: Ctx) => pdfPath(ctx, "Interceptor Parity Filled.pdf")
const ANNOTATED = (ctx: Ctx) => pdfPath(ctx, "Interceptor Parity Annotated.pdf"), PAGE2 = (ctx: Ctx) => pdfPath(ctx, "Interceptor Parity Page 2.pdf")

const pdf: Family = {
  family: "pdf",
  async setup(ctx) { writeFileSync(SRC(ctx), parityPdf()) },
  cases: [
    { id: "pdf.info", sub: "info", args: ctx => ["pdf", "info", SRC(ctx)], check: r => r.json?.pageCount === 2 ? undefined : `pageCount ${r.json?.pageCount}` },
    { id: "pdf.text", sub: "text", args: ctx => ["pdf", "text", SRC(ctx)], check: contains("Interceptor Parity PDF") },
    { id: "pdf.text-page", sub: "text", args: ctx => ["pdf", "text", SRC(ctx), "--page", "2"], flags: ["--page"], check: contains("Second parity page") },
    { id: "pdf.text-range-attributed", sub: "text", args: ctx => ["pdf", "text", SRC(ctx), "--range", "1-2", "--attributed"], flags: ["--range", "--attributed"], check: contains("attributedString") },
    { id: "pdf.outline", sub: "outline", args: ctx => ["pdf", "outline", SRC(ctx)], check: contains("Interceptor Parity outline") },
    { id: "pdf.annotations", sub: "annotations", args: ctx => ["pdf", "annotations", SRC(ctx), "--page", "1", "--type", "Text"], flags: ["--page", "--type"], check: contains("Interceptor Parity note") },
    { id: "pdf.forms", sub: "forms", args: ctx => ["pdf", "forms", SRC(ctx)], check: contains("Interceptor Parity field") },
    { id: "pdf.forms-set", sub: "forms set", args: ctx => ["pdf", "forms", "set", SRC(ctx), "--field", "Interceptor Parity field", "--value", "Interceptor Parity value", "--out", FILLED(ctx)], flags: ["--field", "--value", "--out"] },
    { id: "pdf.forms-readback", sub: "forms", args: ctx => ["pdf", "forms", FILLED(ctx)], check: contains("Interceptor Parity value") },
    { id: "pdf.images", sub: "images", args: ctx => ["pdf", "images", SRC(ctx)], check: r => r.json?.pages?.length === 2 ? undefined : "expected two page rows" },
    { id: "pdf.find", sub: "find", args: ctx => ["pdf", "find", SRC(ctx), "parity"], check: r => r.json?.matchCount >= 2 ? undefined : `matchCount ${r.json?.matchCount}` },
    { id: "pdf.find-case-sensitive", sub: "find", args: ctx => ["pdf", "find", SRC(ctx), "Parity", "--case-sensitive"], flags: ["--case-sensitive"],
      check: r => r.json?.matchCount >= 1 && r.json.matches.every((m: any) => m.page === 1) ? undefined : `case-sensitive matches: ${JSON.stringify(r.json?.matches).slice(0, 200)}` },
    { id: "pdf.attributes", sub: "attributes", args: ctx => ["pdf", "attributes", SRC(ctx)], check: contains("Interceptor Parity PDF") },
    { id: "pdf.permissions", sub: "permissions", args: ctx => ["pdf", "permissions", SRC(ctx)] },
    { id: "pdf.annotate", sub: "annotate", flags: ["--page", "--rect", "--type", "--contents", "--out"],
      args: ctx => ["pdf", "annotate", SRC(ctx), "--page", "1", "--rect", "72,500,144,36", "--type", "Square", "--contents", "Interceptor Parity annotation", "--out", ANNOTATED(ctx)] },
    { id: "pdf.strip", sub: "strip", args: ctx => ["pdf", "strip", ANNOTATED(ctx), "--out", pdfPath(ctx, "Interceptor Parity Stripped.pdf")], flags: ["--out"] },
    { id: "pdf.split", sub: "split", args: ctx => ["pdf", "split", SRC(ctx), "--pages", "2", "--out", PAGE2(ctx)], flags: ["--pages", "--out"], check: r => r.json?.pageCount === 1 ? undefined : `pageCount ${r.json?.pageCount}` },
    { id: "pdf.merge", sub: "merge", args: ctx => ["pdf", "merge", SRC(ctx), PAGE2(ctx), "--out", pdfPath(ctx, "Interceptor Parity Merged.pdf")], flags: ["--out"],
      check: r => r.json?.pageCount === 3 ? undefined : `pageCount ${r.json?.pageCount}` },
    { id: "pdf.page-and-range", sub: "text", args: ctx => ["pdf", "text", SRC(ctx), "--page", "1", "--range", "1-2"], expect: { all: refuse("invalid_request") } },
    { id: "pdf.split-descending", sub: "split", args: ctx => ["pdf", "split", SRC(ctx), "--pages", "2-1", "--out", PAGE2(ctx)], expect: { all: refuse("invalid_request") } },
  ],
}

// --- container: rootless Podman on Linux, Apple container on the Mac, refused on Windows (no Podman machine) ---
const IMAGE = "docker.io/library/alpine:3.20", CONTAINER_TXT = "Interceptor Parity Container.txt"
const windowsRefuses = { win32: refuse() }
const CONTAINER_OFF = (ctx: Ctx) => ctx.vars.containerOff as string | undefined
// Bind mounts use a folder under the system temp dir: the Mac container runtime is launchd-spawned, and launchd
// processes cannot open files on a removable volume (measured: a bind from one hangs the VM and
// wedges the service until restart; the same mount from /tmp answers in 2s). The cases test mounts, not that grant.
const mountDir = (ctx: Ctx) => String(ctx.vars.mountDir)

const container: Family = {
  family: "container",
  async setup(ctx) {
    ctx.vars.mountDir = mkdtempSync(join(tmpdir(), "interceptor-parity-container-"))
    writeFileSync(join(mountDir(ctx), CONTAINER_TXT), "Interceptor Parity container file\n")
    // Starting Apple's container service is a system change on the person's Mac; only report it.
    if (ctx.host === "darwin" && Bun.spawnSync(["container", "system", "status"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) ctx.vars.containerOff = "the Apple container system service is not running on this Mac (container system start)"
  },
  cases: [
    // First run may pull the image; the provider deadline covers the pull.
    { id: "container.run-cmd", sub: "run", expect: windowsRefuses, needs: CONTAINER_OFF, timeoutMs: 150_000, args: ["container", "run", IMAGE, "--cmd", "echo Interceptor Parity", "--timeout", "120000", "--max-output-bytes", "65536"],
      check: contains("Interceptor Parity") },
    { id: "container.run-argv-env", sub: "run", expect: windowsRefuses, needs: CONTAINER_OFF, timeoutMs: 90_000, args: ["container", "run", IMAGE, "--env", "PARITY_VALUE=interceptor-parity", "--network", "isolated", "--", "sh", "-c", "echo $PARITY_VALUE"],
      check: contains("interceptor-parity") },
    { id: "container.run-volume-ro", sub: "run", expect: windowsRefuses, needs: CONTAINER_OFF, timeoutMs: 90_000, flags: ["--volume"],
      args: ctx => ["container", "run", IMAGE, "--volume", `${mountDir(ctx)}:/parity:ro`, "--", "cat", `/parity/${CONTAINER_TXT}`], check: contains("Interceptor Parity container file") },
    { id: "container.run-v-rw", sub: "run", expect: windowsRefuses, needs: CONTAINER_OFF, timeoutMs: 90_000, flags: ["-v"],
      args: ctx => ["container", "run", IMAGE, "-v", `${mountDir(ctx)}:/parity:rw`, "--", "sh", "-c", "echo written > '/parity/Interceptor Parity Container Out.txt'"],
      check: (_r, ctx) => existsSync(join(mountDir(ctx), "Interceptor Parity Container Out.txt")) ? undefined : "rw mount wrote no host file" },
    { id: "container.run-mount-json", sub: "run", expect: windowsRefuses, needs: CONTAINER_OFF, timeoutMs: 90_000, flags: ["--mount"],
      args: ctx => ["container", "run", IMAGE, "--mount", JSON.stringify({ hostPath: mountDir(ctx), mountPath: "/parity", mode: "ro" }), "--", "ls", "/parity"], check: contains(CONTAINER_TXT) },
    // Apple container has no host network namespace (0.11 and 1.5).
    { id: "container.run-host-network", sub: "run", expect: { win32: refuse(), darwin: refuse("unsupported_operation") }, timeoutMs: 90_000, args: ["container", "run", IMAGE, "--network", "host", "--", "true"] },
    { id: "container.run-cmd-and-argv", sub: "run", expect: { all: refuse("invalid_request") }, args: ["container", "run", IMAGE, "--cmd", "echo x", "--", "echo", "y"] },
    { id: "container.run-zero-timeout", sub: "run", expect: { all: refuse("invalid_request") }, args: ["container", "run", IMAGE, "--cmd", "true", "--timeout", "0"] },
  ],
  async teardown(ctx) { if (ctx.vars.mountDir) rmSync(String(ctx.vars.mountDir), { recursive: true, force: true }) },
}

// --- vm: Out on Windows/Linux (QEMU bundle + guest image, no nested virtualization). On the Mac only
// list and the TCC profile run; everything that needs a guest depends on vm create, which is disruptive. ---
const VM = "Interceptor-Parity-VM", CLONE = "Interceptor-Parity-VM-Clone", ADOPTED = "Interceptor-Parity-VM-Adopted"
const NEEDS_VM = "needs the guest that vm create makes, which is disruptive on the shared Mac"
const stateDir = (ctx: Ctx) => join(ctx.dir, "Interceptor-Parity-VM-state")
/** Every VM subcommand takes --state-dir; it goes right after the subcommand so exec argv after `--` stays intact. */
const vm = (id: string, sub: string, words: string[], rest: (ctx: Ctx) => string[], flags: string[], extra: Partial<Case> = {}): Case =>
  ({ id: `vm.${id}`, sub, args: ctx => ["vm", ...words, "--state-dir", stateDir(ctx), ...rest(ctx)], flags: ["--state-dir", ...flags], expect: { ...macOnly(), darwin: skip(NEEDS_VM) }, ...extra })
const guest = { expect: macOnly(), disruptive: true }

const vmFamily: Family = {
  family: "vm",
  cases: [
    vm("create", "create", ["create"], ctx => [VM, "--kind", "linux", "--cpu", "2", "--memory", "1073741824", "--disk", "1073741824", "--image", join(ctx.dir, "Interceptor-Parity-VM.img"),
      "--image-format", "raw", "--network", "nat", "--rosetta", "--share", `${ctx.dir}:parity:ro`], ["--kind", "--cpu", "--memory", "--disk", "--image", "--image-format", "--network", "--rosetta", "--share"], guest),
    vm("list", "list", ["list"], () => [], [], { expect: macOnly() }),
    vm("get", "get", ["get"], () => [VM], []),
    vm("inspect", "inspect", ["inspect"], () => [VM], []),
    vm("clone", "clone", ["clone"], () => [VM, CLONE], [], guest),
    vm("start", "start", ["start"], () => [VM, "--headless", "--wait-for-agent", "--detach"], ["--headless", "--wait-for-agent", "--detach"], guest),
    vm("start-vsock", "start", ["start"], () => [CLONE, "--wait-for-vsock"], ["--wait-for-vsock"], guest),
    vm("exec", "exec", ["exec"], () => [VM, "--env", "PARITY=1", "--user", "root", "--workdir", "/", "--tty", "--timeout", "30", "--", "echo", "Interceptor Parity"], ["--env", "--user", "--workdir", "--tty", "--timeout", "--"]),
    vm("cp", "cp", ["cp"], ctx => [join(ctx.dir, "Interceptor Parity VM.txt"), `${VM}:/tmp/interceptor-parity.txt`, "--timeout", "30"], ["--timeout"]),
    vm("share", "share", ["share"], ctx => [VM, ctx.dir, "parity2", "--rw"], ["--rw"], guest),
    vm("mount", "mount", ["mount"], () => [VM, "parity", "/mnt/parity", "--timeout", "30"], ["--timeout"]),
    vm("port-forward", "port-forward", ["port-forward"], () => [VM, "127.0.0.1:18080:80"], []),
    vm("screenshot", "screenshot", ["screenshot"], ctx => [VM, "--out", join(ctx.dir, "Interceptor Parity VM.png"), "--timeout", "30"], ["--out", "--timeout"]),
    vm("type", "type", ["type"], () => [VM, "Interceptor Parity", "--timeout", "30"], ["--timeout"]),
    vm("click-point", "click", ["click"], () => [VM, "100,100", "--button", "left", "--timeout", "30"], ["--button", "--timeout"]),
    vm("click-xy", "click", ["click"], () => [VM, "--x", "100", "--y", "100"], ["--x", "--y"]),
    vm("keys", "keys", ["keys"], () => [VM, "ctrl+c", "--timeout", "30"], ["--timeout"]),
    vm("read-ax", "read-ax", ["read-ax"], () => [VM, "--max-depth", "4", "--app", "Finder", "--timeout", "30"], ["--max-depth", "--app", "--timeout"]),
    vm("console", "console", ["console"], () => [VM, "--write", "echo parity", "--max-bytes", "4096", "--timeout", "30"], ["--write", "--max-bytes", "--timeout"]),
    vm("logs", "logs", ["logs"], () => [VM, "--limit", "50", "--timeout", "30"], ["--limit", "--timeout"]),
    vm("trust", "trust", ["trust"], () => [VM, "--no-prompt", "--timeout", "30"], ["--no-prompt", "--timeout"]),
    vm("trust-prompts", "trust", ["trust"], () => [VM, "--prompt", "--walkthrough", "--accessibility-prompt", "--screen-prompt", "--reset-denied"],
      ["--prompt", "--walkthrough", "--accessibility-prompt", "--screen-prompt", "--reset-denied"], guest),
    vm("snapshot-disk", "snapshot", ["snapshot"], () => [VM, "interceptor-parity-disk", "--op", "create", "--disk-only"], ["--op", "--disk-only"], guest),
    vm("snapshot-paused", "snapshot", ["snapshot"], () => [VM, "interceptor-parity-paused", "--op", "create", "--paused-state"], ["--op", "--paused-state"], guest),
    vm("snapshot-list", "snapshot", ["snapshot"], () => [VM, "--op", "list"], ["--op"]),
    vm("restore-disk", "restore", ["restore"], () => [VM, "interceptor-parity-disk", "--disk-only", "--headless"], ["--disk-only", "--headless"], guest),
    vm("restore-paused", "restore", ["restore"], () => [VM, "interceptor-parity-paused", "--paused-state"], ["--paused-state"], guest),
    vm("snapshot-delete", "snapshot", ["snapshot"], () => [VM, "interceptor-parity-disk", "--op", "delete"], ["--op"], guest),
    vm("pause", "pause", ["pause"], () => [VM], [], guest),
    vm("resume", "resume", ["resume"], () => [VM], [], guest),
    vm("reset", "reset", ["reset"], () => [VM], [], guest),
    vm("stop", "stop", ["stop"], () => [VM, "--force", "--timeout", "30"], ["--force", "--timeout"], guest),
    vm("adopt", "adopt", ["adopt"], ctx => [join(ctx.dir, "Interceptor-Parity-VM.img"), "--name", ADOPTED, "--kind", "linux", "--provider", "qemu", "--mode", "reference",
      "--install-agent", "--wait-for-agent", "--image-format", "raw"], ["--name", "--kind", "--provider", "--mode", "--install-agent", "--wait-for-agent", "--image-format"], guest),
    vm("install-ipsw", "install", ["install"], ctx => [VM, "--ipsw", join(ctx.dir, "Interceptor-Parity.ipsw")], ["--ipsw"], guest),
    vm("install-latest", "install", ["install"], () => [VM, "--from-latest"], ["--from-latest"], guest),
    vm("pull", "pull", ["pull"], () => [IMAGE], [], guest),
    // Desktop parsing fills `image` from the positional, so --image on pull is always a duplicate.
    vm("pull-image-flag", "pull", ["pull"], () => [IMAGE, "--image", IMAGE], ["--image"], { expect: { all: refuse("invalid_request") } }),
    vm("delete", "delete", ["delete"], () => [VM, "--force", "--keep-disk"], ["--force", "--keep-disk"], guest),
    vm("tcc-profile", "tcc profile generate", ["tcc", "profile", "generate"], ctx => [VM, "--service", "Accessibility,PostEvent", "--out", join(ctx.dir, "Interceptor Parity TCC.mobileconfig"),
      "--bundle-id", "com.interceptor.parity", "--app-path", "/Applications/Interceptor.app", "--identifier-type", "bundleID", "--code-requirement", 'identifier "com.interceptor.parity"',
      "--full-disk", "--include-user-only"], ["--service", "--out", "--bundle-id", "--app-path", "--identifier-type", "--code-requirement", "--full-disk", "--include-user-only"], { expect: macOnly() }),
    vm("unsafe-name", "get", ["get"], () => ["Interceptor Parity VM"], [], { expect: { all: refuse("invalid_request") } }),
  ],
  async teardown(ctx) { if (ctx.host !== "darwin") for (const name of [CLONE, ADOPTED, VM]) await ctx.run(["vm", "delete", "--state-dir", stateDir(ctx), name, "--force"]) },
}

// --- cdp: Path A against an owned headless Edge (Windows) or Chromium (Linux); Path 0 needs an Electron app ---
const CDP_PORT = "9341", PARITY_APP = "Interceptor Parity App"
const BROWSERS = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable"]
const NO_BROWSER = { darwin: skip("needs an owned headless Chromium, which is not started on the shared Mac") }
const cdpCtx = (ctx: Ctx) => ctx.vars.cdpContext ?? "cdp:interceptor-parity-cdp"

const cdp: Family = {
  family: "cdp",
  async setup(ctx) {
    if (ctx.host === "darwin") return
    const exe = BROWSERS.find(existsSync)
    if (!exe) throw new Error("no Edge or Chromium for the cdp cases")
    ctx.vars.browser = Bun.spawn([exe, "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${join(ctx.dir, "Interceptor Parity CDP profile")}`,
      "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    for (let i = 0; i < 30; i++) { if (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(r => r.ok, () => false)) return; await ctx.sleep(500) }
    throw new Error("headless browser never served CDP")
  },
  cases: [
    { id: "cdp.status", sub: "status", args: ["cdp", "status"] },
    { id: "cdp.discover", sub: "discover", args: ["cdp", "discover"] },
    { id: "cdp.app-status", sub: "app status", args: ["cdp", "app", "status"] },
    { id: "cdp.app-discover", sub: "app discover", args: ["cdp", "app", "discover"] },
    { id: "cdp.connect", sub: "connect", expect: NO_BROWSER, args: ["cdp", "connect", CDP_PORT, "--host", "127.0.0.1", "--app", "Interceptor Parity CDP", "--url", "about:blank"],
      check: (r, ctx) => { ctx.vars.cdpContext = r.json?.contextId; ctx.vars.cdpTarget = r.json?.attached; return r.json?.contextId ? undefined : "connect returned no context" } },
    { id: "cdp.targets", sub: "targets", expect: NO_BROWSER, args: ctx => ["cdp", "targets", "--context", cdpCtx(ctx)], flags: ["--context"], check: r => list(r).length ? undefined : "no targets" },
    { id: "cdp.attach", sub: "attach", expect: NO_BROWSER, args: ctx => ["cdp", "attach", ctx.vars.cdpTarget ?? "missing-target", "--context", cdpCtx(ctx)], flags: ["--context"] },
    { id: "cdp.raw", sub: "raw", expect: NO_BROWSER, args: ctx => ["cdp", "raw", "Runtime.evaluate", '{"expression":"6*7","returnByValue":true}', "--context", cdpCtx(ctx)], flags: ["--context"], check: contains("42") },
    { id: "cdp.raw-no-params", sub: "raw", expect: NO_BROWSER, args: ctx => ["cdp", "raw", "Browser.getVersion", "--context", cdpCtx(ctx)], flags: ["--context"] },
    { id: "cdp.detach", sub: "detach", expect: NO_BROWSER, args: ctx => ["cdp", "detach", "--context", cdpCtx(ctx)], flags: ["--context"] },
    { id: "cdp.connect-closed-port", sub: "connect", expect: { all: refuse() }, args: ["cdp", "connect", "1", "--host", "127.0.0.1"] },
    { id: "cdp.launch-unconfirmed", sub: "launch", expect: { all: refuse("invalid_request", /re-run with --confirm/i) }, args: ["cdp", "launch", PARITY_APP, "--port", "9342"] },
    // No Electron app is installed on the VMs, so a confirmed relaunch can only refuse there.
    { id: "cdp.launch", sub: "launch", expect: { all: refuse() }, disruptive: true, args: ["cdp", "launch", PARITY_APP, "--port", "9342", "--inspect-port", "9343", "--confirm"] },
    { id: "cdp.app-attach-missing", sub: "app attach", expect: { all: refuse() }, args: ctx => ["cdp", "app", "attach", PARITY_APP, "--inspect-port", "9344", "--ext-dir", ctx.dir, "--allow-sigusr1"],
      flags: ["--inspect-port", "--ext-dir", "--allow-sigusr1"] },
    { id: "cdp.app-attach-not-electron", sub: "app attach", expect: { all: refuse() }, args: ctx => ["cdp", "app", "attach", "--pid", pid(ctx)], flags: ["--pid"] },
    { id: "cdp.app-detach", sub: "app detach", args: ["cdp", "app", "detach", PARITY_APP] },
    { id: "cdp.app-detach-context", sub: "app detach", args: ["cdp", "app", "detach", "--context", "app:interceptor-parity-app"] },
  ],
  async teardown(ctx) { if (ctx.vars.cdpContext) await ctx.run(["cdp", "detach", "--context", ctx.vars.cdpContext]); ctx.vars.browser?.kill() },
}

// --- runtime: macOS-only by design. On the Mac only discovery and status run; agent verbs need runtime enable ---
const RT = "runtime:interceptor-parity-fixture"
const NEEDS_AGENT = "needs runtime enable, which relaunches the app with an injected agent (disruptive on the shared Mac)"
const agent = (id: string, sub: string, args: string[]): Case =>
  ({ id: `runtime.${id}`, sub, args: ["runtime", ...args, "--context", RT], expect: { ...macOnly(), darwin: skip(NEEDS_AGENT) } })

const runtime: Family = {
  family: "runtime",
  cases: [
    { id: "runtime.discover", sub: "discover", args: ["runtime", "discover"], expect: macOnly(), check: r => list(r).length ? undefined : "no apps discovered" },
    { id: "runtime.discover-app", sub: "discover", args: ctx => ["runtime", "discover", ctx.fixture.app], expect: macOnly(), check: contains("contextId") },
    { id: "runtime.status", sub: "status", args: ["runtime", "status"], expect: macOnly() },
    { id: "runtime.signid", sub: "signid", args: ["runtime", "signid"], expect: macOnly() },
    { id: "runtime.map-removed", sub: "map", args: ["runtime", "map"], expect: { all: refuse() } },
    { id: "runtime.enable", sub: "enable", args: ctx => ["runtime", "enable", ctx.fixture.app, "--build"], flags: ["--build"], expect: macOnly(), disruptive: true },
    // Platform targets are compiled out of shipped builds, so this refuses before any work on every host.
    { id: "runtime.enable-platform", sub: "enable", args: ["runtime", "enable", "Finder", "--allow-platform"], expect: { all: refuse() } },
    agent("ping", "ping", ["ping"]),
    { id: "runtime.ax", sub: "ax", args: ctx => ["runtime", "ax", "--pid", pid(ctx), "--type", "Interceptor Parity", "--context", RT], flags: ["--pid", "--type", "--context"], expect: { ...macOnly(), darwin: skip(NEEDS_AGENT) } },
    agent("draw", "draw", ["draw", "--ref", "n1", "--shape", "rect", "--text", "Interceptor Parity", "--font", "Menlo", "--x", "10", "--y", "10", "--w", "120", "--h", "40", "--color", "#FF0000",
      "--color2", "#0000FF", "--glow", "#00FF00", "--glow-radius", "4", "--radius", "6", "--opacity", "0.8", "--border", "1", "--border-color", "#000000", "--font-size", "12",
      "--animate", "pulse", "--spin", "0", "--id", "interceptor-parity-draw"]),
    agent("draw-clear", "draw", ["draw", "--clear"]),
    agent("tcc", "tcc", ["tcc", "--activate", "Accessibility"]),
    agent("file", "file", ["file", "/etc/hosts", "--bytes", "64"]),
    agent("file-path", "file", ["file", "--path", "/etc/hosts"]),
    agent("tree", "tree", ["tree", "--depth", "3", "--all"]),
    agent("read", "read", ["read", "--depth", "2", "--all"]),
    agent("layers", "layers", ["layers", "--ref", "n1", "--depth", "2"]),
    agent("eval", "eval", ["eval", "--ref", "n1", "--selector", "title", "--arg", "Interceptor Parity"]),
    agent("js", "js", ["js", 'ObjC.className(ObjC.cls("NSApplication"))']),
    agent("js-code", "js", ["js", "--code", "1 + 1"]),
    agent("hook", "hook", ["hook", "NSWindow", "setTitle:", "--domain", "Debugger"]),
    agent("hook-log", "hook log", ["hook", "log", "--clear", "--limit", "10"]),
    agent("unhook", "unhook", ["unhook", "NSWindow", "setTitle:"]),
    agent("hooks", "hooks", ["hooks"]),
    agent("trace", "trace", ["trace", "NSWindow", "--max", "10"]),
    agent("untrace", "untrace", ["untrace", "NSWindow"]),
    agent("cintercept", "cintercept", ["cintercept", "open"]),
    agent("cintercept-list", "cintercept", ["cintercept", "--list"]),
    agent("dom-watch", "dom-watch", ["dom-watch"]),
    agent("events", "events", ["events", "--clear", "--limit", "10"]),
    // --follow streams until interrupted; only the Windows/Linux refusal can run in a batch.
    agent("events-follow", "events", ["events", "--follow", "--interval", "500"]),
    agent("domains", "domains", ["domains"]),
    agent("mutate", "mutate", ["mutate", "--ref", "n1", "--set-text", "Interceptor Parity", "--set-layer-text", "Interceptor Parity", "--set-alpha", "0.9", "--set-bg", "#FFFFFF", "--set-hidden"]),
    agent("mutate-visible", "mutate", ["mutate", "--ref", "n1", "--set-visible"]),
    agent("intercept", "intercept", ["intercept", "--class", "NSWindow", "--selector", "title"]),
    agent("watch", "watch", ["watch", "--ref", "n1", "--key", "title"]),
    agent("net", "net", ["net"]),
    agent("net-log", "net log", ["net", "log", "--clear", "--limit", "10"]),
    agent("net-bodies", "net bodies", ["net", "bodies", "--host", "example.com", "--clear", "--limit", "10"]),
    { id: "runtime.screenshot", sub: "screenshot", args: ctx => ["runtime", "screenshot", "--ref", "n1", "--out", join(ctx.dir, "Interceptor Parity runtime.png"), "--context", RT],
      flags: ["--ref", "--out", "--context"], expect: { ...macOnly(), darwin: skip(NEEDS_AGENT) } },
    agent("delegate", "delegate", ["delegate", "macos_windows"]),
    { id: "runtime.disable", sub: "disable", args: ctx => ["runtime", "disable", ctx.fixture.app, "--keep"], flags: ["--keep"], expect: macOnly(), disruptive: true },
    { id: "runtime.verb-without-context", sub: "ping", args: ["runtime", "ping"], expect: { all: refuse() } },
  ],
}

export const services: Family[] = [location, maps, music, share, pdf, container, vmFamily, cdp, runtime]

/** Every inventory row of these families is exercised above; nothing is excluded. */
export const servicesExclusions: Exclusion[] = []
