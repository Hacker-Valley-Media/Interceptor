; Interceptor per-user Windows installer. FullInstall adds the native provider.
; Inno owns payload installation and rollback. Custom code is limited to the
; state Inno cannot own safely: PATH, native-host defaults, and daemon handoff.
#ifndef AppVersion
  #error AppVersion must be defined as X.Y.Z
#endif
#ifndef ArtifactArch
  #error ArtifactArch must be defined as x64 or arm64
#endif
#ifndef StageDir
  #define StageDir "..\..\dist\windows\" + ArtifactArch
#endif
#ifndef ArtifactSuffix
  #define ArtifactSuffix ""
#endif
#ifdef FullInstall
  #define InstallMode "full"
  #define InstallLabel "Full (Experimental Native)"
#else
  #define InstallMode "browser-only"
  #define InstallLabel "Browser-Only"
#endif
#define ProductGuid "B7F4D8A1-3E22-4B91-A6E4-9C2D5F8A1234"
#define NotificationAppId "HackerValleyMedia.Interceptor.Desktop"
#define BadgeAppId "HackerValleyMedia.Interceptor.Desktop_4xfsjzhwq8rce!Desktop"
#define NotificationActivator "811E51B6-6CC5-4FAB-B922-C733988093B5"
#define ProductAppId "{" + ProductGuid + "}"
#if ArtifactArch == "x64"
  #define AllowedArchitectures "x64os"
  #define InstallArchitectures "x64compatible"
#elif ArtifactArch == "arm64"
  #define AllowedArchitectures "arm64"
  #define InstallArchitectures "arm64"
#else
  #error ArtifactArch must be x64 or arm64
