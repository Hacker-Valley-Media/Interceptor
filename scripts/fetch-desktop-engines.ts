#!/usr/bin/env bun
// Downloads the pinned engines and models that ship with Windows/Linux Full installs and writes
// an engine source directory (files + manifest.json) for stage-desktop-engines.ts.
//   bun scripts/fetch-desktop-engines.ts <win32|linux> <x64|arm64> <absolute new output directory>
// PDFium, plus the vision, sound and embedding models the provider runs itself
// (no vendor library), whisper.cpp for Linux `listen`, and the llama.cpp server for the local
// AI model. Every download is checked against the SHA256 pinned here; downloads are kept in
// INTERCEPTOR_ENGINE_CACHE (default .interceptor/toolchain/engine-cache/downloads) by hash.
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, isAbsolute, resolve } from "node:path"
import { version } from "../package.json"

const [host, arch, out] = process.argv.slice(2)
if (!["win32", "linux"].includes(host) || !["x64", "arm64"].includes(arch) || !out || !isAbsolute(out)) throw new Error("usage: fetch-desktop-engines.ts <win32|linux> <x64|arm64> <absolute new output directory>")
if (existsSync(out)) throw new Error("output directory must be new")
const target = `${host}-${arch}` as "win32-x64" | "win32-arm64" | "linux-x64" | "linux-arm64"
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const cache = process.env.INTERCEPTOR_ENGINE_CACHE ?? resolve(import.meta.dir, "..", ".interceptor", "toolchain", "engine-cache", "downloads")
const work = `${out}.download`
await mkdir(cache, { recursive: true }); await mkdir(work, { recursive: true }); await mkdir(out, { recursive: true })

/** One pinned download, served from the cache when its hash is already there. */
async function download(url: string, sha256: string): Promise<Uint8Array> {
  const cached = join(cache, sha256)
  if (existsSync(cached)) { const bytes = new Uint8Array(await readFile(cached)); if (sha(bytes) === sha256) return bytes }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (sha(bytes) !== sha256) throw new Error(`${url} SHA256 ${sha(bytes)} differs from the pinned ${sha256}`)
  await writeFile(cached, bytes)
  return bytes
}
/** Unpack a pinned archive and return its folder. */
async function unpack(url: string, sha256: string): Promise<string> {
  const name = url.split("/").pop()!, folder = join(work, name.replace(/\W+/g, "_"))
  await writeFile(join(work, name), await download(url, sha256)); await mkdir(folder, { recursive: true })
  const commands = name.endsWith(".zip") ? [["unzip", "-oq", join(work, name), "-d", folder], ["tar", "-xf", join(work, name), "-C", folder]] : [["tar", "-xzf", join(work, name), "-C", folder]]
  if (!commands.some(command => Bun.spawnSync(command).exitCode === 0)) throw new Error(`could not extract ${name}`)
  return folder
}

