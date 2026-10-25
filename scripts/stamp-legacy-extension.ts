// Turns a copy of extension/dist into extension-legacy/: the same extension
// under the development key it carried through 0.24.13 (ID hkjb…). Browser
// profiles that loaded that old copy keep an entry for its ID;
// `interceptor diagnose extension --fix` moves that entry onto this folder
// (see cli/lib/extension-repair.ts). Usage: bun scripts/stamp-legacy-extension.ts <manifest.json>
import { readFileSync, writeFileSync } from "node:fs"
import { LEGACY_DEVELOPMENT_EXTENSION_ID, LEGACY_DEVELOPMENT_PUBLIC_KEY } from "../shared/extension-identity"
import { deriveChromiumExtensionId } from "./installer/generate-native-host"

const file = process.argv[2]
if (!file) throw new Error("usage: bun scripts/stamp-legacy-extension.ts <manifest.json>")
const manifest = JSON.parse(readFileSync(file, "utf8"))
manifest.key = LEGACY_DEVELOPMENT_PUBLIC_KEY
manifest.name = "Interceptor (old ID)"
const id = deriveChromiumExtensionId(manifest.key)
if (id !== LEGACY_DEVELOPMENT_EXTENSION_ID) throw new Error(`legacy key derives ${id}, expected ${LEGACY_DEVELOPMENT_EXTENSION_ID}`)
writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
console.log(`stamped ${file} with the old development key (${id})`)
