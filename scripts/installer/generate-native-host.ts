#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const EXTENSION_ID = /^[a-p]{32}$/
const APPROVAL_DATE = /^\d{4}-\d{2}-\d{2}$/

export type StoreApprovalStatus = "pending" | "approved" | "rejected"

export type StoreIdentity = {
  storeId: string
  listingUrl: string
  approvalStatus: StoreApprovalStatus
  approvalDate: string | null
}

export type StoreIdentities = {
  schemaVersion: 1
  brand: "Interceptor"
  chrome: StoreIdentity & { publicKey: string }
  edge: StoreIdentity
}

export type NativeHostManifest = {
  name: "com.interceptor.host"
  description: "Interceptor daemon bridge"
  path: "interceptor-daemon.exe"
  type: "stdio"
  allowed_origins: string[]
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`)
  }
}

function parseStatus(value: unknown, label: string): StoreApprovalStatus {
  if (value !== "pending" && value !== "approved" && value !== "rejected") {
    throw new Error(`${label} must be pending, approved, or rejected`)
  }
  return value
}

function parseApprovalDate(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== "string" || !APPROVAL_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be null or an ISO calendar date`)
  }
  return value
}

function parseStoreIdentity(value: unknown, label: string, includePublicKey: boolean): StoreIdentity & { publicKey?: string } {
  assertRecord(value, label)
  const keys = ["storeId", "listingUrl", "approvalStatus", "approvalDate"]
  if (includePublicKey) keys.push("publicKey")
  assertExactKeys(value, keys, label)

  const storeId = value.storeId
  const listingUrl = value.listingUrl
  if (typeof storeId !== "string" || typeof listingUrl !== "string") {
    throw new Error(`${label}.storeId and ${label}.listingUrl must be strings`)
  }

  const parsed: StoreIdentity & { publicKey?: string } = {
    storeId,
    listingUrl,
    approvalStatus: parseStatus(value.approvalStatus, `${label}.approvalStatus`),
    approvalDate: parseApprovalDate(value.approvalDate, `${label}.approvalDate`),
  }

  if (includePublicKey) {
    if (typeof value.publicKey !== "string" || value.publicKey.length === 0) {
      throw new Error(`${label}.publicKey must be a nonempty base64 string`)
    }
    parsed.publicKey = value.publicKey
  }
  return parsed
}

export function parseStoreIdentities(value: unknown): StoreIdentities {
  assertRecord(value, "store identities")
  assertExactKeys(value, ["schemaVersion", "brand", "chrome", "edge"], "store identities")
  if (value.schemaVersion !== 1) throw new Error("store identities schemaVersion must be 1")
  if (value.brand !== "Interceptor") throw new Error("store identities brand must be Interceptor")

  const chrome = parseStoreIdentity(value.chrome, "chrome", true)
  const edge = parseStoreIdentity(value.edge, "edge", false)
  return {
    schemaVersion: 1,
    brand: "Interceptor",
    chrome: { ...chrome, publicKey: chrome.publicKey! },
    edge,
  }
}

export function deriveChromiumExtensionId(publicKeyBase64: string): string {
  let der: Buffer
  try {
    der = Buffer.from(publicKeyBase64, "base64")
  } catch {
    throw new Error("chrome.publicKey is not valid base64")
  }
  if (der.length < 32 || der.toString("base64").replace(/=+$/, "") !== publicKeyBase64.replace(/\s+/g, "").replace(/=+$/, "")) {
    throw new Error("chrome.publicKey is not canonical base64 DER")
  }
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32)
  return [...hex].map(char => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(char, 16))).join("")
}

