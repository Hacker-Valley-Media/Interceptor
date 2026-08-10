# Install Interceptor on Windows

Interceptor for Windows is browser-only. It supports Windows 11 24H2 or newer on x64 and ARM64, installs for the current user without elevation, and supports one active interactive user per machine.

## Install

1. Download the architecture-matched `Interceptor-Browser-X.Y.Z-windows-x64.exe` or `Interceptor-Browser-X.Y.Z-windows-arm64.exe` from the matching GitHub release.
2. Verify that Windows reports the publisher as **Hacker Valley Media**. Do not continue with an unsigned or differently signed production artifact.
3. Run Setup. New installs use `%LOCALAPPDATA%\Programs\Interceptor`; upgrades and repairs preserve the existing same-product directory.
4. Load the Interceptor extension. Setup drops an unpacked copy on disk at `%LOCALAPPDATA%\Programs\Interceptor\extension`; open your browser's extensions page (`chrome://extensions`, `brave://extensions`, or `edge://extensions`), enable **Developer mode**, click **Load unpacked**, and select that folder. Once the store listing is public you can install from the Chrome Web Store (Chrome/Brave) or Microsoft Edge Add-ons (Edge) instead. Setup never changes a browser profile or loads the extension without consent — it only stages the files.
5. Open a new terminal and run:

   ```powershell
   interceptor init --verbose
   interceptor status
   ```

`status` reports `mode: browser-only`. The daemon starts only when a CLI or approved browser-extension request needs it.

Optional AI skills are bundled but not linked automatically:

```powershell
interceptor skills adopt
```

## Silent install

Use an absolute, current-user-writable log path:

```powershell
& .\Interceptor-Browser-X.Y.Z-windows-arm64.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART "/LOG=$env:TEMP\interceptor-setup.log"
```

Use `/SILENT` instead of `/VERYSILENT` for progress UI. Silent setup opens no browser, URL, or terminal and returns nonzero on failure. No supported path requests a reboot.

## Repair, update, and downgrade

Run the same signed version to repair, or a newer architecture-matched installer to update. Downgrades are refused. Windows ARM64 users should use the ARM64 package even if an older x64 build was previously installed under emulation.

## Uninstall

Use **Settings → Apps → Installed apps → Interceptor (Browser-Only) → Uninstall**, or run the installed uninstaller. Silent uninstall uses Inno Setup's standard switches:

```powershell
& "$env:LOCALAPPDATA\Programs\Interceptor\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART "/LOG=$env:TEMP\interceptor-uninstall.log"
```

Uninstall removes only installer-owned PATH/native-host state and owned skill links. It preserves browser extensions, browser data, user data, foreign registry values, unrelated PATH tokens, and real/foreign skill directories.

## Troubleshooting

- **Command not found:** open a new terminal, then run the executable directly from the install directory once to confirm the install.
- **Unknown command or stale behavior:** run `where.exe interceptor`. If another copy resolves before `%LOCALAPPDATA%\Programs\Interceptor` (for example a leftover development install), remove that earlier PATH entry; the installer never edits PATH entries it does not own.
- **Extension not connected:** confirm the extension is loaded (via **Load unpacked** from `%LOCALAPPDATA%\Programs\Interceptor\extension`, or the store listing once public) and enabled, then run `interceptor init --verbose`.
- **Install/upgrade in progress:** wait for Setup to finish. If Setup was interrupted, rerun the same signed installer so its pending transaction can recover.
- **Ports 19221/19222 already in use:** Interceptor v1 supports one active interactive Windows user. Stop the other Interceptor/development instance; Setup never terminates an unidentified process.
- **Legacy administrator preview detected:** remove that copy from Installed apps with an administrator account, then rerun the per-user installer.
- **Logs:** pass `/LOG=<absolute-path>` to Setup or uninstall. Logs intentionally omit daemon shutdown tokens, signing credentials, browser data, and unrelated registry/PATH contents.

Windows does not provide `interceptor macos *`. Use the macOS Full package for native macOS computer-use commands.