#endif
[Setup]
AppId={{{#ProductGuid}}
AppName=Interceptor
AppVersion={#AppVersion}
AppVerName=Interceptor ({#InstallLabel}) {#AppVersion}
AppPublisher=Hacker Valley Media
AppPublisherURL=https://github.com/Hacker-Valley-Media/Interceptor
AppSupportURL=https://github.com/Hacker-Valley-Media/Interceptor/issues
AppUpdatesURL=https://github.com/Hacker-Valley-Media/Interceptor/releases
DefaultDirName={userpf}\Interceptor
DefaultGroupName=Interceptor
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UsePreviousAppDir=yes
MinVersion=10.0.26100
SetupArchitecture=x64
ArchitecturesAllowed={#AllowedArchitectures}
ArchitecturesInstallIn64BitMode={#InstallArchitectures}
CloseApplications=no
RestartApplications=no
ChangesEnvironment=yes
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\..\assets\windows\interceptor.ico
InfoAfterFile=post-install.txt
OutputDir=..\..\dist\release\windows
#ifdef FullInstall
OutputBaseFilename=Interceptor-Full-{#AppVersion}-windows-{#ArtifactArch}{#ArtifactSuffix}
#else
OutputBaseFilename=Interceptor-Browser-{#AppVersion}-windows-{#ArtifactArch}{#ArtifactSuffix}
#endif
UninstallLogMode=overwrite
UninstallDisplayIcon={app}\interceptor.ico
UninstallDisplayName=Interceptor ({#InstallLabel})
VersionInfoVersion={#AppVersion}
VersionInfoCompany=Hacker Valley Media
VersionInfoDescription=Interceptor {#InstallLabel} Setup
VersionInfoProductName=Interceptor
VersionInfoProductVersion={#AppVersion}
VersionInfoCopyright=Copyright (c) Hacker Valley Media
AllowNoIcons=yes
AllowCancelDuringInstall=yes
DisableWelcomePage=no
CreateUninstallRegKey=yes
Uninstallable=yes
#ifdef SigningEnabled
SignedUninstaller=yes
#ifndef ExternalUninstallerSigning
SignTool=InterceptorSign
#endif
#else
SignedUninstaller=no
#endif
[Files]
Source: "{#StageDir}\interceptor.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\interceptor.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\daemon\interceptor-daemon.exe"; DestDir: "{app}\daemon"; Flags: ignoreversion
Source: "{#StageDir}\daemon\com.interceptor.host.json"; DestDir: "{app}\daemon"; Flags: ignoreversion
#ifdef FullInstall
Source: "{#StageDir}\desktop\interceptor-desktop.exe"; DestDir: "{app}"; Flags: ignoreversion
#if FileExists(StageDir + "\desktop\engines\manifest.json")
Source: "{#StageDir}\desktop\engines\*"; DestDir: "{app}\engines"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
#endif
Source: "..\..\interceptor-desktop\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\desktop\interceptor-notification-badge.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\desktop\interceptor-contacts-native.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\desktop\notifications\notification-identity.msix"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\desktop\notifications\package\Assets\logo.png"; DestDir: "{app}\Assets"; Flags: ignoreversion
Source: "windows-notification-identity.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "windows-notification-identity.ps1"; DestName: "notification-identity-maintenance.ps1"; Flags: dontcopy
#endif
; Unpacked browser extension dropped on disk so the user has one stable place to
; point "Load unpacked" (Developer mode). Setup still never touches a browser
; profile or loads it automatically — it only stages the files.
Source: "{#StageDir}\extension\*"; DestDir: "{app}\extension"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\skills\interceptor\*"; DestDir: "{app}\skills\interceptor"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\skills\interceptor-browser\*"; DestDir: "{app}\skills\interceptor-browser"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\skills\interceptor-research\*"; DestDir: "{app}\skills\interceptor-research"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
#ifdef FullInstall
; The native-app skill ships only with the provider it describes.
Source: "{#StageDir}\skills\interceptor-desktop\*"; DestDir: "{app}\skills\interceptor-desktop"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
#endif
#ifdef FullInstall
[InstallDelete]
; Replace the engine bundle whole: a file the new bundle no longer ships fails --engines-check.
; Inno runs this after PrepareToInstall, which stops on a foreign or modified bundle
; (EngineBundleOwned), so only the bundle this installer recorded is removed.
Type: filesandordirs; Name: "{app}\engines"
[Icons]
; Inno owns creation, rollback and uninstall of this user-session startup link.
Name: "{userstartup}\Interceptor Desktop {#ProductGuid}"; Filename: "{app}\interceptor-desktop.exe"; WorkingDir: "{app}"
Name: "{userprograms}\Interceptor Desktop {#ProductGuid}"; Filename: "{app}\interceptor-desktop.exe"; WorkingDir: "{app}"; AppUserModelID: "{#NotificationAppId}"; AppUserModelToastActivatorCLSID: "{#NotificationActivator}"
Name: "{userprograms}\Interceptor Badge {#ProductGuid}"; Filename: "{app}\interceptor-notification-badge.exe"; WorkingDir: "{app}"; IconFilename: "{app}\interceptor.ico"; AppUserModelID: "{#BadgeAppId}"
[Registry]
Root: HKCU; Subkey: "Software\Classes\CLSID\{{{#NotificationActivator}}\LocalServer32"; ValueType: string; ValueName: ""; ValueData: """{app}\interceptor-desktop.exe"" --toast-activated"; Flags: uninsdeletevalue uninsdeletekeyifempty
#endif
[UninstallDelete]
; The local AI model: 2.8 GB the provider downloaded on first use. It lives outside {app} so an
; upgrade keeps it; an uninstall removes only the files the provider writes (local_ai.rs).
Type: files; Name: "{localappdata}\Interceptor\Models\gemma-4-E2B-it-Q4_0.gguf"
Type: files; Name: "{localappdata}\Interceptor\Models\gemma-4-E2B-it-Q4_0.gguf.sha256"
Type: files; Name: "{localappdata}\Interceptor\Models\gemma-4-E2B-it-Q4_0.part"
Type: dirifempty; Name: "{localappdata}\Interceptor\Models"
; The provider's update folder: downloaded installers, the update watcher copy, logs and state (update.rs).
Type: filesandordirs; Name: "{localappdata}\Interceptor\Updates"
Type: dirifempty; Name: "{localappdata}\Interceptor"
; recursesubdirs leaves the extension's (empty) subdir tree behind on uninstall;
; remove the whole staged extension folder explicitly. filesandordirs also clears
; anything a user dropped in — the browser only reads from here, never writes.
Type: filesandordirs; Name: "{app}\extension"
; The same empty-tree residue for the other recursesubdirs payloads (an uninstall otherwise
; left engines\*, skills\*, daemon and Assets behind as empty folders). By this point uninstall
; has verified the engine bundle is the one this installer wrote and has unadopted the skill links.
Type: filesandordirs; Name: "{app}\skills"
#ifdef FullInstall
Type: filesandordirs; Name: "{app}\engines"
Type: dirifempty; Name: "{app}\Assets"
#endif
Type: dirifempty; Name: "{app}\daemon"
#ifdef FullInstall
; WebView2 keeps the overlay renderer's profile beside the provider: runtime state, not user data.
Type: filesandordirs; Name: "{app}\interceptor-desktop.exe.WebView2"
#endif
; Last, once everything above is gone.
Type: dirifempty; Name: "{app}"
[Run]
#ifdef FullInstall
Filename: "{app}\interceptor-desktop.exe"; Flags: nowait runhidden
#endif
Filename: "https://github.com/Hacker-Valley-Media/Interceptor/blob/v{#AppVersion}/docs/windows-install.md"; Description: "Open the Windows setup guide"; Flags: shellexec postinstall skipifsilent unchecked nowait
[Code]
const
  ProductUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#ProductAppId}_is1';
  InstallerRoot = 'Software\Hacker Valley Media\Interceptor\Installer';
  StateKey = 'Software\Hacker Valley Media\Interceptor\Installer\State';
  PendingKey = 'Software\Hacker Valley Media\Interceptor\Installer\Pending';
  EnvironmentKey = 'Environment';
  ChromeHostKey = 'Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host';
  BraveHostKey = 'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.interceptor.host';
  EdgeHostKey = 'Software\Microsoft\Edge\NativeMessagingHosts\com.interceptor.host';
  ManifestRelativePath = 'daemon\com.interceptor.host.json';
  GuardFileName = 'interceptor.installing';
  RegTypeSz = 1;
  RegTypeExpandSz = 2;
  RawRegistryTypes = $1000FFFF; // RRF_RT_ANY or RRF_NOEXPAND
var
  PriorInstallPresent: Boolean;
  PriorInstallRoot: String;
  PriorInstallVersion: String;
  TransactionPrepared: Boolean;
  InstallCommitted: Boolean;
  GuardPath: String;
  TransactionId: String;
  SetupFailureText: String;
function GetCurrentProcessId: DWORD;
  external 'GetCurrentProcessId@kernel32.dll stdcall';
function ProcessIdToSessionId(ProcessId: DWORD; var SessionId: DWORD): Boolean;
  external 'ProcessIdToSessionId@kernel32.dll stdcall';
function ExpandEnvironmentStrings(Source, Destination: String; Size: Cardinal): Cardinal;
  external 'ExpandEnvironmentStringsW@kernel32.dll stdcall';
function RegGetValue(Key: HKEY; SubKey, Name: String; Flags: DWORD; var ValueType: DWORD; Data: ULONG_PTR; var Size: DWORD): LONG;
  external 'RegGetValueW@advapi32.dll stdcall';
function RegSetKeyValue(Key: HKEY; SubKey, Name: String; ValueType: DWORD; Data: String; Size: DWORD): LONG;
  external 'RegSetKeyValueW@advapi32.dll stdcall';
function IsStableVersion(const Value: String): Boolean;
var Version: Int64;
begin
  Result := StrToVersion(Value, Version) and (VersionToStr(Version) = Value + '.0');
end;
function NormalizeRoot(const Value: String): String;
begin
  Result := Trim(Value);
  StringChangeEx(Result, '/', '\', True);
  Result := RemoveBackslashUnlessRoot(Result);
end;
function SamePath(const LeftValue, RightValue: String): Boolean;
begin
  Result := PathIsRooted(LeftValue) and PathIsRooted(RightValue) and
    (CompareText(NormalizeRoot(LeftValue), NormalizeRoot(RightValue)) = 0);
end;
function DesktopIsInstalled: Boolean;
var Mode: String;
begin
  Result := RegQueryStringValue(HKCU, StateKey, 'DesktopMode', Mode) and (Mode = 'full');
end;
#include "desktop-ownership.iss"
function NewTransactionId: String;
var
  Hash: String;
begin
  Hash := Lowercase(GetSHA256OfString(GetUserNameString + '|' +
    GetDateTimeString('yyyy-mm-dd hh:nn:ss.zzz', '-', ':') + '|' + IntToStr(Random(2147483647))));
  Result := Copy(Hash, 1, 8) + '-' + Copy(Hash, 9, 4) + '-4' + Copy(Hash, 14, 3) +
    '-8' + Copy(Hash, 18, 3) + '-' + Copy(Hash, 21, 12);
end;
function NotificationIdentityAction(const Action, Root: String): Boolean;
#ifdef FullInstall
var
  Script, Params: String;
  ExitCode: Integer;
begin
  Result := False;
  if IsUninstaller then Script := AddBackslash(Root) + 'windows-notification-identity.ps1'
  else
  begin
    ExtractTemporaryFile('notification-identity-maintenance.ps1');
    Script := ExpandConstant('{tmp}\notification-identity-maintenance.ps1');
  end;
  Params := '-NoProfile -NonInteractive -Mta -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    Script + '" -Action ' + Action + ' -Root "' + AddBackslash(Root) + '." -Version {#AppVersion}';
  if TransactionId <> '' then Params := Params + ' -TransactionId ' + TransactionId;
  Result := FileExists(Script) and ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Params, '', SW_HIDE, ewWaitUntilTerminated, ExitCode, nil) and (ExitCode = 0);
end;
#else
begin Result := True; end;
#endif
function GuardFilePath: String;
begin
  Result := AddBackslash(GetEnv('TEMP')) + GuardFileName;
end;
function CurrentUserSid: String;
var
  Output: TExecOutput;
  Fields: TArrayOfString;
  ExitCode: Integer;
begin
  Result := '';
  if not ExecAndCaptureOutput(ExpandConstant('{sys}\whoami.exe'), '/USER /FO CSV /NH', '',
    SW_HIDE, ewWaitUntilTerminated, ExitCode, Output) or (ExitCode <> 0) or
    Output.Error or (GetArrayLength(Output.StdOut) <> 1) then Exit;
  Fields := StringSplit(Output.StdOut[0], [','], stAll);
  if GetArrayLength(Fields) < 2 then Exit;
  Result := RemoveQuotes(Fields[GetArrayLength(Fields) - 1]);
  if Pos('S-1-', Result) <> 1 then Result := '';
end;
function JsonPath(const Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
end;
function CreateGuard: Boolean;
var
  Sid, Json, Params: String;
  ExitCode: Integer;
begin
  Result := False;
  GuardPath := GuardFilePath;
  Sid := CurrentUserSid;
  if Sid = '' then Exit;
  Json := '{"schemaVersion":1,"transactionId":"' + TransactionId +
    '","userSid":"' + Sid + '","setupPid":' + IntToStr(GetCurrentProcessId) +
    ',"priorRoot":"' + JsonPath(PriorInstallRoot) + '","targetRoot":"' + JsonPath(ExpandConstant('{app}')) +
    // Quote T/Z: unquoted characters become time/millisecond specifiers, not ISO8601 literals.
    '","createdAt":"' + GetDateTimeString('yyyy-mm-dd''T''hh:nn:ss.zzz''Z''', '-', ':') + '"}' + #13#10;
  if not SaveStringToFile(GuardPath, Json, False) then Exit;
  Params := '"' + GuardPath + '" /inheritance:r /grant:r "*' + Sid + ':(F)"';
  if not Exec(ExpandConstant('{sys}\icacls.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or
     (ExitCode <> 0) then begin DeleteFile(GuardPath); Exit; end;
  Result := True;
end;
function QueryRegistryType(const SubKey, ValueName: String): Integer;
var ValueType, Size: DWORD;
begin
  ValueType := 0; Size := 0;
  if RegGetValue(HKCU, SubKey, ValueName, RawRegistryTypes, ValueType, 0, Size) = 0 then Result := ValueType
  else Result := 0;
end;
function WriteStringByType(const SubKey, Name, Value: String; ValueType: Cardinal): Boolean;
begin
  Result := ((ValueType = RegTypeSz) or (ValueType = RegTypeExpandSz)) and
    (RegSetKeyValue(HKCU, SubKey, Name, ValueType, Value, (Length(Value) + 1) * 2) = 0);
end;
function ExpandPercentVariables(const Value: String): String;
var Size: Cardinal;
begin
  Size := ExpandEnvironmentStrings(Value, '', 0);
  if (Size = 0) or (Size > 1048576) then RaiseException('Environment expansion failed or exceeded 1MiB.');
  SetLength(Result, Size);
  if ExpandEnvironmentStrings(Value, Result, Size) <> Size then RaiseException('Environment changed during expansion.');
  SetLength(Result, Size - 1);
end;
function NormalizePathToken(const Value: String): String;
begin
  Result := Trim(Value);
  if (Length(Result) >= 2) and (Result[1] = '"') and (Result[Length(Result)] = '"') then
    Result := Copy(Result, 2, Length(Result) - 2);
  Result := ExpandPercentVariables(Result);
  StringChangeEx(Result, '/', '\', True);
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
  Result := Lowercase(Result);
end;
function CountPathTokens(const RawPath, Target: String): Integer;
var
  Tokens: TArrayOfString;
  I: Integer;
begin
  Result := 0;
  Tokens := StringSplit(RawPath, [';'], stAll);
  for I := 0 to GetArrayLength(Tokens) - 1 do
    if CompareText(NormalizePathToken(Tokens[I]), NormalizePathToken(Target)) = 0 then
      Result := Result + 1;
end;
function CopyDword(const SourceKey, DestKey, Name: String): Boolean;
var
  Value: Cardinal;
begin
  Result := RegQueryDWordValue(HKCU, SourceKey, Name, Value) and
    RegWriteDWordValue(HKCU, DestKey, Name, Value);
end;
function CopyString(const SourceKey, DestKey, Name: String): Boolean;
var
  Value: String;
begin
  Result := RegQueryStringValue(HKCU, SourceKey, Name, Value) and
    RegWriteStringValue(HKCU, DestKey, Name, Value);
end;
function CaptureHost(const Name, SubKey, OwnedValue: String; Hardened: Boolean): Boolean;
var
  SourceKey, DestKey, Current, PriorValue: String;
  ValueType, Value: Cardinal;
begin
  Result := False;
  DestKey := PendingKey + '\NativeHosts\' + Name;
  if not RegWriteStringValue(HKCU, DestKey, 'OwnedValue', OwnedValue) then Exit;
  Value := Ord(RegValueExists(HKCU, SubKey, '')); ValueType := 0; Current := '';
  if Value = 1 then
  begin
    ValueType := QueryRegistryType(SubKey, '');
    if ((ValueType <> RegTypeSz) and (ValueType <> RegTypeExpandSz)) or
       not RegQueryStringValue(HKCU, SubKey, '', Current) then
    begin SetupFailureText := 'Setup refused an unsupported native-host default value type.'; Exit; end;
  end;
  // Rollback restores this transaction; Prior* remains the original uninstall backup.
  if not (RegWriteDWordValue(HKCU, DestKey, 'RollbackKeyPriorExists', Ord(RegKeyExists(HKCU, SubKey))) and
    RegWriteDWordValue(HKCU, DestKey, 'RollbackPriorOrigin', Value) and
    RegWriteDWordValue(HKCU, DestKey, 'RollbackPriorType', ValueType) and
    RegWriteStringValue(HKCU, DestKey, 'RollbackPriorValue', Current)) then Exit;
  if Hardened then
  begin
    SourceKey := StateKey + '\NativeHosts\' + Name;
    if (Value = 0) or not RegQueryStringValue(HKCU, SourceKey, 'OwnedValue', PriorValue) or
       (CompareText(PriorValue, Current) <> 0) then
    begin
      SetupFailureText := 'A native-host value changed after installation. Restore it before repair or upgrade.';
      Exit;
    end;
    Result := CopyDword(SourceKey, DestKey, 'KeyPriorExists') and
      CopyDword(SourceKey, DestKey, 'PriorOrigin') and
      CopyDword(SourceKey, DestKey, 'PriorType') and
      CopyString(SourceKey, DestKey, 'PriorValue');
    Exit;
  end;
  if (Value = 1) and PriorInstallPresent and
     SamePath(Current, AddBackslash(PriorInstallRoot) + 'com.interceptor.host.json') then Value := 2;
  if Value <> 1 then begin ValueType := 0; Current := ''; end;
  Result := RegWriteDWordValue(HKCU, DestKey, 'KeyPriorExists', Ord(RegKeyExists(HKCU, SubKey))) and
    RegWriteDWordValue(HKCU, DestKey, 'PriorOrigin', Value) and
    RegWriteDWordValue(HKCU, DestKey, 'PriorType', ValueType) and
    RegWriteStringValue(HKCU, DestKey, 'PriorValue', Current);
end;
function CapturePath(const Target: String; Hardened: Boolean): Boolean;
var
  Current, Intended, RecordedToken: String;
  CurrentType, Added, OriginalType, OriginalExists, Ambiguous: Cardinal;
begin
  Result := False;
  Current := '';
  if RegValueExists(HKCU, EnvironmentKey, 'Path') then
  begin
    if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Current) then Exit;
    CurrentType := QueryRegistryType(EnvironmentKey, 'Path');
    if (CurrentType <> RegTypeSz) and (CurrentType <> RegTypeExpandSz) then Exit;
  end
  else CurrentType := RegTypeExpandSz;
  Intended := Current;
  Added := 0;
  Ambiguous := 0;
  OriginalType := CurrentType;
  OriginalExists := Ord(RegValueExists(HKCU, EnvironmentKey, 'Path'));
  if Hardened then
  begin
    if not RegQueryDWordValue(HKCU, StateKey, 'PathAdded', Added) or
       not RegQueryDWordValue(HKCU, StateKey, 'PathOriginalType', OriginalType) or
       not RegQueryDWordValue(HKCU, StateKey, 'PathPriorExists', OriginalExists) or
       not RegQueryDWordValue(HKCU, StateKey, 'PathLegacyAmbiguous', Ambiguous) or
       not RegQueryStringValue(HKCU, StateKey, 'PathToken', RecordedToken) or
       not SamePath(RecordedToken, Target) then Exit;
    if (Added = 1) and (CountPathTokens(Current, Target) <> 1) then
    begin SetupFailureText := 'The installer-owned PATH entry is missing or ambiguous.'; Exit; end;
  end
  else if CountPathTokens(Current, Target) = 0 then
  begin
    if Current = '' then Intended := Target
    { A trailing separator belongs to the prior value: append "Target;" so the
      uninstall splice removes "Target;" and restores the value byte-exactly. }
    else if Current[Length(Current)] = ';' then Intended := Current + Target + ';'
    else Intended := Current + ';' + Target;
    Added := 1;
  end
  else if PriorInstallPresent then Ambiguous := 1;
  RegWriteDWordValue(HKCU, PendingKey + '\Path', 'PriorExists', Ord(RegValueExists(HKCU, EnvironmentKey, 'Path')));
  RegWriteDWordValue(HKCU, PendingKey + '\Path', 'PriorType', CurrentType);
  RegWriteStringValue(HKCU, PendingKey + '\Path', 'PriorValue', Current);
  RegWriteStringValue(HKCU, PendingKey + '\Path', 'IntendedValue', Intended);
  RegWriteDWordValue(HKCU, PendingKey + '\Path', 'PathAdded', Added);
  RegWriteStringValue(HKCU, PendingKey + '\Path', 'PathToken', Target);
  RegWriteDWordValue(HKCU, PendingKey + '\Path', 'PathOriginalType', OriginalType);
  RegWriteDWordValue(HKCU, PendingKey + '\Path', 'PathPriorExists', OriginalExists);
  RegWriteDWordValue(HKCU, PendingKey + '\Path', 'PathLegacyAmbiguous', Ambiguous);
  Result := True;
end;
function RestoreHost(const SourceKey, Name, SubKey: String; Conditional: Boolean): Boolean;
var
  HostKey, Owned, Current, PriorValue, Prefix: String;
  PriorOrigin, PriorType, KeyPriorExists: Cardinal;
begin
  Result := False;
  HostKey := SourceKey + '\NativeHosts\' + Name;
  if not RegQueryStringValue(HKCU, HostKey, 'OwnedValue', Owned) then Exit;
  Current := '';
  if Conditional and RegQueryStringValue(HKCU, SubKey, '', Current) and
     (CompareText(Current, Owned) <> 0) then begin Result := True; Exit; end;
  Prefix := '';
  if (SourceKey = PendingKey) and RegValueExists(HKCU, HostKey, 'RollbackPriorOrigin') then Prefix := 'Rollback';
  if not RegQueryDWordValue(HKCU, HostKey, Prefix + 'PriorOrigin', PriorOrigin) then Exit;
  if PriorOrigin = 1 then
  begin
    if not RegQueryDWordValue(HKCU, HostKey, Prefix + 'PriorType', PriorType) or
       not RegQueryStringValue(HKCU, HostKey, Prefix + 'PriorValue', PriorValue) then Exit;
    Result := WriteStringByType(SubKey, '', PriorValue, PriorType);
  end
  else
  begin
    RegDeleteValue(HKCU, SubKey, '');
    Result := True;
  end;
  if Result and RegQueryDWordValue(HKCU, HostKey, Prefix + 'KeyPriorExists', KeyPriorExists) and
     (KeyPriorExists = 0) then RegDeleteKeyIfEmpty(HKCU, SubKey);
end;
function RestorePending: Boolean;
var
  PriorExists, PriorType: Cardinal;
  PriorValue, Intended, Current, IdentityRoot: String;
begin
  if RegQueryStringValue(HKCU, PendingKey + '\NotificationIdentity', 'Root', IdentityRoot) and
     not NotificationIdentityAction('rollback', IdentityRoot) then begin Result := False; Exit; end;
  Result := RestoreHost(PendingKey, 'Chrome', ChromeHostKey, True) and
    RestoreHost(PendingKey, 'Brave', BraveHostKey, True) and
    RestoreHost(PendingKey, 'Edge', EdgeHostKey, True);
  if not Result then Exit;
  if not RegQueryDWordValue(HKCU, PendingKey + '\Path', 'PriorExists', PriorExists) or
     not RegQueryDWordValue(HKCU, PendingKey + '\Path', 'PriorType', PriorType) or
     not RegQueryStringValue(HKCU, PendingKey + '\Path', 'PriorValue', PriorValue) or
     not RegQueryStringValue(HKCU, PendingKey + '\Path', 'IntendedValue', Intended) then
  begin Result := False; Exit; end;
  Current := '';
  RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Current);
  if Current <> Intended then begin Result := True; Exit; end;
  if PriorExists = 0 then begin RegDeleteValue(HKCU, EnvironmentKey, 'Path'); Result := True; end
  else Result := WriteStringByType(EnvironmentKey, 'Path', PriorValue, PriorType);
end;
function CopyHostToState(const Name: String): Boolean;
var
  SourceKey, DestKey: String;
begin
  SourceKey := PendingKey + '\NativeHosts\' + Name;
  DestKey := StateKey + '\NativeHosts\' + Name;
  Result := CopyDword(SourceKey, DestKey, 'KeyPriorExists') and
    CopyDword(SourceKey, DestKey, 'PriorOrigin') and
    CopyDword(SourceKey, DestKey, 'PriorType') and
    CopyString(SourceKey, DestKey, 'PriorValue') and
    CopyString(SourceKey, DestKey, 'OwnedValue');
end;
function CommitState(const Root: String): Boolean;
var Mode: String;
begin
  if not PathIsRooted(Root) then begin Result := False; Exit; end;
  // Browser-only pending transactions from earlier versions have no mode.
  if not RegQueryStringValue(HKCU, PendingKey, 'DesktopMode', Mode) then Mode := 'browser-only';
  Result := False;
  if (Mode <> 'full') and (Mode <> 'browser-only') then Exit;
  RegWriteDWordValue(HKCU, StateKey, 'SchemaVersion', 1);
  RegWriteStringValue(HKCU, StateKey, 'InstalledVersion', '{#AppVersion}');
  RegWriteStringValue(HKCU, StateKey, 'InstallRoot', Root);
  RegWriteStringValue(HKCU, StateKey, 'OwnedManifestPath', AddBackslash(Root) + ManifestRelativePath);
  RegWriteDWordValue(HKCU, StateKey, 'ShutdownProtocolVersion', 1);
  RegWriteDWordValue(HKCU, StateKey, 'UninstallLogGeneration', 1);
  Result := CopyDword(PendingKey + '\Path', StateKey, 'PathAdded') and
    CopyString(PendingKey + '\Path', StateKey, 'PathToken') and
    CopyDword(PendingKey + '\Path', StateKey, 'PathOriginalType') and
    CopyDword(PendingKey + '\Path', StateKey, 'PathPriorExists') and
    CopyDword(PendingKey + '\Path', StateKey, 'PathLegacyAmbiguous') and
    CopyHostToState('Chrome') and CopyHostToState('Brave') and CopyHostToState('Edge') and
    RegWriteStringValue(HKCU, StateKey, 'DesktopMode', Mode);
#ifdef FullInstall
  if Result and (Mode = 'full') then Result := CopyString(PendingKey + '\NotificationIdentity', StateKey, 'NotificationPackageFullName');
  if Result and (Mode = 'full') then Result := RecordEngineBundle(Root);
#endif
end;
function ValidateState(const Root: String): Boolean;
var
  Schema, Protocol: Cardinal;
  StateRoot, Manifest: String;
begin
  Result := RegQueryDWordValue(HKCU, StateKey, 'SchemaVersion', Schema) and (Schema = 1) and
    RegQueryDWordValue(HKCU, StateKey, 'ShutdownProtocolVersion', Protocol) and (Protocol = 1) and
    RegQueryStringValue(HKCU, StateKey, 'InstallRoot', StateRoot) and SamePath(StateRoot, Root) and
    RegQueryStringValue(HKCU, StateKey, 'OwnedManifestPath', Manifest) and
    SamePath(Manifest, AddBackslash(Root) + ManifestRelativePath);
end;
// LISTENING means a live daemon; post-stop TIME_WAIT sockets do not.
// Unreadable netstat output remains occupied.
function RuntimePortsOccupied: Boolean;
var
  Output: TExecOutput;
  ExitCode, I: Integer;
begin
  Result := True;
  if not ExecAndCaptureOutput(ExpandConstant('{sys}\netstat.exe'), '-ano -p tcp', '', SW_HIDE,
    ewWaitUntilTerminated, ExitCode, Output) or (ExitCode <> 0) or Output.Error then Exit;
  for I := 0 to GetArrayLength(Output.StdOut) - 1 do
    if (Pos('LISTENING', Output.StdOut[I]) > 0) and
       ((Pos(':19221 ', Output.StdOut[I]) > 0) or (Pos(':19222 ', Output.StdOut[I]) > 0)) then Exit;
  Result := False;
end;
function StopPriorDaemon(Hardened: Boolean): Boolean;
var
  CliPath: String;
  ExitCode: Integer;
begin
  Result := True;
  if not RuntimePortsOccupied then Exit;
  if not Hardened then
  begin
    SetupFailureText := 'A legacy Interceptor daemon is running. Close that daemon in Task Manager, then rerun Setup.';
    Result := False;
    Exit;
  end;
  CliPath := AddBackslash(PriorInstallRoot) + 'interceptor.exe';
  if not FileExists(CliPath) or
     not Exec(CliPath, 'daemon stop --reason installer --timeout 10000', PriorInstallRoot,
       SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) or RuntimePortsOccupied then
  begin
    SetupFailureText := 'Setup could not gracefully stop the verified Interceptor daemon. Close it in Task Manager, then retry.';
    Result := False;
  end;
end;
function ResolveExistingInstall: Boolean;
var
  Root32, Root64, Version32, Version64: String;
  PriorVersion, TargetVersion: Int64;
  Has32, Has64: Boolean;
begin
  Result := False;
  if RegKeyExists(HKLM32, ProductUninstallKey) or RegKeyExists(HKLM64, ProductUninstallKey) then
  begin
    SetupFailureText := 'A legacy administrator-mode Interceptor preview is installed. Remove that copy from Installed apps using an administrator account, then rerun this per-user installer.';
    Exit;
  end;
  Has32 := RegKeyExists(HKCU32, ProductUninstallKey);
  Has64 := RegKeyExists(HKCU64, ProductUninstallKey);
  if Has32 and (not RegQueryStringValue(HKCU32, ProductUninstallKey, 'InstallLocation', Root32) or
     not RegQueryStringValue(HKCU32, ProductUninstallKey, 'DisplayVersion', Version32)) then Exit;
  if Has64 and (not RegQueryStringValue(HKCU64, ProductUninstallKey, 'InstallLocation', Root64) or
     not RegQueryStringValue(HKCU64, ProductUninstallKey, 'DisplayVersion', Version64)) then Exit;
  if Has32 and Has64 and ((not SamePath(Root32, Root64)) or (Version32 <> Version64)) then Exit;
  if Has64 then begin PriorInstallRoot := Root64; PriorInstallVersion := Version64; end
  else if Has32 then begin PriorInstallRoot := Root32; PriorInstallVersion := Version32; end
  else begin PriorInstallRoot := ''; PriorInstallVersion := ''; end;
  PriorInstallPresent := PriorInstallRoot <> '';
  if PriorInstallPresent then
  begin
    if not IsStableVersion(PriorInstallVersion) or not PathIsRooted(PriorInstallRoot) then Exit;
    if not StrToVersion(PriorInstallVersion, PriorVersion) or
       not StrToVersion('{#AppVersion}', TargetVersion) then Exit;
    if ComparePackedVersion(PriorVersion, TargetVersion) > 0 then
    begin SetupFailureText := 'A newer Interceptor version is installed; downgrades are not supported.'; Exit; end;
  end;
  Result := True;
end;
function RecoverPending: Boolean;
var
  Schema, Committed: Cardinal;
  IdentityRoot: String;
begin
  Result := True;
  if not RegKeyExists(HKCU, PendingKey) then Exit;
#ifndef FullInstall
  if RegKeyExists(HKCU, PendingKey + '\NotificationIdentity') then begin Result := False; Exit; end;
#endif
  if not RegQueryDWordValue(HKCU, PendingKey, 'SchemaVersion', Schema) then
  begin
    RegDeleteKeyIfEmpty(HKCU, PendingKey);
    Result := not RegKeyExists(HKCU, PendingKey);
    Exit;
  end;
  if Schema <> 1 then begin Result := False; Exit; end;
  Committed := 0;
  RegQueryDWordValue(HKCU, PendingKey, 'Committed', Committed);
  if (Committed = 1) and
     RegQueryStringValue(HKCU, PendingKey + '\NotificationIdentity', 'Root', IdentityRoot) and
     not SamePath(IdentityRoot, PriorInstallRoot) then begin Result := False; Exit; end;
  if (Committed = 1) and CommitState(PriorInstallRoot) then
  begin
    if RegQueryStringValue(HKCU, PendingKey + '\NotificationIdentity', 'Root', IdentityRoot) and
       not NotificationIdentityAction('finalize', IdentityRoot) then begin Result := False; Exit; end;
    RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
    DeleteFile(GuardFilePath);
    Exit;
  end;
  if not RestorePending then begin Result := False; Exit; end;
  RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
  DeleteFile(GuardFilePath);
end;
function InitializeSetup: Boolean;
var SessionId: DWORD;
begin
  Result := False;
  GuardPath := GuardFilePath;
  if not IsStableVersion('{#AppVersion}') then Exit;
  if not ResolveExistingInstall then
  begin
    if SetupFailureText = '' then SetupFailureText := 'The existing Interceptor install record is malformed.';
    SuppressibleMsgBox(SetupFailureText, mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
  if not RecoverPending then begin SuppressibleMsgBox('An interrupted Interceptor install requires manual repair.', mbCriticalError, MB_OK, IDOK); Exit; end;
#ifndef FullInstall
  if DesktopIsInstalled then
  begin
    SuppressibleMsgBox('A Full native install is present. Use the Full installer to upgrade or repair it.', mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
#else
  if not ProcessIdToSessionId(GetCurrentProcessId, SessionId) or (SessionId = 0) then
  begin
    SuppressibleMsgBox('Full native installation requires the logged-in user''s interactive session. Session 0 is not supported.', mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
  if not DesktopStartupOwned(PriorInstallRoot) then
  begin
    SuppressibleMsgBox('A native provider or startup link is not owned by this installation. Setup will not replace it.', mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
  if not EngineBundleOwned(PriorInstallRoot) then
  begin
    SuppressibleMsgBox('The native engine bundle is foreign, modified or missing. Setup will preserve it.', mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
  if PriorInstallPresent and not NotificationIdentityAction('check', PriorInstallRoot) then
  begin
    SuppressibleMsgBox('The native notification identity is not owned by this installation. Setup will not replace it.', mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
#endif
  if (not PriorInstallPresent) and RuntimePortsOccupied then
  begin
    SuppressibleMsgBox('Ports 19221/19222 are already in use. Stop the other Interceptor or development instance and retry.', mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
  Result := True;
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Hardened: Boolean;
  ManifestPath: String;
begin
  Result := '';
  NeedsRestart := False;
  Hardened := RegKeyExists(HKCU, StateKey);
#ifdef FullInstall
  if not EngineBundleOwned(ExpandConstant('{app}')) then
  begin Result := 'The destination engine bundle is foreign, modified or missing; setup will preserve it.'; Exit; end;
  if (not DesktopIsInstalled) and FileExists(ExpandConstant('{app}\interceptor-desktop.exe')) then
  begin Result := 'An unowned native provider already exists in the destination.'; Exit; end;
  if (not RegValueExists(HKCU, StateKey, 'NotificationPackageFullName')) and
     FileExists(ExpandConstant('{app}\interceptor-notification-badge.exe')) then
  begin Result := 'An unowned badge helper already exists in the destination.'; Exit; end;
  if (not DesktopIsInstalled) and FileExists(ExpandConstant('{app}\interceptor-contacts-native.exe')) then
  begin Result := 'An unowned Contacts helper already exists in the destination.'; Exit; end;
#endif
  if Hardened and ((not PriorInstallPresent) or (not ValidateState(PriorInstallRoot))) then
  begin Result := 'The existing Interceptor ownership state is malformed.'; Exit; end;
  RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
  RegWriteDWordValue(HKCU, PendingKey, 'SchemaVersion', 1);
  RegWriteDWordValue(HKCU, PendingKey, 'Committed', 0);
  RegWriteStringValue(HKCU, PendingKey, 'DesktopMode', '{#InstallMode}');
  ManifestPath := ExpandConstant('{app}\' + ManifestRelativePath);
  if not CapturePath(ExpandConstant('{app}'), Hardened) or
     not CaptureHost('Chrome', ChromeHostKey, ManifestPath, Hardened) or
     not CaptureHost('Brave', BraveHostKey, ManifestPath, Hardened) or
     not CaptureHost('Edge', EdgeHostKey, ManifestPath, Hardened) then
  begin RegDeleteKeyIncludingSubkeys(HKCU, PendingKey); Result := SetupFailureText; Exit; end;
  TransactionId := NewTransactionId;
#ifdef FullInstall
  if not NotificationIdentityAction('prepare', ExpandConstant('{app}')) then
  begin
    if RestorePending then RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
    Result := 'Setup could not prepare the owned notification identity transaction.';
    Exit;
  end;
#endif
  if not CreateGuard then
  begin
    if RestorePending then RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
    Result := 'Setup could not create its maintenance guard.';
    Exit;
  end;
  TransactionPrepared := True;
  RegDeleteValue(HKCU, ChromeHostKey, '');
  RegDeleteValue(HKCU, BraveHostKey, '');
  RegDeleteValue(HKCU, EdgeHostKey, '');
  if PriorInstallPresent and not StopPriorDaemon(Hardened) then begin Result := SetupFailureText; Exit; end;
  if PriorInstallPresent and not StopPriorDesktop(PriorInstallRoot) then begin Result := SetupFailureText; Exit; end;
end;
procedure CurStepChanged(CurStep: TSetupStep);
var
  Intended, ManifestPath: String;
  ValueType: Cardinal;
begin
  if CurStep = ssInstall then
  begin
    if not RegQueryStringValue(HKCU, PendingKey + '\Path', 'IntendedValue', Intended) or
       not RegQueryDWordValue(HKCU, PendingKey + '\Path', 'PriorType', ValueType) or
       not WriteStringByType(EnvironmentKey, 'Path', Intended, ValueType) then Abort;
  end
  else if CurStep = ssPostInstall then
  begin
#ifdef FullInstall
    if not NotificationIdentityAction('install', ExpandConstant('{app}')) then Abort;
#endif
    ManifestPath := ExpandConstant('{app}\' + ManifestRelativePath);
    if not FileExists(ManifestPath) or
       not RegWriteStringValue(HKCU, ChromeHostKey, '', ManifestPath) or
       not RegWriteStringValue(HKCU, BraveHostKey, '', ManifestPath) or
       not RegWriteStringValue(HKCU, EdgeHostKey, '', ManifestPath) then Abort;
    RegWriteDWordValue(HKCU, PendingKey, 'Committed', 1);
    if not CommitState(ExpandConstant('{app}')) then Abort;
    InstallCommitted := True;
  end
  else if CurStep = ssDone then
  begin
#ifdef FullInstall
    if not NotificationIdentityAction('finalize', ExpandConstant('{app}')) then Abort;
#endif
    RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
    DeleteFile(GuardPath);
  end;
end;
procedure DeinitializeSetup;
begin
  if TransactionPrepared and (not InstallCommitted) then
  begin
    if RestorePending then RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
    DeleteFile(GuardPath);
  end;
end;
function RemoveOwnedPath: Boolean;
var
  Added, ValueType, PriorExists: Cardinal;
  Target, Current, Rebuilt: String;
  Tokens: TArrayOfString;
  I, J: Integer;
begin
  Result := False;
  if not RegQueryDWordValue(HKCU, StateKey, 'PathAdded', Added) then Exit;
  if Added = 0 then begin Result := True; Exit; end;
  if not RegQueryStringValue(HKCU, StateKey, 'PathToken', Target) then Exit;
  if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Current) then begin Result := True; Exit; end;
  if CountPathTokens(Current, Target) <> 1 then begin Result := True; Exit; end;
  Tokens := StringSplit(Current, [';'], stAll);
  for I := 0 to GetArrayLength(Tokens) - 1 do
    if CompareText(NormalizePathToken(Tokens[I]), NormalizePathToken(Target)) = 0 then
    begin
      for J := I to GetArrayLength(Tokens) - 2 do Tokens[J] := Tokens[J + 1];
      SetArrayLength(Tokens, GetArrayLength(Tokens) - 1);
      Break;
    end;
  Rebuilt := StringJoin(';', Tokens);
  if not RegQueryDWordValue(HKCU, StateKey, 'PathOriginalType', ValueType) or
     not RegQueryDWordValue(HKCU, StateKey, 'PathPriorExists', PriorExists) then Exit;
  if (PriorExists = 0) and (Rebuilt = '') then begin RegDeleteValue(HKCU, EnvironmentKey, 'Path'); Result := True; end
  else Result := WriteStringByType(EnvironmentKey, 'Path', Rebuilt, ValueType);
end;
// Non-destructive only. Inno calls this BEFORE the uninstall confirmation
// prompt, so anything mutated here survives the user answering "No".
function InitializeUninstall: Boolean;
begin
  Result := False;
  if not ResolveExistingInstall then Exit;
  if not RecoverPending then Exit;
  if not ValidateState(ExpandConstant('{app}')) then
  begin SuppressibleMsgBox('Interceptor ownership state is missing or malformed; repair before uninstalling.', mbCriticalError, MB_OK, IDOK); Exit; end;
  Result := True;
end;
// Owned-state teardown runs at usUninstall: after the confirmation prompt but
// still before Inno deletes the payload, so the CLI and skill packs exist.
function UninstallOwnedState: Boolean;
var
  Root, CliPath: String;
  ExitCode: Integer;
begin
  Result := False;
  Root := ExpandConstant('{app}');
  if not ValidateState(Root) then
  begin SuppressibleMsgBox('Interceptor ownership state is missing or malformed; repair before uninstalling.', mbCriticalError, MB_OK, IDOK); Exit; end;
  if not DesktopStartupOwned(Root) or not EngineBundleOwned(Root) or not NotificationIdentityAction('check', Root) or
     not StopPriorDesktop(Root) then
  begin SuppressibleMsgBox('The native provider or startup link changed ownership. Uninstall has stopped without removing it.', mbCriticalError, MB_OK, IDOK); Exit; end;
  TransactionId := NewTransactionId;
  PriorInstallRoot := Root;
  if not CreateGuard then Exit;
  CliPath := AddBackslash(Root) + 'interceptor.exe';
  if not FileExists(CliPath) or
     not Exec(CliPath, 'daemon stop --reason installer --timeout 10000', Root, SW_HIDE, ewWaitUntilTerminated, ExitCode) or
     (ExitCode <> 0) then
  begin SuppressibleMsgBox('The Interceptor daemon could not be stopped.', mbCriticalError, MB_OK, IDOK); Exit; end;
  if not Exec(CliPath, 'skills unadopt --all --owned-root "' + AddBackslash(Root) + 'skills"', Root,
     SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
  begin SuppressibleMsgBox('Owned skill links could not be removed safely.', mbCriticalError, MB_OK, IDOK); Exit; end;
  if not RestoreHost(StateKey, 'Chrome', ChromeHostKey, True) or
     not RestoreHost(StateKey, 'Brave', BraveHostKey, True) or
     not RestoreHost(StateKey, 'Edge', EdgeHostKey, True) or not RemoveOwnedPath then
  begin SuppressibleMsgBox('Owned registry or PATH cleanup failed.', mbCriticalError, MB_OK, IDOK); Exit; end;
  if not NotificationIdentityAction('remove', Root) then
  begin SuppressibleMsgBox('The native notification identity changed ownership. Uninstall has stopped without removing it.', mbCriticalError, MB_OK, IDOK); Exit; end;
  Result := True;
end;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    if not UninstallOwnedState then Abort;
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    RegDeleteKeyIncludingSubkeys(HKCU, StateKey);
    RegDeleteKeyIfEmpty(HKCU, InstallerRoot);
    RegDeleteKeyIfEmpty(HKCU, 'Software\Hacker Valley Media\Interceptor');
    DeleteFile(GuardPath);
  end;
end;
// Clear the blocking guard after every uninstall exit, including abort, cancel and failed teardown.
procedure DeinitializeUninstall;
begin
  DeleteFile(GuardFilePath);
end;