function validateListingUrl(raw: string, hostname: string, storeId: string, label: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label}.listingUrl must be an absolute HTTPS URL`)
  }
  if (url.protocol !== "https:" || url.hostname !== hostname || !url.pathname.endsWith(`/${storeId}`)) {
    throw new Error(`${label}.listingUrl must use ${hostname} and end with /${storeId}`)
  }
}

export function validateStoreIdentities(
  identities: StoreIdentities,
  options: { production: boolean; extensionManifestKey?: string } = { production: true },
): void {
  const derivedChromeId = deriveChromiumExtensionId(identities.chrome.publicKey)
  if (identities.chrome.storeId && !EXTENSION_ID.test(identities.chrome.storeId)) {
    throw new Error("chrome.storeId must be 32 lowercase a-p characters")
  }
  if (identities.chrome.storeId !== derivedChromeId) {
    throw new Error(`chrome.storeId ${identities.chrome.storeId || "<blank>"} does not match public-key-derived ID ${derivedChromeId}`)
  }
  if (options.extensionManifestKey !== undefined && options.extensionManifestKey !== identities.chrome.publicKey) {
    throw new Error("extension/manifest.json#key does not match chrome.publicKey")
  }

  if (identities.edge.storeId && !EXTENSION_ID.test(identities.edge.storeId)) {
    throw new Error("edge.storeId must be 32 lowercase a-p characters")
  }
  if (identities.edge.storeId && identities.edge.storeId === identities.chrome.storeId) {
    throw new Error("Chrome and Edge store IDs unexpectedly duplicate each other")
  }

  if (!options.production) return

  for (const [label, identity] of [["chrome", identities.chrome], ["edge", identities.edge]] as const) {
    if (!EXTENSION_ID.test(identity.storeId)) throw new Error(`${label}.storeId is not production-ready`)
    if (identity.approvalStatus !== "approved" || !identity.approvalDate) {
      throw new Error(`${label} store identity is not approved`)
    }
  }
  validateListingUrl(identities.chrome.listingUrl, "chromewebstore.google.com", identities.chrome.storeId, "chrome")
  validateListingUrl(identities.edge.listingUrl, "microsoftedge.microsoft.com", identities.edge.storeId, "edge")
}

export function makeNativeHostManifest(identities: StoreIdentities, production = true): NativeHostManifest {
  validateStoreIdentities(identities, { production })
  const ids = production
    ? [identities.chrome.storeId, identities.edge.storeId]
    : [identities.chrome.storeId, identities.edge.storeId].filter(id => EXTENSION_ID.test(id))
  const allowedOrigins = [...new Set(ids.map(id => `chrome-extension://${id}/`))].sort()
  if (allowedOrigins.length === 0) throw new Error("no valid extension identity is available")
  return {
    name: "com.interceptor.host",
    description: "Interceptor daemon bridge",
    path: "interceptor-daemon.exe",
    type: "stdio",
    allowed_origins: allowedOrigins,
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch (error) {
    throw new Error(`cannot read JSON ${path}: ${(error as Error).message}`)
  }
}

function flagValue(args: string[], name: string, fallback: string): string {
  const exact = args.indexOf(name)
  if (exact >= 0) {
    const value = args[exact + 1]
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
    return value
  }
  const prefix = `${name}=`
  const joined = args.find(arg => arg.startsWith(prefix))
  return joined ? joined.slice(prefix.length) : fallback
}

export function runGenerator(args: string[]): void {
  const repoRoot = resolve(import.meta.dir, "../..")
  const input = resolve(flagValue(args, "--input", resolve(repoRoot, "extension/store-identities.json")))
  const extensionManifestPath = resolve(flagValue(args, "--extension-manifest", resolve(repoRoot, "extension/manifest.json")))
  const outputArg = flagValue(args, "--output", "-")
  const production = !args.includes("--development")

  const identities = parseStoreIdentities(readJson(input))
  const extensionManifest = readJson(extensionManifestPath)
  assertRecord(extensionManifest, "extension manifest")
  if (typeof extensionManifest.key !== "string") throw new Error("extension manifest key is missing")
  validateStoreIdentities(identities, { production, extensionManifestKey: extensionManifest.key })
  const manifest = makeNativeHostManifest(identities, production)
  const rendered = `${JSON.stringify(manifest, null, 2)}\n`

  if (outputArg === "-") process.stdout.write(rendered)
  else writeFileSync(resolve(outputArg), rendered, { encoding: "utf-8", mode: 0o644 })
}

if (import.meta.main) {
  try {
    runGenerator(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${(error as Error).message}`)
    process.exit(1)
  }
}
