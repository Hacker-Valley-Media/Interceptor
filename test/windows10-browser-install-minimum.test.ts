import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { renderManifests } from "../scripts/release/generate-winget"

const root = resolve(import.meta.dir, "..")

describe("Windows 10 x64 installer minimum", () => {
  test("allows both editions on Win10 x64 and keeps Windows ARM64 at 26100", () => {
    const script = readFileSync(resolve(root, "scripts/installer/interceptor.iss"), "utf8")
    expect(script).toMatch(
      /#if ArtifactArch == "x64"\s+#define MinimumWindowsVersion "10\.0\.19045"\s+#else\s+#define MinimumWindowsVersion "10\.0\.26100"\s+#endif/
    )
    expect(script).toContain("MinVersion={#MinimumWindowsVersion}")
    expect(script).toContain("GetWindowsVersionEx(WindowsVersion)")
    expect(script).toContain("(WindowsVersion.Build >= 22000)")
    expect(script).toContain("(WindowsVersion.Build < 26100)")
    expect(script).toContain("Full requires Windows 11 24H2+ on Windows 11.")
    const identity = readFileSync(resolve(root, "scripts/installer/build-windows-notification-identity.ps1"), "utf8")
    expect(identity).toContain("$minVersion=if($Arch -eq 'x64'){'10.0.19041.0'}else{'10.0.26100.0'}")
    expect(identity).toContain('MinVersion="$minVersion" MaxVersionTested="10.0.26100.0"')
  })

  test("Full identity build allows only recognized Microsoft SDK signatures", () => {
    const builder = readFileSync(resolve(root, "scripts/installer/build-windows-notification-identity.ps1"), "utf8")
    expect(builder).toContain("$signature.Status -ne 'Valid'")
    expect(builder).toContain("CN=Microsoft Windows Kits Publisher,*")
    expect(builder).toContain("CN=Microsoft Windows Code Signing PCA 2024,*")
    expect(builder).toContain("$subject -ceq 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'")
    expect(builder).toContain("!($kitsPublisher -or $newerPublisher)")
  })

  test("winget exposes matching minimums for each Browser-only architecture", () => {
    const manifest = renderManifests({
      version: "2.1.6",
      baseUrl: "https://github.com/Hacker-Valley-Media/Interceptor/releases/download/v2.1.6",
      x64Sha256: "a".repeat(64),
      arm64Sha256: "b".repeat(64),
      output: resolve(root, "dist", "test-winget"),
    })["HackerValleyMedia.Interceptor.installer.yaml"]
    const installers = manifest.split("Installers:\n")[1]
    const x64 = installers.split("  - Architecture: x64\n")[1]?.split("  - Architecture: arm64\n")[0]
    const arm64 = installers.split("  - Architecture: arm64\n")[1]
    expect(manifest).not.toMatch(/^MinimumOSVersion:/m)
    expect(x64).toContain("MinimumOSVersion: 10.0.19045.0")
    expect(arm64).toContain("MinimumOSVersion: 10.0.26100.0")
  })

  test("bootstrap permits Win10 x64 Full without changing Windows 11 24H2 selection", () => {
    const source = readFileSync(resolve(root, "scripts/get-interceptor.ps1"), "utf8")
    expect(source).toContain("[System.Runtime.InteropServices.RuntimeInformation, mscorlib]::OSArchitecture")
    expect(source).toContain("$PSVersionTable.PSVersion.Major -le 5")
    expect(source).toContain('$win10Full = $arch -eq "x64" -and $osBuild -ge 19045 -and $osBuild -lt 22000')
    expect(source).toContain('$olderWin11BrowserOnly = $arch -eq "x64" -and $osBuild -ge 22000 -and $osBuild -lt 26100')
    expect(source).toContain('if ($osBuild -lt 26100 -and -not ($win10Full -or $olderWin11BrowserOnly))')
    expect(source).toContain('if ($olderWin11BrowserOnly -and $Full)')
    expect(source).toContain('$mode = if ($olderWin11BrowserOnly) { "browser" } elseif ($Full) { "full" }')
    expect(source).not.toContain('if ($win10Full -and $Full)')
  })

  test.skipIf(process.platform !== "win32" || process.arch !== "x64")("bootstrap resolves x64 architecture under PowerShell 5.1 with PSReadLine loaded", () => {
    const source = readFileSync(resolve(root, "scripts/get-interceptor.ps1"), "utf8")
    const fragment = source.match(/  \$runtimeArch = if \(\$PSVersionTable\.PSVersion\.Major -le 5\) \{[\s\S]*?  \$arch = \$runtimeArch\.ToString\(\)/)?.[0]
    expect(fragment).toBeDefined()
    const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "Import-Module PSReadLine -ErrorAction Stop; " + fragment + "; Write-Output $arch"], {
      stdout: "pipe", stderr: "pipe", timeout: 10000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe("X64")
  })

})
