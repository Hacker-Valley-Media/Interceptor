import { readFileSync } from "node:fs"
import { join } from "node:path"

// Check the JavaScript that ships, including dependency code after bundling.
export function checkExtensionCode(root: string): void {
  const files = Array.from(new Bun.Glob("**/*.{js,mjs,cjs}").scanSync({ cwd: root, onlyFiles: true }))
    .map(file => file.replaceAll("\\", "/")).sort()
  const worker = "tesseract/worker.min.js"
  const problems: string[] = []
  for (const required of ["offscreen.js", worker]) {
    if (!files.includes(required)) problems.push("missing " + required)
  }
  const forbidden = [
    /cdn\.jsdelivr\.net/i,
    /(?:\bhttps?:|["'`])\/\/[^\s"'`<>]*\.(?:[cm]?js|wasm)(?=[?#\s"'`)]|$)/i,
    /\b(?:Worker|import|importScripts)\s*\(\s*["'`](?:https?:)?\/\//i,
    /\b(?:eval|Function)\s*\(/,
  ]
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8")
    if ((file === worker || file === "offscreen.js") && /\bhttps?:\/\//i.test(source)) {
      problems.push(file + " contains an external URL in the offline OCR bundle")
    }
    for (const pattern of forbidden) {
      const match = source.match(pattern)
      if (match) problems.push(file + " contains " + match[0])
    }
    // The worker selects a sibling WASM loader by SIMD and model variant.
    const localCore = /\bimportScripts\s*\(\s*`\.\/tesseract-core(?:[-\w]|\$\{[\w$]+\})*\.wasm\.js`\s*\)/
    if (file === worker && !localCore.test(source)) problems.push(file + " is missing its local core import")
    const otherCode = file === worker ? source.replace(localCore, "") : source
    if (/\bimportScripts\s*\(/.test(otherCode)) problems.push(file + " contains an unexpected importScripts call")
  }
  if (problems.length) throw new Error(problems.join("\n"))
}

if (import.meta.main) checkExtensionCode(process.argv[2])
