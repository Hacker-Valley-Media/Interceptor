import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  deriveChromiumExtensionId,
  makeNativeHostManifest,
  parseStoreIdentities,
  validateStoreIdentities,
} from "../scripts/installer/generate-native-host"
import { parseOptions, renderManifests } from "../scripts/release/generate-winget"

const root = resolve(import.meta.dir, "..")
const read = (path: string) => readFileSync(resolve(root, path), "utf-8")

describe("Windows production release contract", () => {
  test("uses one stable version and pinned toolchain", () => {
    const pkg = JSON.parse(read("package.json"))
    const extension = JSON.parse(read("extension/manifest.json"))
    const lock = JSON.parse(read("scripts/installer/windows-toolchain.lock.json"))
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(extension.version).toBe(pkg.version)
    expect(read(".bun-version").trim()).toBe("1.3.14")
    expect(lock.bun.version).toBe("1.3.14")
    expect(lock.runner.label).toBe("windows-2025")
    expect(lock.runner.imageOS).toBe("win25-vs2026")
    expect(lock.innoSetup.version).toBe("7.0.2")
    expect(lock.innoSetup.commercialLicenseEvidenceRequired).toBe(true)
    for (const sha of Object.values(lock.actions) as string[]) expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test("derives the development identity and blocks unapproved production identities", () => {
    const identities = parseStoreIdentities(JSON.parse(read("extension/store-identities.json")))
    const extension = JSON.parse(read("extension/manifest.json"))
    expect(deriveChromiumExtensionId(identities.chrome.publicKey)).toBe("hkjbaciefhhgekldhncknbjkofbpenng")
    validateStoreIdentities(identities, { production: false, extensionManifestKey: extension.key })
    expect(() => validateStoreIdentities(identities, { production: true, extensionManifestKey: extension.key })).toThrow("not approved")
    expect(makeNativeHostManifest(identities, false)).toEqual({
      name: "com.interceptor.host",
      description: "Interceptor daemon bridge",
      path: "interceptor-daemon.exe",
      type: "stdio",
      allowed_origins: ["chrome-extension://hkjbaciefhhgekldhncknbjkofbpenng/"],
    })
  })

  test("keeps the installer per-user, native, passive, and ownership-safe", () => {
    const source = read("scripts/installer/interceptor.iss")
    for (const required of [
      "AppId={{{#ProductGuid}}",
      "DefaultDirName={userpf}\\Interceptor",
      "PrivilegesRequired=lowest",
      "MinVersion=10.0.26100",
      "SetupArchitecture=x64",
      "CloseApplications=no",
      "RestartApplications=no",
      "UninstallLogMode=overwrite",
      "OutputBaseFilename=Interceptor-Browser-{#AppVersion}-windows-{#ArtifactArch}{#ArtifactSuffix}",
      "ShutdownProtocolVersion",
      "interceptor.installing",
      "PathOriginalType",
      "CaptureHost",
      "RestorePending",
      "CommitState",
      "StopPriorDaemon",
    ]) expect(source).toContain(required)
    for (const forbidden of [
      "PrivilegesRequiredOverridesAllowed",
      "WOW6432Node",
      "uninsdeletekey",
      "uninsdeletevalue",
      "taskkill",
      "extension\\dist",
      "skills adopt --all",
      "RenderNativeMessagingManifest",
      "RestartManager",
    ]) expect(source).not.toContain(forbidden)
    expect(source.match(/NativeMessagingHosts\\com\.interceptor\.host/g)?.length).toBeGreaterThanOrEqual(3)
    expect(source.split("\n").length).toBeLessThan(900)
  })

  test("builds only explicit architecture-separated Windows payloads", () => {
    const build = read("scripts/build.sh")
    expect(build).toContain('bun_target="bun-windows-x64-baseline"')
    expect(build).toContain('bun_target="bun-windows-arm64"')
    expect(build).toContain('stage="dist/windows/$arch"')
    expect(build).toContain("--target=windows-x64")
    expect(build).toContain("--target=windows-arm64")
    expect(build).toContain("Unsupported target: windows")
  })

  test("pins release inputs and forbids mutable publication", () => {
    const workflow = read(".github/workflows/windows-installer.yml")
    const lock = JSON.parse(read("scripts/installer/windows-toolchain.lock.json"))
    expect(workflow).toContain("runs-on: windows-2025")
    expect(workflow).toContain("persist-credentials: false")
    expect(workflow).toContain("environment: windows-signing")
    expect(workflow).toContain("environment: windows-release")
    expect(workflow).toContain("attestations: write")
    expect(workflow).toContain("artifact-metadata: write")
    expect(workflow).toContain("INNO_SETUP_LICENSE_ACKNOWLEDGED")
    expect(workflow).toContain("gh attestation verify")
    expect(workflow).toContain("Get-AuthenticodeSignature")
    for (const sha of Object.values(lock.actions) as string[]) expect(workflow).toContain(sha)
    for (const forbidden of ["windows-latest", "bun-version: latest", "version_override", "--clobber", "WINDOWS_PFX"]) {
      expect(workflow).not.toContain(forbidden)
    }
  })

  test("generates WinGet 1.12 manifests for both immutable installers", () => {
    const options = parseOptions([
      "--version", "1.2.3",
      "--base-url", "https://github.com/Hacker-Valley-Media/Interceptor/releases/download/v1.2.3",
      "--x64-sha256", "a".repeat(64),
      "--arm64-sha256", "b".repeat(64),
      "--output", resolve(root, "dist/release/winget"),
    ])
    const manifests = renderManifests(options)
    const installer = manifests["HackerValleyMedia.Interceptor.installer.yaml"]
    expect(installer).toContain("ManifestVersion: 1.12.0")
    expect(installer).toContain("InstallerType: inno")
    expect(installer).toContain("Scope: user")
    expect(installer).toContain("MinimumOSVersion: 10.0.26100.0")
    expect(installer).toContain("Architecture: x64")
    expect(installer).toContain("Architecture: arm64")
    expect(installer).toContain("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART")
    expect(installer).toContain("Interceptor-Browser-1.2.3-windows-arm64.exe")
  })

  test("ships the extension on disk for Load unpacked without auto-loading it", () => {
    const postInstall = read("scripts/installer/post-install.txt")
    const docs = read("docs/windows-install.md")
    const iss = read("scripts/installer/interceptor.iss")
    // The unpacked extension is staged on disk at {app}\extension, and both the
    // installer copy and the uninstaller cleanup are declared.
    expect(iss).toContain('Source: "{#StageDir}\\extension\\*"; DestDir: "{app}\\extension"')
    expect(iss).toMatch(/\[UninstallDelete\][\s\S]*Type: filesandordirs; Name: "\{app\}\\extension"/)
    expect(read("scripts/build.sh")).toContain('cp -R extension/dist "$stage/extension"')
    // Docs/post-install point users at that on-disk folder for Load unpacked.
    expect(postInstall).toContain("%LOCALAPPDATA%\\Programs\\Interceptor\\extension")
    expect(docs).toContain("%LOCALAPPDATA%\\Programs\\Interceptor\\extension")
    expect(docs).toContain("Chrome Web Store")
    expect(docs).toContain("Microsoft Edge Add-ons")
    expect(docs).toContain("one active interactive user")
    // Staging files is not loading them: Setup must never load the extension or
    // change a browser profile on the user's behalf.
    expect(postInstall).toMatch(/does not change browser[\s\S]*profiles/)
    expect(postInstall).toMatch(/never (linked|loads?)|without your consent|without consent/i)
  })
})
