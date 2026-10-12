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
import { captureShell } from "./helpers/shell-capture"

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
    // Cross-compile target seeds must track the pinned Bun version exactly —
    // bumping .bun-version forces a lock refresh here.
    expect(lock.bunCompileTargets).toHaveLength(2)
    for (const target of lock.bunCompileTargets) {
      expect(target.seedFile.endsWith(`-v${lock.bun.version}`)).toBe(true)
      expect(target.url).toStartWith("https://registry.npmjs.org/@oven/bun-windows-")
      expect(target.url).toContain(`-${lock.bun.version}.tgz`)
      expect(target.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(lock.innoSetup.version).toBe("7.0.2")
    expect(lock.innoSetup.commercialLicenseEvidenceRequired).toBe(true)
    for (const sha of Object.values(lock.actions) as string[]) expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test("derives the approved Chrome Web Store identity and renders it in production", () => {
    const identities = parseStoreIdentities(JSON.parse(read("extension/store-identities.json")))
    const extension = JSON.parse(read("extension/manifest.json"))
    expect(deriveChromiumExtensionId(identities.chrome.publicKey)).toBe("gomcpnagjjlhehnkoobkjgnkbleiooed")
    validateStoreIdentities(identities, { production: false, extensionManifestKey: extension.key })
    validateStoreIdentities(identities, { production: true, extensionManifestKey: extension.key })
    expect(makeNativeHostManifest(identities, true)).toEqual({
      name: "com.interceptor.host",
      description: "Interceptor daemon bridge",
      path: "interceptor-daemon.exe",
      type: "stdio",
      allowed_origins: ["chrome-extension://gomcpnagjjlhehnkoobkjgnkbleiooed/"],
    })
  })

  test("keeps the installer per-user, native, passive, and ownership-safe", () => {
    const source = read("scripts/installer/interceptor.iss")
    const ownership = read("scripts/installer/desktop-ownership.iss")
    expect(source).toContain('#include "desktop-ownership.iss"')
    for (const name of ["DesktopStartupOwned", "EnginePayloadValid", "EngineBundleOwned", "RecordEngineBundle", "StopPriorDesktop"]) {
      expect(ownership.match(new RegExp(`function ${name}\\(`, "g"))).toHaveLength(1)
      expect(source).not.toContain(`function ${name}(`)
    }
    expect(ownership).toContain("GetSHA256OfFile(Manifest)")
    expect(ownership).toContain("GetSHA256OfFile(Provider)")
    expect(ownership).toContain("EnginePayloadValid(Root)")
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
    const toastRegistration = String.raw`Root: HKCU; Subkey: "Software\Classes\CLSID\{{{#NotificationActivator}}\LocalServer32"; ValueType: string; ValueName: ""; ValueData: """{app}\interceptor-desktop.exe"" --toast-activated"; Flags: uninsdeletevalue uninsdeletekeyifempty`
    const registrations = source.match(/^Root:.*$/gm) ?? []
    expect(registrations).toEqual([toastRegistration])
    const otherRegistryFlags = source.replace(toastRegistration, "")
    expect(otherRegistryFlags).not.toContain("uninsdeletekey")
    expect(otherRegistryFlags).not.toContain("uninsdeletevalue")
    const uninstall = source.slice(source.indexOf("function UninstallOwnedState"), source.indexOf("procedure CurUninstallStepChanged"))
    expect(uninstall.indexOf("if not DesktopStartupOwned(Root)")).toBeGreaterThan(0)
    expect(uninstall.indexOf("if not RestoreHost")).toBeGreaterThan(uninstall.indexOf("if not DesktopStartupOwned(Root)"))
    for (const forbidden of [
      "PrivilegesRequiredOverridesAllowed",
      "WOW6432Node",
      "taskkill",
      "extension\\dist",
      "skills adopt --all",
      "RenderNativeMessagingManifest",
      "RestartManager",
    ]) expect(source).not.toContain(forbidden)
    expect(source.match(/NativeMessagingHosts\\com\.interceptor\.host/g)?.length).toBeGreaterThanOrEqual(3)
    expect(source.split("\n").length).toBeLessThan(900)
  })

  test("replaces only an owned engine bundle on a Full upgrade", () => {
    const source = read("scripts/installer/interceptor.iss")
    const ownership = read("scripts/installer/desktop-ownership.iss")
    // [InstallDelete] is Full-only and removes nothing but {app}\engines, so files a new bundle
    // dropped cannot fail the provider's --engines-check after the upgrade.
    const section = /#ifdef FullInstall\r?\n\[InstallDelete\]\r?\n([\s\S]*?)\r?\n\[/.exec(source)?.[1] ?? ""
    expect(section.match(/^Type:.*$/gm)).toEqual(['Type: filesandordirs; Name: "{app}\\engines"'])
    expect(source.match(/\[InstallDelete\]/g)).toHaveLength(1)
    // Inno processes [InstallDelete] after PrepareToInstall, which stops on a foreign or modified bundle.
    const prepare = source.slice(source.indexOf("function PrepareToInstall"), source.indexOf("procedure CurStepChanged"))
    expect(prepare).toContain("if not EngineBundleOwned(ExpandConstant('{app}')) then")
    // A payload without engines drops the old bundle's record instead of failing the commit.
    const record = ownership.slice(ownership.indexOf("function RecordEngineBundle"), ownership.indexOf("function StopPriorDesktop"))
    for (const value of ["EngineSchemaVersion", "EngineManifestSHA256", "EngineProviderSHA256"]) {
      expect(record).toContain(`RegDeleteValue(HKCU, StateKey, '${value}');`)
    }
  })

  test("uninstall removes only the model files the provider downloads", () => {
    const source = read("scripts/installer/interceptor.iss")
    const model = /const FILE:&str="([^"]+)";/.exec(read("interceptor-desktop/src/local_ai.rs"))?.[1] ?? ""
    expect(model).toEndWith(".gguf")
    for (const file of [model, `${model}.sha256`, model.replace(/\.gguf$/, ".part")]) {
      expect(source).toContain(`Type: files; Name: "{localappdata}\\Interceptor\\Models\\${file}"`)
    }
    expect(source).toContain('Type: dirifempty; Name: "{localappdata}\\Interceptor\\Models"')
    expect(source).not.toMatch(/filesandordirs; Name: "\{localappdata\}\\Interceptor\\Models"/)
  })

  test("the Full installer build takes its Windows host from the caller and checks its payloads", () => {
    const env = { ...process.env }
    delete env.INTERCEPTOR_WINDOWS_BUILD_HOST
    delete env.INTERCEPTOR_WINDOWS_BUILD_SDK
    const run = captureShell("bun", [resolve(root, "scripts/build-windows-full.ts"), "arm64"], { env, timeout: 30_000 })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("Set --host (or INTERCEPTOR_WINDOWS_BUILD_HOST) and --sdk (or INTERCEPTOR_WINDOWS_BUILD_SDK)")
    const source = read("scripts/build-windows-full.ts")
    expect(source).toContain("embedsVersion(readFileSync(provider), version)")
    expect(source).toContain('join(repo, "scripts", "stage-desktop-engines.ts"), engines, "win32", arch')
    expect(source).not.toMatch(/\.ssh|C:\\\\Users\\\\|@\d+\.\d+\.\d+\.\d+/)
  })

  test("recovers committed installs before the app constant is initialized", () => {
    const source = read("scripts/installer/interceptor.iss")
    const commit = source.slice(source.indexOf("function CommitState"), source.indexOf("function ValidateState"))
    expect(commit).toContain("function CommitState(const Root: String)")
    expect(commit).toContain("if not PathIsRooted(Root)")
    expect(commit).not.toContain("ExpandConstant")
    expect(source).toContain("CommitState(PriorInstallRoot)")
    expect(source).toContain("CommitState(ExpandConstant('{app}'))")
    for (const entry of ["InitializeSetup", "InitializeUninstall"]) {
      const start = source.indexOf(`function ${entry}: Boolean;`)
      expect(start).toBeGreaterThan(0)
      const body = source.slice(start, source.indexOf("\nend;", start))
      expect(body.indexOf("if not ResolveExistingInstall")).toBeGreaterThan(0)
      expect(body.indexOf("if not RecoverPending")).toBeGreaterThan(body.indexOf("if not ResolveExistingInstall"))
    }
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
    // The Chrome Web Store identity is approved (store-identities.json), so the
    // release lane runs the production gate; the development override is gone.
    expect(workflow).not.toContain("INTERCEPTOR_WINDOWS_IDENTITY_MODE")
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

  test("ships the Windows copy of the skills from the stage, and the native-app skill only with Full", () => {
    const iss = read("scripts/installer/interceptor.iss")
    // build.sh writes the Windows copy (scripts/gen-skills.ts); the raw sources hold every OS's lines.
    expect(read("scripts/build.sh")).toContain('bun scripts/gen-skills.ts win32 "$stage/skills" interceptor interceptor-browser interceptor-research interceptor-desktop')
    expect(iss).not.toContain(".agents\\skills")
    for (const skill of ["interceptor", "interceptor-browser", "interceptor-research"])
      expect(iss).toContain(`Source: "{#StageDir}\\skills\\${skill}\\*"; DestDir: "{app}\\skills\\${skill}"`)
    expect(iss).toMatch(/#ifdef FullInstall\r?\n;[^\n]*\r?\nSource: "\{#StageDir\}\\skills\\interceptor-desktop\\\*"[^\n]*\r?\n#endif/)
    expect(read("scripts/release.sh")).not.toContain("interceptor-desktop")
  })
})
