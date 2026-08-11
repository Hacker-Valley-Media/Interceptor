#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const VERSION = /^\d+\.\d+\.\d+$/
const SHA256 = /^[0-9a-f]{64}$/i
const PACKAGE_ID = "HackerValleyMedia.Interceptor"

type Options = {
  version: string
  baseUrl: string
  x64Sha256: string
  arm64Sha256: string
  output: string
}

function value(args: string[], name: string): string {
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1]
  const joined = args.find(arg => arg.startsWith(`${name}=`))
  if (joined) return joined.slice(name.length + 1)
  throw new Error(`${name} is required`)
}

export function parseOptions(args: string[]): Options {
  const options = {
    version: value(args, "--version"),
    baseUrl: value(args, "--base-url").replace(/\/$/, ""),
    x64Sha256: value(args, "--x64-sha256").toUpperCase(),
    arm64Sha256: value(args, "--arm64-sha256").toUpperCase(),
    output: resolve(value(args, "--output")),
  }
  if (!VERSION.test(options.version)) throw new Error("--version must be stable X.Y.Z")
  const url = new URL(options.baseUrl)
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("--base-url must be an immutable HTTPS GitHub release URL")
  if (!url.pathname.endsWith(`/releases/download/v${options.version}`)) throw new Error("--base-url tag must match --version")
  if (!SHA256.test(options.x64Sha256) || !SHA256.test(options.arm64Sha256)) throw new Error("installer hashes must be SHA-256 hex")
  return options
}

export function renderManifests(options: Options): Record<string, string> {
  // winget validate warns (and exits non-zero) without these schema headers.
  const schema = (type: string) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.12.0.schema.json\n`
  const versionHeader = `PackageIdentifier: ${PACKAGE_ID}\nPackageVersion: ${options.version}`
  const x64Name = `Interceptor-Browser-${options.version}-windows-x64.exe`
  const arm64Name = `Interceptor-Browser-${options.version}-windows-arm64.exe`
  return {
    [`${PACKAGE_ID}.yaml`]: `${schema("version")}${versionHeader}\nDefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.12.0\n`,
    [`${PACKAGE_ID}.installer.yaml`]: `${schema("installer")}${versionHeader}\nInstallerType: inno\nScope: user\nMinimumOSVersion: 10.0.26100.0\nInstallModes:\n  - interactive\n  - silent\n  - silentWithProgress\nInstallerSwitches:\n  Silent: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\n  SilentWithProgress: /SILENT /SUPPRESSMSGBOXES /NORESTART\n  Log: /LOG=\"<LOGPATH>\"\n  Upgrade: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\n  Repair: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\nUpgradeBehavior: install\nRepairBehavior: installer\nCommands:\n  - interceptor\nAppsAndFeaturesEntries:\n  - DisplayName: Interceptor (Browser-Only)\n    DisplayVersion: ${options.version}\n    Publisher: Hacker Valley Media\nInstallers:\n  - Architecture: x64\n    InstallerUrl: ${options.baseUrl}/${x64Name}\n    InstallerSha256: ${options.x64Sha256}\n  - Architecture: arm64\n    InstallerUrl: ${options.baseUrl}/${arm64Name}\n    InstallerSha256: ${options.arm64Sha256}\nManifestType: installer\nManifestVersion: 1.12.0\n`,
    [`${PACKAGE_ID}.locale.en-US.yaml`]: `${schema("defaultLocale")}${versionHeader}\nPackageLocale: en-US\nPublisher: Hacker Valley Media\nPublisherUrl: https://hackervalley.com\nPublisherSupportUrl: https://github.com/Hacker-Valley-Media/Interceptor/issues\nPackageName: Interceptor\nPackageUrl: https://github.com/Hacker-Valley-Media/Interceptor\nLicense: Elastic License 2.0\nLicenseUrl: https://github.com/Hacker-Valley-Media/Interceptor/blob/v${options.version}/LICENSE\nShortDescription: Browser automation and inspection CLI for signed-in browser sessions.\nManifestType: defaultLocale\nManifestVersion: 1.12.0\n`,
  }
}

export function run(args: string[]): void {
  const options = parseOptions(args)
  const directory = resolve(options.output, PACKAGE_ID, options.version)
  mkdirSync(directory, { recursive: true })
  for (const [name, body] of Object.entries(renderManifests(options))) {
    writeFileSync(resolve(directory, name), body, { encoding: "utf-8", mode: 0o644 })
  }
}

if (import.meta.main) {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${(error as Error).message}`)
    process.exit(1)
  }
}
