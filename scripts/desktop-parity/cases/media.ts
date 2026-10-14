// Media and local-intelligence families: audio, vad, listen, sounds, vision, nlp, ai,
// translate, detect, sensitive. Windows and Linux run the bundled models (vision,
// sounds, embeddings), the bundled whisper.cpp (Linux listen) and the local AI model, which
// downloads once on first use; the Mac uses Apple frameworks. Only sensitive still refuses
// off the Mac (and on it: the bridge lacks the entitlement). Every subcommand and flag from the CLI inventory
// appears below; flags the shared validators reject on a subcommand are exercised as
// refusals (`*.flag-rejected`).
import { writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { type Case, type Ctx, type Exclusion, type Family, type Res, refuse } from "../types"
import { contains, list } from "./helpers"

// Person-only gate: "When you call this method, the framework asks the person for permission to download the
// sourceLanguage and targetLanguage" (apple-developer-docs/Translation/TranslationSession/prepareTranslation).
const NO_PAIR = (ctx: Ctx) => ctx.host === "darwin" && ctx.vars.noPair ? "no translation language is installed on this Mac (System Settings > General > Language & Region > Translation Languages)" : undefined
const OUT_CODES = ["unsupported_operation", "not_installed", "background_unavailable"]
const LLAMA = /llama/i
/** MediaPipe test photos (Apache-2.0), copied to every host with the fixtures. */
const photo = (ctx: Ctx, name: string) => join(ctx.fixtures, name)
/** One warm-up per run: the first AI call downloads the local model (2.8 GB) and loads it. */
let localModel: Promise<string | undefined> | undefined
function ensureLocalModel(ctx: Ctx): Promise<string | undefined> {
  if (ctx.host === "darwin") return Promise.resolve(undefined)
  return localModel ??= (async () => {
    for (let waited = 0; waited < 60 * 60_000; waited += 15_000) {
      const status = await ctx.run(["ai", "status"])
      if (status.json?.available === true) { const warm = await ctx.run(["ai", "prompt", "Reply with the single word ready."], 240_000); return warm.exit === 0 ? undefined : `local AI model did not answer its warm-up: ${warm.stdout.slice(0, 200)}` }
      // Any AI command starts or continues the download; status alone never does.
      if (waited % 60_000 === 0) await ctx.run(["ai", "prompt", "ready"], 30_000)
      await ctx.sleep(15_000)
    }
    return "local AI model was not available after 60 minutes"
  })()
}
const needsModel = async (ctx: Ctx) => { const problem = await ensureLocalModel(ctx); if (problem) throw new Error(problem) }
const no = { all: refuse() }
/** Checks run on refusals too; only check results that succeeded. */
const whenOk = (f: (r: Res, ctx: Ctx) => string | void) => (r: Res, ctx: Ctx) => r.exit === 0 && r.json?.success !== false ? f(r, ctx) : undefined
const app = (ctx: Ctx) => ctx.fixture.app

/** Default (or first) device id for an audio channel; a placeholder when the host has none. */
async function device(ctx: Ctx, channel: "input" | "output"): Promise<string> {
  const rows = list(await ctx.run(["audio", channel, "devices"]))
  return String((rows.find(d => d.isDefault) ?? rows[0])?.uniqueID ?? "Interceptor Parity device")
}

// 128x36 grayscale PNG reading "PARITY 186" (Apple Vision OCR verified).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAIAAAAAkCAAAAABk2G3vAAAAOGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAACoAIABAAAAAEAAACAoAMABAAAAAEAAAAkAAAAAO7hHxsAAAOZSURBVFgJ7ZdtaJVlGMd/z85xO0tnvkXLtMxgr82crVTGWsGKSkWHGomSWZuQKINBRdiJMQhmWvolbUkTRCx78XUSU/ZBOSTkG0xTp/OD5CQEZ3O6jTzb1XXfz7Pt2c4R/LL25VyM+/nf//u6r+t//vd9Hs4cYWQjaWTbQ0JAwoGEAwkHgsP0Iuq50pYzzqt990J7XvoD+4gba0yCk/n+GTt9GdKjBlmap0t/cvFRye8vtHw/5PYofzlIWptJFrk6G97T560lIc175pDheqvSFE8/ZnCcwOM+9AqPP63EdUdnjWalj2ajxQ3yvJcHy0S77dacFVBlckV2mVbvityboh/mEcXfK1np7gjU25SYwSdg3daysZCnKV+ZPWUmVwVU1m3IhkCHwQ2yLRxeDxPC4fCvcgwyo3IxifS7tu432tYKOAAzbkQ3QZFIc4Axmy59YrHNGjL4BDSItAZxbou8yGNzmfCvK0Dp3ulw1BWgXBQy3CoLYKcsg2/daZjZdbBS5HPYodRERot8ATWKw6tXd+ojNgZ/DScXIWe5epL5pbQdcb3T0SmCa/2zAVAToLppD1kfuNSoqkiGRaXmADnTxiJoIlhxatv25bW1qQMb/cjTZP2VTr24143o/ZdghS659F8T4UocB6QcJsM+r0avSMQ6IOEQGcUh5jSL5JC9yvR7rSv20xvGdwRfR2r19j8r8hyp9ySTNPVMBcx6/SU92Rf6xPiPQG6Ym1boq+wJOPGK6Tlmc5f0BElmarHmLfWl+aBPgNnD6EY5DwWRyGL42Ta19Lw7cQXIZ7r6u6+cK6B+FCmrPs6DN++Levp2VJonkRzfgsECnnrnhNiituti27Tiu0JYr03c4xjkgLTCTF9/7whmwWGRLn1nNEoB/KEZZRDxJ/Zj3yU81N197Yc58CM8qhHgcIfR8Vb5Ftj8t5UUM6SgDg+N3j9B64RmwjmyQFWi+6cNzbNzn4DkFC0Hp1qY+4/GSrr1+2yiYCGd1S58qDHpVfiok8a9UEKlw9rjN2vqyX4y7mafAG9dDVhooA4KbVQ7bG/x8MM8KlKpGzuupJ35ueSX0Vr8+KekbIi/s0+AXnT9M/GLJ6AklSMdLj1jKdFqs+6mOAM/ZZXoq2A3uzlvnCxM7mnniS8PKlm7MaRj1m/61ooXzjD9XxBtbs/Ut4eN+xdu5k+K19xwwyXgQf1i+EEGxqz+D0RCQMKBhAMJB0bcgf8ARnG7HnzG5ewAAAAASUVORK5CYII="
function png(ctx: Ctx): string {
  const path = join(ctx.dir, "Interceptor Parity vision.png")
  if (!existsSync(path)) writeFileSync(path, Buffer.from(PNG, "base64"))
  return path
}
function file(ctx: Ctx, name: string, body: string): string {
  const path = join(ctx.dir, `Interceptor Parity ${name}.txt`)
  writeFileSync(path, body)
  return path
}

const START = "<input|output|both> start", STOP = "<input|output|both> stop", LEVEL = "<input|output|both> level", DEVICES = "<input|output|both> devices"
const VISION_SUBS = ["text", "faces", "hands", "bodies", "classify", "saliency"]
const SENTENCE = "Visit https://example.com or call 415-555-0100 tomorrow."
const ALL_TRANSLATE_FLAGS = ["--from", "en", "--to", "es", "--sample", "Hello", "--json", '["Hello"]']

export const media: Family[] = [
  {
    family: "audio",
    cases: [
      { id: "audio.input.devices", sub: DEVICES, args: ["audio", "input", "devices"], check: r => Array.isArray(r.json?.devices) ? undefined : "no devices array" },
      { id: "audio.output.devices", sub: DEVICES, args: ["audio", "output", "devices"], check: r => Array.isArray(r.json) ? undefined : "expected a device array" },
      { id: "audio.both.devices", sub: DEVICES, args: ["audio", "both", "devices"], check: r => Array.isArray(r.json?.input) && Array.isArray(r.json?.output) ? undefined : "expected input and output arrays" },
      { id: "audio.input.level-idle", sub: LEVEL, args: ["audio", "input", "level"], check: contains("active") },
      { id: "audio.input.start-save", sub: START, args: ["audio", "input", "start", "--save"], check: contains("filePath") },
      { id: "audio.input.level-active", sub: LEVEL, args: ["audio", "input", "level"], check: contains('"active":true') },
      { id: "audio.input.stop-saved", sub: STOP, args: ["audio", "input", "stop"], check: contains("filePath") },
      { id: "audio.input.start-device", sub: START, args: async ctx => ["audio", "input", "start", "--device", await device(ctx, "input")], flags: ["--device"] },
      { id: "audio.input.stop", sub: STOP, args: ["audio", "input", "stop"] },
      // Linux captures an app only while it has a playback stream; the fixture plays nothing.
      { id: "audio.output.start-app-save", sub: START, args: ctx => ["audio", "output", "start", "--app", app(ctx), "--save"], flags: ["--app", "--save"],
        expect: { linux: refuse(["unsupported_target", "not_installed"]) }, check: whenOk(contains("filePath")) },
      { id: "audio.output.level", sub: LEVEL, args: ["audio", "output", "level"] },
      { id: "audio.output.stop", sub: STOP, args: ["audio", "output", "stop"] },
      // The Mac bridge captures output per app or system, never per output device.
      { id: "audio.output.start-device", sub: START, args: async ctx => ["audio", "output", "start", "--device", await device(ctx, "output")], flags: ["--device"], expect: { darwin: refuse() } },
      { id: "audio.output.stop-device", sub: STOP, args: ["audio", "output", "stop"] },
      { id: "audio.both.start-save", sub: START, args: ["audio", "both", "start", "--save"], check: contains("FilePath") },
      { id: "audio.both.level", sub: LEVEL, args: ["audio", "both", "level"], check: r => r.json?.input && r.json?.output ? undefined : "expected input and output levels" },
      { id: "audio.both.stop", sub: STOP, args: ["audio", "both", "stop"] },
      { id: "audio.input.start-app-rejected", sub: START, args: ["audio", "input", "start", "--app", "Interceptor Parity"], expect: no },
      { id: "audio.output.stop.flag-rejected", sub: STOP, args: ["audio", "output", "stop", "--app", "Interceptor Parity", "--device", "x", "--save"], expect: no },
      { id: "audio.input.level.flag-rejected", sub: LEVEL, args: ["audio", "input", "level", "--device", "x", "--save", "--app", "Interceptor Parity"], expect: no },
      { id: "audio.both.devices.flag-rejected", sub: DEVICES, args: ["audio", "both", "devices", "--app", "Interceptor Parity", "--device", "x", "--save"], expect: no },
    ],
    async teardown(ctx) { for (const ch of ["input", "output", "both"]) await ctx.run(["audio", ch, "stop"]) },
  },
  {
    family: "vad",
    cases: [
      { id: "vad.status-idle", sub: "status", args: ["vad", "status"], check: contains("active") },
      { id: "vad.start", sub: "start", args: ["vad", "start"] },
      { id: "vad.status-active", sub: "status", args: ["vad", "status"], check: contains('"active":true') },
      { id: "vad.stop", sub: "stop", args: ["vad", "stop"] },
      { id: "vad.start-threshold", sub: "start", args: ["vad", "start", "--threshold", "0.5"] },
      { id: "vad.stop-threshold", sub: "stop", args: ["vad", "stop"] },
      { id: "vad.status.threshold-rejected", sub: "status", args: ["vad", "status", "--threshold", "0.5"], expect: no },
      { id: "vad.start.threshold-range", sub: "start", args: ["vad", "start", "--threshold", "2"], expect: no },
    ],
    async teardown(ctx) { await ctx.run(["vad", "stop"]) },
  },
  {
    family: "listen",
    cases: [
      { id: "listen.status", sub: "status", args: ["listen", "status"], check: contains("listening") },
      { id: "listen.vocab-add", sub: "vocab", args: ["listen", "vocab", "add", "Interceptor Parity"] },
      { id: "listen.vocab-list", sub: "vocab", args: ["listen", "vocab", "list"], check: contains("Interceptor Parity") },
      { id: "listen.start-device", sub: "start", args: async ctx => ["listen", "start", "--device", await device(ctx, "input")], flags: ["--device"], check: contains('"listening":true') },
      { id: "listen.tail", sub: "tail", args: ["listen", "tail"], check: contains("listening") },
      { id: "listen.transcript", sub: "transcript", args: ["listen", "transcript"] },
      { id: "listen.stop", sub: "stop", args: ["listen", "stop"] },
      { id: "listen.start", sub: "start", args: ["listen", "start"], check: contains('"listening":true') },
      { id: "listen.stop-again", sub: "stop", args: ["listen", "stop"] },
      { id: "listen.status-after", sub: "status", args: ["listen", "status"], check: contains('"listening":false') },
      { id: "listen.vocab-clear", sub: "vocab", args: ["listen", "vocab", "clear"] },
      ...["stop", "status", "transcript", "tail", "vocab"].map((s): Case => ({ id: `listen.${s}.flag-rejected`, sub: s, args: ["listen", s, "--device", "Interceptor Parity device"], expect: no })),
    ],
    async teardown(ctx) { await ctx.run(["listen", "stop"]) },
  },
  {
    family: "sounds",
    cases: [
      { id: "sounds.status", sub: "status", args: ["sounds", "status"], check: contains("classifying") },
      { id: "sounds.start", sub: "start", args: ["sounds", "start"], check: contains('"classifying":true') },
      { id: "sounds.status-after-start", sub: "status", args: ["sounds", "status"], check: contains('"classifying":true') },
      { id: "sounds.tail", sub: "tail", args: ["sounds", "tail"], check: contains("classifications") },
      { id: "sounds.log-filter", sub: "log", args: ["sounds", "log", "--filter", "Speech"], check: r => Array.isArray(r.json) ? undefined : "expected a classification array" },
      { id: "sounds.stop", sub: "stop", args: ["sounds", "stop"] },
      ...["start", "stop", "status", "tail"].map((s): Case => ({ id: `sounds.${s}.flag-rejected`, sub: s, args: ["sounds", s, "--filter", "Speech"], expect: no })),
    ],
    async teardown(ctx) { await ctx.run(["sounds", "stop"]) },
  },
  {
    family: "vision",
    cases: [
      ...VISION_SUBS.flatMap((s): Case[] => {
        // text + faces run on the OS everywhere; hands, bodies, classify and saliency run the bundled models off the Mac.
        const list = { faces: "faces", hands: "hands", bodies: "bodies", classify: "classifications", saliency: "regions" }[s]
        return [
        { id: `vision.${s}.image`, sub: s, args: ctx => ["vision", s, "--image", png(ctx)], flags: ["--image"],
          check: s === "text" ? whenOk(contains("PARITY")) : (r => Array.isArray(r.json?.[list!]) ? undefined : `${s} result has no ${list} array`) },
        { id: `vision.${s}.app`, sub: s, args: ctx => ["vision", s, "--app", app(ctx)], flags: ["--app"],
          check: s === "text" ? whenOk(r => /parity|fixture/i.test(JSON.stringify(r.json)) ? undefined : "OCR missed the fixture window text") : (r => Array.isArray(r.json?.[list!]) ? undefined : `${s} result has no ${list} array`) },
        ...(s === "text" ? [] : [{ id: `vision.${s}.debug-dump.flag-rejected`, sub: s, args: (ctx: Ctx) => ["vision", s, "--image", png(ctx), "--debug-dump", join(ctx.dir, `Interceptor Parity ${s} dump.png`)], flags: ["--image", "--debug-dump"], expect: no }]),
      ]}),
      { id: "vision.text.debug-dump", sub: "text", args: ctx => ["vision", "text", "--app", app(ctx), "--debug-dump", join(ctx.dir, "Interceptor Parity vision dump.png")], flags: ["--app", "--debug-dump"],
        check: whenOk((_r, ctx) => existsSync(join(ctx.dir, "Interceptor Parity vision dump.png")) ? undefined : "debug dump was not written") },
      // Real photos with known content (MediaPipe test assets).
      { id: "vision.classify.photo", sub: "classify", args: ctx => ["vision", "classify", "--image", photo(ctx, "burger.jpg")], flags: ["--image"],
        check: (r, ctx) => (ctx.host === "darwin" ? /burger|food|sandwich/i : /burger/i).test(JSON.stringify(r.json?.classifications)) ? undefined : `the burger photo was classified as ${JSON.stringify(r.json?.classifications).slice(0, 200)}` },
      { id: "vision.hands.photo", sub: "hands", args: ctx => ["vision", "hands", "--image", photo(ctx, "left_hands.jpg")], flags: ["--image"],
        check: r => r.json?.count >= 1 && r.json.hands.every((h: any) => Object.keys(h.joints).length >= 15 && [-1, 1].includes(h.chirality)) ? undefined : `the photo of two hands gave ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "vision.bodies.photo", sub: "bodies", args: ctx => ["vision", "bodies", "--image", photo(ctx, "pose.jpg")], flags: ["--image"],
        check: r => r.json?.count === 1 && Object.keys(r.json.bodies[0].joints).length >= 10 ? undefined : `the photo of one person gave ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "vision.saliency.photo", sub: "saliency", args: ctx => ["vision", "saliency", "--image", photo(ctx, "burger.jpg")], flags: ["--image"],
        check: r => r.json?.regions?.length >= 1 && r.json.regions.every((g: any) => g.width > 0 && g.height > 0) ? undefined : `the burger photo gave ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "vision.text.app-and-image", sub: "text", args: ctx => ["vision", "text", "--app", app(ctx), "--image", png(ctx)], flags: ["--app", "--image"], expect: no },
    ],
  },
  {
    family: "nlp",
    setup: needsModel,
    cases: [
      { id: "nlp.entities", sub: "entities", args: ["nlp", "entities", "Tim Cook visited Paris on Monday."], timeoutMs: 120_000, check: contains("Paris") },
      { id: "nlp.language", sub: "language", args: ["nlp", "language", "Bonjour tout le monde, comment allez-vous ?"], check: whenOk(r => /^fr/i.test(String(r.json?.dominant)) ? undefined : `language detection did not return French: ${r.json?.dominant}`) },
      { id: "nlp.sentiment", sub: "sentiment", args: ["nlp", "sentiment", "I really love how well this parity test works."], timeoutMs: 120_000, check: r => r.json?.score > 0 ? undefined : `a clearly positive sentence scored ${r.json?.score}` },
      // Unicode word segmentation needs no model, so it works on every host.
      { id: "nlp.tokens", sub: "tokens", args: ["nlp", "tokens", "Hello parity world"], check: contains("parity") },
      { id: "nlp.similar", sub: "similar", args: ["nlp", "similar", "cat", "dog"], check: async (r, ctx) => { const far = await ctx.run(["nlp", "similar", "cat", "carburetor"]); return typeof r.json?.distance === "number" && r.json.distance < far.json?.distance ? undefined : `cat/dog ${r.json?.distance} is not closer than cat/carburetor ${far.json?.distance}` } },
      { id: "nlp.embed", sub: "embed", args: ["nlp", "embed", "house"], check: r => Array.isArray(r.json?.vector) && r.json.vector.length === r.json.dimensions && r.json.dimensions > 0 ? undefined : "embedding has no vector of its stated size" },
      { id: "nlp.similar-one-word", sub: "similar", args: ["nlp", "similar", "cat"], expect: no },
    ],
  },
  {
    family: "ai",
    setup: needsModel,
    cases: [
      { id: "ai.status", sub: "status", args: ["ai", "status"], check: (r, ctx) => ctx.host === "darwin" ? contains("available")(r) : r.json?.available === true ? undefined : `the local AI model is not available: ${r.json?.reason}` },
      { id: "ai.prompt", sub: "prompt", args: ["ai", "prompt", "Reply with exactly this one word and nothing else: parity"], timeoutMs: 120_000, check: r => /parity/i.test(String(r.json)) ? undefined : `the prompt answer was ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "ai.session-start", sub: "session start", args: ["ai", "session", "start"], timeoutMs: 120_000 },
      { id: "ai.session-send", sub: "session send", args: ["ai", "session", "send", "Say hello in one word."], timeoutMs: 120_000, check: r => typeof r.json?.response === "string" && r.json.response.trim() ? undefined : "the session gave no response text" },
      { id: "ai.session-history", sub: "session history", args: ["ai", "session", "history"], check: r => Array.isArray(r.json) && r.json.length === 2 ? undefined : `history after one exchange has ${Array.isArray(r.json) ? r.json.length : "no"} messages` },
      { id: "ai.session-end", sub: "session end", args: ["ai", "session", "end"] },
      { id: "ai.status-extra-arg", sub: "status", args: ["ai", "status", "extra"], expect: no },
    ],
    async teardown(ctx) { await ctx.run(["ai", "session", "end"]) },
  },
  {
    family: "translate",
    // The Mac translates only installed pairs and cannot download one headless: use the first installed en->X pair.
    async setup(ctx) {
      ctx.vars.to = "es"
      if (ctx.host !== "darwin") return needsModel(ctx)
      for (const to of ["es", "fr", "de", "it", "pt", "ja", "zh", "ko"]) {
        if ((await ctx.run(["translate", "availability", "--from", "en", "--to", to])).json?.status === "installed") { ctx.vars.to = to; return }
      }
      ctx.vars.noPair = true
    },
    cases: [
      { id: "translate.status", sub: "status", args: ["translate", "status"], check: contains("available") },
      { id: "translate.languages", sub: "languages", args: ["translate", "languages"], check: r => Array.isArray(r.json?.supported) && r.json.supported.length > 1 ? undefined : "no supported language list" },
      { id: "translate.availability-from", sub: "availability", args: ctx => ["translate", "availability", "--from", "en", "--to", ctx.vars.to], flags: ["--from", "--to"], timeoutMs: 120_000, check: (r, ctx) => ctx.host === "darwin" || r.json?.status === "installed" ? undefined : `en to es is ${r.json?.status}` },
      { id: "translate.availability-sample", sub: "availability", args: ctx => ["translate", "availability", "--sample", "Hello world", "--to", ctx.vars.to], flags: ["--sample", "--to"], timeoutMs: 120_000 },
      { id: "translate.prepare", sub: "prepare", args: ctx => ["translate", "prepare", "--from", "en", "--to", ctx.vars.to], flags: ["--from", "--to"], timeoutMs: 120_000, needs: NO_PAIR },
      { id: "translate.text", sub: "text", args: ctx => ["translate", "text", "Hello", "--from", "en", "--to", ctx.vars.to], flags: ["--from", "--to"], timeoutMs: 120_000, needs: NO_PAIR,
        check: (r, ctx) => ctx.vars.to !== "es" || /hola/i.test(String(r.json?.targetText)) ? undefined : `"Hello" in Spanish came back as ${r.json?.targetText}` },
      { id: "translate.batch", sub: "batch", args: ctx => ["translate", "batch", "--json", '["Hello","Goodbye"]', "--from", "en", "--to", ctx.vars.to], flags: ["--json", "--from", "--to"], timeoutMs: 120_000, needs: NO_PAIR, check: r => r.json?.translations?.length === 2 && r.json.translations.every((t: any) => t.ok) ? undefined : `batch gave ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "translate.file", sub: "file", args: ctx => ["translate", "file", file(ctx, "translate", "Hello world"), "--from", "en", "--to", ctx.vars.to], flags: ["--from", "--to"], timeoutMs: 120_000, needs: NO_PAIR, check: contains("targetText") },
      // Given only "de", the local model answered in Dutch; the prompt now names the language.
      { id: "translate.text.german", sub: "text", args: ["translate", "text", "Good morning, my friend.", "--from", "en", "--to", "de"], flags: ["--from", "--to"], timeoutMs: 120_000,
        expect: { darwin: { skip: "the Mac translates only language pairs installed in System Settings" } }, check: r => /guten morgen/i.test(String(r.json?.targetText)) ? undefined : `"Good morning" in German came back as ${r.json?.targetText}` },
      { id: "translate.stop", sub: "stop", args: ["translate", "stop"] },
      // Flags each selector does not accept (shared/desktop-language-validation.ts field lists).
      ...([
        ["status", ALL_TRANSLATE_FLAGS], ["languages", ALL_TRANSLATE_FLAGS], ["stop", ALL_TRANSLATE_FLAGS], ["prepare", ALL_TRANSLATE_FLAGS],
        ["availability", ["--from", "en", "--to", "es", "--json", '["Hello"]']],
        ["text", ["Hello", "--to", "es", "--sample", "Hello", "--json", '["Hello"]']],
        ["batch", ["--to", "es", "--json", '["Hello"]', "--sample", "Hello"]],
        ["file", ["--to", "es", "--sample", "Hello", "--json", '["Hello"]']],
      ] as [string, string[]][]).map(([s, extra]): Case => ({
        id: `translate.${s}.flag-rejected`, sub: s, expect: no, flags: extra.filter(a => a.startsWith("--")),
        args: ctx => ["translate", s, ...(s === "file" ? [join(ctx.dir, "Interceptor Parity translate.txt")] : []), ...extra],
      })),
    ],
    async teardown(ctx) { await ctx.run(["translate", "stop"]) },
  },
  {
    family: "detect",
    setup: needsModel,
    cases: [
      { id: "detect.types", sub: "types", args: ["detect", "types"], check: contains("phoneNumber") },
      { id: "detect.run", sub: "run", args: ["detect", "run", SENTENCE, "--types", "link,phone"], timeoutMs: 120_000, check: contains("example.com") },
      { id: "detect.file", sub: "file", args: ctx => ["detect", "file", file(ctx, "detect", SENTENCE), "--types", "all"], flags: ["--types"], timeoutMs: 120_000, check: contains("example.com") },
      // The runner spawns the CLI with stdin ignored, so stdin is empty and must refuse.
      { id: "detect.stdin-empty", sub: "stdin", args: ["detect", "stdin", "--types", "link"], expect: no },
      { id: "detect.types.flag-rejected", sub: "types", args: ["detect", "types", "--types", "link"], expect: no },
      { id: "detect.run.bad-type", sub: "run", args: ["detect", "run", SENTENCE, "--types", "bogus"], expect: no },
    ],
  },
  {
    family: "sensitive",
    cases: [
      { id: "sensitive.monitor-status", sub: "monitor status", args: ["sensitive", "monitor", "status"], check: contains("monitoring") },
      // Mac: the installed bridge lacks com.apple.developer.sensitivecontentanalysis.client, so
      // SCSensitivityAnalyzer's policy is disabled and analysis refuses (SensitiveDomain.swift:56).
      { id: "sensitive.check-image", sub: "check", args: ctx => ["sensitive", "check", "--image", png(ctx)], flags: ["--image"], expect: { all: refuse(OUT_CODES, LLAMA), darwin: refuse() } },
      { id: "sensitive.check-app", sub: "check", args: ctx => ["sensitive", "check", "--app", app(ctx)], flags: ["--app"], expect: { all: refuse(OUT_CODES, LLAMA), darwin: refuse() } },
      { id: "sensitive.monitor-start", sub: "monitor start", args: ctx => ["sensitive", "monitor", "start", "--app", app(ctx)], flags: ["--app"], expect: { all: refuse(OUT_CODES, LLAMA), darwin: refuse() } },
      { id: "sensitive.monitor-stop", sub: "monitor stop", args: ["sensitive", "monitor", "stop"], check: contains('"monitoring":false') },
      { id: "sensitive.monitor-start.image-rejected", sub: "monitor start", args: ctx => ["sensitive", "monitor", "start", "--image", png(ctx)], flags: ["--image"], expect: no },
      { id: "sensitive.monitor-stop.flag-rejected", sub: "monitor stop", args: ctx => ["sensitive", "monitor", "stop", "--app", app(ctx), "--image", png(ctx)], flags: ["--app", "--image"], expect: no },
      { id: "sensitive.monitor-status.flag-rejected", sub: "monitor status", args: ctx => ["sensitive", "monitor", "status", "--app", app(ctx), "--image", png(ctx)], flags: ["--app", "--image"], expect: no },
    ],
    async teardown(ctx) { await ctx.run(["sensitive", "monitor", "stop"]) },
  },
]

export const mediaExclusions: Exclusion[] = [
  { family: "detect", sub: "stdin", reason: "The runner spawns the CLI with stdin ignored, so piped input cannot be supplied; only the empty-stdin refusal (detect.stdin-empty) is exercised." },
]
