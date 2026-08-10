; Interceptor browser-only Windows installer.
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

#define ProductGuid "B7F4D8A1-3E22-4B91-A6E4-9C2D5F8A1234"
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
AppVerName=Interceptor (Browser-Only) {#AppVersion}
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
OutputBaseFilename=Interceptor-Browser-{#AppVersion}-windows-{#ArtifactArch}{#ArtifactSuffix}
UninstallLogMode=overwrite
UninstallDisplayIcon={app}\interceptor.ico
UninstallDisplayName=Interceptor (Browser-Only)
VersionInfoVersion={#AppVersion}
VersionInfoCompany=Hacker Valley Media
VersionInfoDescription=Interceptor Browser-Only Setup
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
SignTool=InterceptorSign
#else
SignedUninstaller=no
#endif

[Files]
Source: "{#StageDir}\interceptor.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\interceptor.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\daemon\interceptor-daemon.exe"; DestDir: "{app}\daemon"; Flags: ignoreversion
Source: "{#StageDir}\daemon\com.interceptor.host.json"; DestDir: "{app}\daemon"; Flags: ignoreversion
; Unpacked browser extension dropped on disk so the user has one stable place to
; point "Load unpacked" (Developer mode). Setup still never touches a browser
; profile or loads it automatically — it only stages the files.
Source: "{#StageDir}\extension\*"; DestDir: "{app}\extension"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\.agents\skills\interceptor\*"; DestDir: "{app}\skills\interceptor"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\.agents\skills\interceptor-browser\*"; DestDir: "{app}\skills\interceptor-browser"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\.agents\skills\interceptor-research\*"; DestDir: "{app}\skills\interceptor-research"; Excludes: "._*"; Flags: ignoreversion recursesubdirs createallsubdirs

[UninstallDelete]
; recursesubdirs leaves the extension's (empty) subdir tree behind on uninstall;
; remove the whole staged extension folder explicitly. filesandordirs also clears
; anything a user dropped in — the browser only reads from here, never writes.
Type: filesandordirs; Name: "{app}\extension"

[Run]
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

function IsStableVersion(const Value: String): Boolean;
var
  I, Dots, SegmentStart, SegmentLength: Integer;
  C: Char;
begin
  Result := False;
  if Length(Value) < 5 then Exit;
  Dots := 0;
  SegmentStart := 1;
  for I := 1 to Length(Value) do
  begin
    C := Value[I];
    if C = '.' then
    begin
      SegmentLength := I - SegmentStart;
      if (SegmentLength < 1) or ((SegmentLength > 1) and (Value[SegmentStart] = '0')) then Exit;
      Dots := Dots + 1;
      SegmentStart := I + 1;
    end
    else if (C < '0') or (C > '9') then Exit;
  end;
  SegmentLength := Length(Value) - SegmentStart + 1;
  Result := (Dots = 2) and (SegmentLength > 0) and
    ((SegmentLength = 1) or (Value[SegmentStart] <> '0'));
end;

function VersionPart(const Value: String; Index: Integer): Integer;
var
  I, PartIndex, StartAt: Integer;
begin
  Result := 0;
  PartIndex := 0;
  StartAt := 1;
  for I := 1 to Length(Value) + 1 do
    if (I > Length(Value)) or (Value[I] = '.') then
    begin
      if PartIndex = Index then
      begin
        Result := StrToIntDef(Copy(Value, StartAt, I - StartAt), 0);
        Exit;
      end;
      PartIndex := PartIndex + 1;
      StartAt := I + 1;
    end;
end;

function CompareVersions(const LeftValue, RightValue: String): Integer;
var
  I, L, R: Integer;
begin
  Result := 0;
  for I := 0 to 2 do
  begin
    L := VersionPart(LeftValue, I);
    R := VersionPart(RightValue, I);
    if L < R then begin Result := -1; Exit; end;
    if L > R then begin Result := 1; Exit; end;
  end;
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

function NewTransactionId: String;
var
  Hash: String;
begin
  Hash := Lowercase(GetSHA256OfString(GetUserNameString + '|' +
    GetDateTimeString('yyyy-mm-dd hh:nn:ss.zzz', '-', ':') + '|' + IntToStr(Random(2147483647))));
  Result := Copy(Hash, 1, 8) + '-' + Copy(Hash, 9, 4) + '-4' + Copy(Hash, 14, 3) +
    '-8' + Copy(Hash, 18, 3) + '-' + Copy(Hash, 21, 12);
end;

function GuardFilePath: String;
begin
  Result := AddBackslash(GetEnv('TEMP')) + GuardFileName;
end;

function CurrentUserSid: String;
var
  OutputPath, Params: String;
  Output: AnsiString;
  ExitCode, StartAt, EndAt: Integer;
begin
  Result := '';
  OutputPath := ExpandConstant('{tmp}\interceptor-whoami.txt');
  Params := '/D /S /C ""' + ExpandConstant('{sys}\whoami.exe') +
    '" /USER /FO CSV /NH > "' + OutputPath + '""';
  if not Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or
     (ExitCode <> 0) or (not LoadStringFromFile(OutputPath, Output)) then Exit;
  DeleteFile(OutputPath);
  StartAt := Pos('S-1-', Output);
  if StartAt = 0 then Exit;
  EndAt := StartAt;
  while (EndAt <= Length(Output)) and
    (((Output[EndAt] >= '0') and (Output[EndAt] <= '9')) or
     (Output[EndAt] = '-') or (Output[EndAt] = 'S')) do EndAt := EndAt + 1;
  Result := Copy(Output, StartAt, EndAt - StartAt);
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
    // T and Z must stay quoted: GetDateTimeString reads them as the short-time
    // and millisecond specifiers, which yields a value Date.parse rejects.
    '","createdAt":"' + GetDateTimeString('yyyy-mm-dd''T''hh:nn:ss.zzz''Z''', '-', ':') + '"}' + #13#10;
  if not SaveStringToFile(GuardPath, Json, False) then Exit;
  Params := '"' + GuardPath + '" /inheritance:r /grant:r "*' + Sid + ':(F)"';
  if not Exec(ExpandConstant('{sys}\icacls.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or
     (ExitCode <> 0) then begin DeleteFile(GuardPath); Exit; end;
  Result := True;
end;

function QueryRegistryType(const SubKey, ValueName: String): Integer;
var
  OutputPath, Params, ValueArg: String;
  Output: AnsiString;
  ExitCode: Integer;
begin
  Result := 0;
  OutputPath := ExpandConstant('{tmp}\interceptor-regtype.txt');
  if ValueName = '' then ValueArg := '/VE' else ValueArg := '/V "' + ValueName + '"';
  Params := '/D /S /C ""' + ExpandConstant('{sys}\reg.exe') + '" QUERY "HKCU\' +
    SubKey + '" ' + ValueArg + ' > "' + OutputPath + '" 2>NUL"';
  if not Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or
     (ExitCode <> 0) or (not LoadStringFromFile(OutputPath, Output)) then Exit;
  DeleteFile(OutputPath);
  if Pos('REG_EXPAND_SZ', Output) > 0 then Result := RegTypeExpandSz
  else if Pos('REG_SZ', Output) > 0 then Result := RegTypeSz;
end;

function WriteStringByType(const SubKey, Name, Value: String; ValueType: Cardinal): Boolean;
begin
  if ValueType = RegTypeSz then Result := RegWriteStringValue(HKCU, SubKey, Name, Value)
  else if ValueType = RegTypeExpandSz then Result := RegWriteExpandStringValue(HKCU, SubKey, Name, Value)
  else Result := False;
end;

function ExpandPercentVariables(const Value: String): String;
var
  SearchAt, RelativeStart, RelativeEnd, StartAt, EndAt: Integer;
  Name, Replacement: String;
begin
  Result := Value;
  SearchAt := 1;
  while SearchAt <= Length(Result) do
  begin
    RelativeStart := Pos('%', Copy(Result, SearchAt, Length(Result)));
    if RelativeStart = 0 then Exit;
    StartAt := SearchAt + RelativeStart - 1;
    RelativeEnd := Pos('%', Copy(Result, StartAt + 1, Length(Result)));
    if RelativeEnd = 0 then Exit;
    EndAt := StartAt + RelativeEnd;
    Name := Copy(Result, StartAt + 1, EndAt - StartAt - 1);
    Replacement := GetEnv(Name);
    if Replacement <> '' then
    begin
      Result := Copy(Result, 1, StartAt - 1) + Replacement +
        Copy(Result, EndAt + 1, Length(Result));
      SearchAt := StartAt + Length(Replacement);
    end
    else SearchAt := EndAt + 1;
  end;
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
  I, StartAt: Integer;
begin
  Result := 0;
  StartAt := 1;
  for I := 1 to Length(RawPath) + 1 do
    if (I > Length(RawPath)) or (RawPath[I] = ';') then
    begin
      if CompareText(NormalizePathToken(Copy(RawPath, StartAt, I - StartAt)),
         NormalizePathToken(Target)) = 0 then Result := Result + 1;
      StartAt := I + 1;
    end;
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
  RegWriteStringValue(HKCU, DestKey, 'OwnedValue', OwnedValue);
  if Hardened then
  begin
    SourceKey := StateKey + '\NativeHosts\' + Name;
    if not RegQueryStringValue(HKCU, SourceKey, 'OwnedValue', PriorValue) or
       not RegQueryStringValue(HKCU, SubKey, '', Current) or
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

  RegWriteDWordValue(HKCU, DestKey, 'KeyPriorExists', Ord(RegKeyExists(HKCU, SubKey)));
  if not RegValueExists(HKCU, SubKey, '') then
  begin
    RegWriteDWordValue(HKCU, DestKey, 'PriorOrigin', 0);
    RegWriteDWordValue(HKCU, DestKey, 'PriorType', 0);
    RegWriteStringValue(HKCU, DestKey, 'PriorValue', '');
    Result := True;
    Exit;
  end;
  ValueType := QueryRegistryType(SubKey, '');
  if ((ValueType <> RegTypeSz) and (ValueType <> RegTypeExpandSz)) or
     not RegQueryStringValue(HKCU, SubKey, '', Current) then
  begin
    SetupFailureText := 'Setup refused an unsupported native-host default value type.';
    Exit;
  end;
  if PriorInstallPresent and
     SamePath(Current, AddBackslash(PriorInstallRoot) + 'com.interceptor.host.json') then Value := 2
  else Value := 1;
  RegWriteDWordValue(HKCU, DestKey, 'PriorOrigin', Value);
  if Value = 1 then
  begin
    RegWriteDWordValue(HKCU, DestKey, 'PriorType', ValueType);
    RegWriteStringValue(HKCU, DestKey, 'PriorValue', Current);
  end
  else
  begin
    RegWriteDWordValue(HKCU, DestKey, 'PriorType', 0);
    RegWriteStringValue(HKCU, DestKey, 'PriorValue', '');
  end;
  Result := True;
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
    else if Current[Length(Current)] = ';' then Intended := Current + Target
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
  HostKey, Owned, Current, PriorValue: String;
  PriorOrigin, PriorType, KeyPriorExists: Cardinal;
begin
  Result := False;
  HostKey := SourceKey + '\NativeHosts\' + Name;
  if not RegQueryStringValue(HKCU, HostKey, 'OwnedValue', Owned) then Exit;
  Current := '';
  if Conditional and RegQueryStringValue(HKCU, SubKey, '', Current) and
     (CompareText(Current, Owned) <> 0) then begin Result := True; Exit; end;
  if not RegQueryDWordValue(HKCU, HostKey, 'PriorOrigin', PriorOrigin) then Exit;
  if PriorOrigin = 1 then
  begin
    if not RegQueryDWordValue(HKCU, HostKey, 'PriorType', PriorType) or
       not RegQueryStringValue(HKCU, HostKey, 'PriorValue', PriorValue) then Exit;
    Result := WriteStringByType(SubKey, '', PriorValue, PriorType);
  end
  else
  begin
    RegDeleteValue(HKCU, SubKey, '');
    Result := True;
  end;
  if Result and RegQueryDWordValue(HKCU, HostKey, 'KeyPriorExists', KeyPriorExists) and
     (KeyPriorExists = 0) then RegDeleteKeyIfEmpty(HKCU, SubKey);
end;

function RestorePending: Boolean;
var
  PriorExists, PriorType: Cardinal;
  PriorValue, Intended, Current: String;
begin
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

function CommitState: Boolean;
begin
  RegWriteDWordValue(HKCU, StateKey, 'SchemaVersion', 1);
  RegWriteStringValue(HKCU, StateKey, 'InstalledVersion', '{#AppVersion}');
  RegWriteStringValue(HKCU, StateKey, 'InstallRoot', ExpandConstant('{app}'));
  RegWriteStringValue(HKCU, StateKey, 'OwnedManifestPath', ExpandConstant('{app}\' + ManifestRelativePath));
  RegWriteDWordValue(HKCU, StateKey, 'ShutdownProtocolVersion', 1);
  RegWriteDWordValue(HKCU, StateKey, 'UninstallLogGeneration', 1);
  Result := CopyDword(PendingKey + '\Path', StateKey, 'PathAdded') and
    CopyString(PendingKey + '\Path', StateKey, 'PathToken') and
    CopyDword(PendingKey + '\Path', StateKey, 'PathOriginalType') and
    CopyDword(PendingKey + '\Path', StateKey, 'PathPriorExists') and
    CopyDword(PendingKey + '\Path', StateKey, 'PathLegacyAmbiguous') and
    CopyHostToState('Chrome') and CopyHostToState('Brave') and CopyHostToState('Edge');
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

// Only a LISTENING socket means a live daemon. `daemon stop` leaves its own
// probe sockets in TIME_WAIT on both ports for minutes, so matching any state
// made every upgrade-with-running-daemon fail its own post-stop recheck.
// Stays fail-closed: an unreadable netstat still reports "occupied".
function RuntimePortsOccupied: Boolean;
var
  OutputPath, Params: String;
  Lines: TArrayOfString;
  ExitCode, I: Integer;
begin
  Result := True;
  OutputPath := ExpandConstant('{tmp}\interceptor-netstat.txt');
  Params := '/D /S /C ""' + ExpandConstant('{sys}\netstat.exe') +
    '" -ano -p tcp > "' + OutputPath + '""';
  if Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and
     (ExitCode = 0) and LoadStringsFromFile(OutputPath, Lines) then
  begin
    Result := False;
    for I := 0 to GetArrayLength(Lines) - 1 do
      if (Pos('LISTENING', Lines[I]) > 0) and
         ((Pos(':19221 ', Lines[I]) > 0) or (Pos(':19222 ', Lines[I]) > 0)) then
      begin
        Result := True;
        Break;
      end;
  end;
  DeleteFile(OutputPath);
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
    if CompareVersions(PriorInstallVersion, '{#AppVersion}') > 0 then
    begin SetupFailureText := 'A newer Interceptor version is installed; downgrades are not supported.'; Exit; end;
  end;
  Result := True;
end;

function RecoverPending: Boolean;
var
  Schema, Committed: Cardinal;
begin
  Result := True;
  if not RegKeyExists(HKCU, PendingKey) then Exit;
  if not RegQueryDWordValue(HKCU, PendingKey, 'SchemaVersion', Schema) then
  begin
    RegDeleteKeyIfEmpty(HKCU, PendingKey);
    Result := not RegKeyExists(HKCU, PendingKey);
    Exit;
  end;
  if Schema <> 1 then begin Result := False; Exit; end;
  Committed := 0;
  RegQueryDWordValue(HKCU, PendingKey, 'Committed', Committed);
  if (Committed = 1) and CommitState then
  begin
    RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
    DeleteFile(GuardFilePath);
    Exit;
  end;
  if not RestorePending then begin Result := False; Exit; end;
  RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
  DeleteFile(GuardFilePath);
end;

function InitializeSetup: Boolean;
begin
  Result := False;
  GuardPath := GuardFilePath;
  if not IsStableVersion('{#AppVersion}') then Exit;
  if not RecoverPending then begin SuppressibleMsgBox('An interrupted Interceptor install requires manual repair.', mbCriticalError, MB_OK, IDOK); Exit; end;
  if not ResolveExistingInstall then
  begin
    if SetupFailureText = '' then SetupFailureText := 'The existing Interceptor install record is malformed.';
    SuppressibleMsgBox(SetupFailureText, mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
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
  if Hardened and ((not PriorInstallPresent) or (not ValidateState(PriorInstallRoot))) then
  begin Result := 'The existing Interceptor ownership state is malformed.'; Exit; end;
  RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
  RegWriteDWordValue(HKCU, PendingKey, 'SchemaVersion', 1);
  RegWriteDWordValue(HKCU, PendingKey, 'Committed', 0);
  ManifestPath := ExpandConstant('{app}\' + ManifestRelativePath);
  if not CapturePath(ExpandConstant('{app}'), Hardened) or
     not CaptureHost('Chrome', ChromeHostKey, ManifestPath, Hardened) or
     not CaptureHost('Brave', BraveHostKey, ManifestPath, Hardened) or
     not CaptureHost('Edge', EdgeHostKey, ManifestPath, Hardened) then
  begin RegDeleteKeyIncludingSubkeys(HKCU, PendingKey); Result := SetupFailureText; Exit; end;
  TransactionId := NewTransactionId;
  if not CreateGuard then begin RegDeleteKeyIncludingSubkeys(HKCU, PendingKey); Result := 'Setup could not create its maintenance guard.'; Exit; end;
  TransactionPrepared := True;
  RegDeleteValue(HKCU, ChromeHostKey, '');
  RegDeleteValue(HKCU, BraveHostKey, '');
  RegDeleteValue(HKCU, EdgeHostKey, '');
  if PriorInstallPresent and not StopPriorDaemon(Hardened) then begin Result := SetupFailureText; Exit; end;
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
    ManifestPath := ExpandConstant('{app}\' + ManifestRelativePath);
    if not FileExists(ManifestPath) or
       not RegWriteStringValue(HKCU, ChromeHostKey, '', ManifestPath) or
       not RegWriteStringValue(HKCU, BraveHostKey, '', ManifestPath) or
       not RegWriteStringValue(HKCU, EdgeHostKey, '', ManifestPath) then Abort;
    RegWriteDWordValue(HKCU, PendingKey, 'Committed', 1);
    if not CommitState then Abort;
    InstallCommitted := True;
  end
  else if CurStep = ssDone then
  begin
    RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
    DeleteFile(GuardPath);
  end;
end;

procedure DeinitializeSetup;
begin
  if TransactionPrepared and (not InstallCommitted) then
  begin
    RestorePending;
    RegDeleteKeyIncludingSubkeys(HKCU, PendingKey);
    DeleteFile(GuardPath);
  end;
end;

function RemoveOwnedPath: Boolean;
var
  Added, ValueType, PriorExists: Cardinal;
  Target, Current, Token, Rebuilt: String;
  I, StartAt, RemoveStart, RemoveEnd: Integer;
begin
  Result := False;
  if not RegQueryDWordValue(HKCU, StateKey, 'PathAdded', Added) then Exit;
  if Added = 0 then begin Result := True; Exit; end;
  if not RegQueryStringValue(HKCU, StateKey, 'PathToken', Target) then Exit;
  if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Current) then begin Result := True; Exit; end;
  if CountPathTokens(Current, Target) <> 1 then begin Result := True; Exit; end;
  StartAt := 1; RemoveStart := 0; RemoveEnd := 0;
  for I := 1 to Length(Current) + 1 do
    if (I > Length(Current)) or (Current[I] = ';') then
    begin
      Token := Copy(Current, StartAt, I - StartAt);
      if CompareText(NormalizePathToken(Token), NormalizePathToken(Target)) = 0 then
      begin
        RemoveStart := StartAt;
        if I <= Length(Current) then RemoveEnd := I
        else if StartAt > 1 then begin RemoveStart := StartAt - 1; RemoveEnd := Length(Current); end
        else RemoveEnd := Length(Current);
      end;
      StartAt := I + 1;
    end;
  Rebuilt := Copy(Current, 1, RemoveStart - 1) + Copy(Current, RemoveEnd + 1, Length(Current));
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

// The guard blocks every CLI/daemon start, so no uninstall exit path may leave
// it behind — including abort, cancel, and a failed owned-state teardown.
procedure DeinitializeUninstall;
begin
  DeleteFile(GuardFilePath);
end;