type Meta = { component: string; version: string; source: string; license: string }
type File = Meta & { variable?: string; path: string; kind: string; bytes: number; sha256: string; licensePaths: string[]; dependencies: string[] }
const files: File[] = []
async function add(path: string, bytes: Uint8Array, kind: string, meta: Meta, extra: { variable?: string; licensePaths?: string[]; dependencies?: string[] } = {}) {
  await mkdir(join(out, ...path.split("/").slice(0, -1)), { recursive: true })
  await writeFile(join(out, ...path.split("/")), bytes, { mode: kind === "executable" ? 0o755 : 0o644 })
  files.push({ ...(extra.variable ? { variable: extra.variable } : {}), path, kind, bytes: bytes.length, sha256: sha(bytes), ...meta, licensePaths: extra.licensePaths ?? [], dependencies: extra.dependencies ?? [] })
}
const text = (s: string) => new TextEncoder().encode(s)
const APACHE = { url: "https://www.apache.org/licenses/LICENSE-2.0.txt", sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30" }

// PDFium (pdf).
{
  const TAG = "chromium/7881"
  const pins: Record<string, string> = { // asset -> SHA256 from the GitHub release digest
    "pdfium-linux-arm64.tgz": "ee7f7b7d5468958336a818c1cd580bdd20972846b7377b13f9a923d92d1d4674",
    "pdfium-linux-x64.tgz": "1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d",
    "pdfium-win-arm64.tgz": "d3035d4d2cacac6ecd1a2ece197a3d702a1b2a58466276b9f870b8cb278a9d84",
    "pdfium-win-x64.tgz": "73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08",
  }
  const asset = `pdfium-${host === "win32" ? "win" : "linux"}-${arch}.tgz`
  const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(TAG)}/${asset}`
  const folder = await unpack(url, pins[asset])
  const meta = { component: "pdfium", version: "7881", source: url, license: "BSD-3-Clause AND Apache-2.0" }
  const library = host === "win32" ? "pdfium.dll" : "libpdfium.so"
  await add(`pdfium/${library}`, await readFile(join(folder, host === "win32" ? "bin" : "lib", library)), "library", meta, { variable: "INTERCEPTOR_PDFIUM_LIBRARY", licensePaths: ["pdfium/LICENSE.txt"] })
  await add("pdfium/LICENSE.txt", await readFile(join(folder, "LICENSE")), "license", meta)
}

// Vision models (hands, bodies, classify, saliency): Google's MediaPipe and MobileNet models as
// ONNX from the OpenCV Zoo, and U2-Net-p, all Apache-2.0. The provider runs them on tract; no
// MediaPipe library ships.
{
  const ZOO = "47534e27c9851bb1128ccc0102f1145e27f23f98"
  const lfs = (p: string) => `https://media.githubusercontent.com/media/opencv/opencv_zoo/${ZOO}/models/${p}`, raw = (p: string) => `https://raw.githubusercontent.com/opencv/opencv_zoo/${ZOO}/models/${p}`
  const meta = (source: string): Meta => ({ component: "opencv-zoo", version: ZOO.slice(0, 12), source, license: "Apache-2.0" })
  const licenses = ["vision/LICENSE.txt", "vision/NOTICE.txt"]
  for (const [variable, path, sha256] of [
    ["INTERCEPTOR_VISION_PALM_MODEL", "palm_detection_mediapipe/palm_detection_mediapipe_2023feb.onnx", "78ff51c38496b7fc8b8ebdb6cc8c1abb02fa6c38427c6848254cdaba57fcce7c"],
    ["INTERCEPTOR_VISION_HAND_MODEL", "handpose_estimation_mediapipe/handpose_estimation_mediapipe_2023feb.onnx", "db0898ae717b76b075d9bf563af315b29562e11f8df5027a1ef07b02bef6d81c"],
    ["INTERCEPTOR_VISION_PERSON_MODEL", "person_detection_mediapipe/person_detection_mediapipe_2023mar.onnx", "47fd5599d6fa17608f03e0eb0ae230baa6e597d7e8a2c8199fe00abea55a701f"],
    ["INTERCEPTOR_VISION_POSE_MODEL", "pose_estimation_mediapipe/pose_estimation_mediapipe_2023mar.onnx", "9d89c599319a18fb7d2e28451a883476164543182bafca5f09eb2cf767ed2f3f"],
    ["INTERCEPTOR_VISION_CLASSIFY_MODEL", "image_classification_mobilenet/image_classification_mobilenetv2_2022apr.onnx", "c0c3f76d93fa3fd6580652a45618618a220fced18babf65774ed169de0432ad5"],
  ]) await add(`vision/${path.split("/")[1]}`, await download(lfs(path), sha256), "model", meta(lfs(path)), { variable, licensePaths: licenses })
  // Saliency: U2-Net-p (Qin et al., Apache-2.0), the ONNX file published with rembg.
  const u2net = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
  await add("vision/u2netp.onnx", await download(u2net, "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"), "model", { component: "u2net", version: "u2netp", source: u2net, license: "Apache-2.0" }, { variable: "INTERCEPTOR_VISION_SALIENCY_MODEL", licensePaths: licenses })
  // The class names live in the Zoo's reference script; the bundle carries them as a JSON array.
  const script = new TextDecoder().decode(await download(raw("image_classification_mobilenet/mobilenet.py"), "8baaadee63e6deabb5b1063c8338092f1cdf79f6a8377d614dbb47751ce7b55c"))
  const labels = script.match(/LABELS_IMAGENET_1K = '''([\s\S]*?)'''/)![1].split("\n")
  if (labels.length !== 1000) throw new Error("ImageNet label list is not 1000 names")
  await add("vision/imagenet-labels.json", text(JSON.stringify(labels)), "data", meta(raw("image_classification_mobilenet/mobilenet.py")), { variable: "INTERCEPTOR_VISION_CLASSIFY_LABELS", licensePaths: licenses })
  await add("vision/LICENSE.txt", await download(raw("palm_detection_mediapipe/LICENSE"), APACHE.sha256), "license", meta(raw("palm_detection_mediapipe/LICENSE")))
  await add("vision/NOTICE.txt", text(`Hand, pose and image-classification models from the OpenCV Zoo (https://github.com/opencv/opencv_zoo, commit ${ZOO}), Apache License 2.0.\nThe palm, hand, person and pose models are ONNX conversions of Google MediaPipe models (Apache License 2.0).\nThe image classifier is MobileNetV2 trained on ImageNet-1k.\nThe saliency model is U2-Net-p (Qin et al., https://github.com/xuebinqin/U-2-Net, Apache License 2.0), as the ONNX file published at https://github.com/danielgatis/rembg/releases/tag/v0.0.0.\nInterceptor runs these files unmodified inside its own process.\n`), "license", meta(`https://github.com/opencv/opencv_zoo/tree/${ZOO}/models`))
}

// Sound classifier: CED-tiny (527 AudioSet classes). Weights are published by their authors
// under Apache-2.0 (https://huggingface.co/mispeech/ced-tiny); this is the sherpa-onnx export.
{
  const REVISION = "efe3a5cfad74e56598d855d055006903adc00e38", base = `https://huggingface.co/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/resolve/${REVISION}`
  const meta = (source: string): Meta => ({ component: "ced-tiny", version: "2024-04-19", source, license: "Apache-2.0" })
  const licenses = ["sounds/LICENSE.txt", "sounds/NOTICE.txt"]
  await add("sounds/ced-tiny.int8.onnx", await download(`${base}/model.int8.onnx`, "73aa22e783115f6a4ae169b36089907e07d0fd44795595eddea9c1bfc74cc945"), "model", meta(`${base}/model.int8.onnx`), { variable: "INTERCEPTOR_SOUND_MODEL", licensePaths: licenses })
  const csv = new TextDecoder().decode(await download(`${base}/class_labels_indices.csv`, "cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429"))
  const labels = csv.trim().split("\n").slice(1).map(line => { const m = line.match(/^\d+,[^,]+,(?:"(.*)"|(.*))$/)!; return (m[1] ?? m[2]).replace(/""/g, '"') })
  if (labels.length !== 527) throw new Error("AudioSet label list is not 527 names")
  await add("sounds/audioset-labels.json", text(JSON.stringify(labels)), "data", meta(`${base}/class_labels_indices.csv`), { variable: "INTERCEPTOR_SOUND_LABELS", licensePaths: licenses })
  await add("sounds/LICENSE.txt", await download(APACHE.url, APACHE.sha256), "license", meta(APACHE.url))
  await add("sounds/NOTICE.txt", text(`CED-tiny audio tagging model (Dinkel et al., "CED: Consistent Ensemble Distillation for Audio Tagging").\nThe authors publish the weights under the Apache License 2.0 at https://huggingface.co/mispeech/ced-tiny.\nThis file is the ONNX export distributed by sherpa-onnx (https://github.com/k2-fsa/sherpa-onnx, Apache License 2.0), revision ${REVISION}.\nClass names are the AudioSet ontology labels.\nInterceptor runs the model unmodified inside its own process.\n`), "license", meta("https://huggingface.co/mispeech/ced-tiny"))
}

// Text embeddings: all-MiniLM-L6-v2 (Apache-2.0), the 8-bit ONNX file its authors publish.
{
  const REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41", base = `https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/${REVISION}`
  const meta = (source: string): Meta => ({ component: "all-MiniLM-L6-v2", version: REVISION.slice(0, 12), source, license: "Apache-2.0" })
  const licenses = ["embed/LICENSE.txt", "embed/NOTICE.txt"]
  await add("embed/all-MiniLM-L6-v2.onnx", await download(`${base}/onnx/model_quint8_avx2.onnx`, "b941bf19f1f1283680f449fa6a7336bb5600bdcd5f84d10ddc5cd72218a0fd21"), "model", meta(`${base}/onnx/model_quint8_avx2.onnx`), { variable: "INTERCEPTOR_EMBED_MODEL", licensePaths: licenses })
  await add("embed/vocab.txt", await download(`${base}/vocab.txt`, "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3"), "data", meta(`${base}/vocab.txt`), { variable: "INTERCEPTOR_EMBED_VOCAB", licensePaths: licenses })
  await add("embed/LICENSE.txt", await download(APACHE.url, APACHE.sha256), "license", meta(APACHE.url))
  await add("embed/NOTICE.txt", text(`all-MiniLM-L6-v2 sentence embedding model, sentence-transformers (https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), Apache License 2.0, revision ${REVISION}.\nInterceptor runs onnx/model_quint8_avx2.onnx unmodified inside its own process.\n`), "license", meta(`https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/tree/${REVISION}`))
}

/** Add an unpacked program and the shared libraries beside it; symlinked names resolve to their file. */
async function program(folder: string, into: string, variable: string, executable: string, libraries: string[], meta: Meta, licensePaths: string[]) {
  const dependencies: string[] = []
  for (const name of libraries) { await add(`${into}/${name}`, await readFile(realpathSync(join(folder, name))), "library", meta, { licensePaths }); dependencies.push(`${into}/${name}`) }
  await add(`${into}/${executable}`, await readFile(join(folder, executable)), "executable", meta, { variable, licensePaths, dependencies })
}
const backends = (folder: string) => readdirSync(folder).filter(name => /^(lib)?ggml-cpu.*\.(so|dll)$/.test(name)).sort()

// whisper.cpp 1.9.5 for Linux `listen` (Windows uses the recognizer it ships), MIT.
if (host === "linux") {
  const BUILD = "b5454", url = `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD}/whisper-bin-ubuntu-${arch}.tar.gz`
  const folder = join(await unpack(url, { arm64: "6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149", x64: "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c" }[arch]!), `whisper-bin-ubuntu-${arch}`)
  const meta: Meta = { component: "whisper.cpp", version: "1.9.5", source: url, license: "MIT" }
  await program(folder, "whisper", "INTERCEPTOR_WHISPER_CLI", "whisper-cli", ["libwhisper.so.1", "libggml.so.0", "libggml-base.so.0", ...backends(folder)], meta, ["whisper/LICENSE.txt"])
  await add("whisper/LICENSE.txt", await readFile(join(folder, "LICENSE")), "license", meta)
  const MODELS = "5359861c739e955e79d9a303bcbc70fb988958b1", model = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODELS}/ggml-tiny-q5_1.bin`
  const weights: Meta = { component: "whisper-tiny", version: MODELS.slice(0, 12), source: model, license: "MIT" }
  await add("whisper/ggml-tiny-q5_1.bin", await download(model, "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7"), "model", weights, { variable: "INTERCEPTOR_WHISPER_MODEL", licensePaths: ["whisper/LICENSE-model.txt"] })
  const license = "https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE"
  await add("whisper/LICENSE-model.txt", await download(license, "b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d"), "license", { ...weights, source: license })
}

// llama.cpp server for the local AI model, MIT. The model itself is not bundled:
// the provider downloads it on first use (interceptor-desktop/src/local_ai.rs).
{
  const BUILD = "b11557", asset = { "linux-arm64": "bin-ubuntu-arm64.tar.gz", "linux-x64": "bin-ubuntu-x64.tar.gz", "win32-arm64": "bin-win-cpu-arm64.zip", "win32-x64": "bin-win-cpu-x64.zip" }[target]
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/llama-${BUILD}-${asset}`
  const unpacked = await unpack(url, { "linux-arm64": "8b1bb544b523a9774807f83bf8ba580d375d71600644cd03a8e44a733f6865bd", "linux-x64": "421fef77e12d5a97202ed838d5f6a509c76737dcd8fa7a5afed7688d05a699c0", "win32-arm64": "1cf166deac86daf034d740768837a0ccaf3a772273a4e1eb0ff5aebe12e99c43", "win32-x64": "bcfca9c8198899d4268e4e6b586113905280dec372a82c7106ebe78bc0eacb5b" }[target])
  const folder = host === "linux" ? join(unpacked, `llama-${BUILD}`) : unpacked
  const meta: Meta = { component: "llama.cpp", version: BUILD, source: url, license: "MIT" }
  const license = "https://raw.githubusercontent.com/ggml-org/llama.cpp/5c8854fd88319125125dc4b836c98b1b215b0f23/LICENSE"
  if (host === "linux") {
    await program(folder, "llama", "INTERCEPTOR_LLAMA_SERVER", "llama-server", ["libllama-server-impl.so", "libllama-common.so.0", "libllama.so.0", "libmtmd.so.0", "libggml.so.0", "libggml-base.so.0", ...backends(folder)], meta, ["llama/LICENSE.txt"])
  } else {
    await program(folder, "llama", "INTERCEPTOR_LLAMA_SERVER", "llama-server.exe", ["llama-server-impl.dll", "llama-common.dll", "llama.dll", "mtmd.dll", "ggml.dll", "ggml-base.dll", "libomp.dll", ...backends(folder)], meta, ["llama/LICENSE.txt", "llama/LICENSE-LLVM-OpenMP.txt"])
    await add("llama/LICENSE-LLVM-OpenMP.txt", await readFile(join(folder, "LICENSE-LLVM-OpenMP")), "license", { ...meta, component: "llvm-openmp", license: "Apache-2.0 WITH LLVM-exception" })
  }
  await add("llama/LICENSE.txt", await download(license, "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d"), "license", { ...meta, source: license })
}

await writeFile(join(out, "manifest.json"), JSON.stringify({ schemaVersion: 1, host, architecture: arch, providerVersion: version, files }, null, 2) + "\n")
Bun.spawnSync(["rm", "-rf", work])
console.log(JSON.stringify({ out, host, arch, files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0), components: [...new Set(files.map(f => f.component))] }))
