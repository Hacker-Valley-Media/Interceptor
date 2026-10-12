// Native desktop startup and engine ownership policy, included inside [Code].
function DesktopStartupOwned(const Root: String): Boolean;
var
  Shell, Link, FolderShell, Item: Variant;
  Path, Server, AppId, Target: String;
  I: Integer;
begin
  Result := False;
  try
    Shell := CreateOleObject('WScript.Shell');
    for I := 0 to 2 do
    begin
      Target := AddBackslash(Root) + 'interceptor-desktop.exe';
      if I = 0 then Path := ExpandConstant('{userstartup}\Interceptor Desktop {#ProductGuid}.lnk')
      else if I = 1 then Path := ExpandConstant('{userprograms}\Interceptor Desktop {#ProductGuid}.lnk')
      else
      begin
        Path := ExpandConstant('{userprograms}\Interceptor Badge {#ProductGuid}.lnk');
        Target := AddBackslash(Root) + 'interceptor-notification-badge.exe';
      end;
      if FileExists(Path) then
      begin
        if not DesktopIsInstalled then Exit;
        Link := Shell.CreateShortcut(Path);
        if not SamePath(Link.TargetPath, Target) or (Link.Arguments <> '') then Exit;
        if I > 0 then
        begin
          FolderShell := CreateOleObject('Shell.Application');
          Item := FolderShell.NameSpace(ExtractFileDir(Path)).ParseName(ExtractFileName(Path));
          AppId := Item.ExtendedProperty('System.AppUserModel.ID');
          if I = 1 then
          begin
            if (CompareStr(AppId, '{#NotificationAppId}') <> 0) or
              (CompareText(Item.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID'), '{{#NotificationActivator}}') <> 0) then Exit;
          end
          else if (not RegValueExists(HKCU, StateKey, 'NotificationPackageFullName')) or
            (CompareStr(AppId, '{#BadgeAppId}') <> 0) then Exit;
        end;
      end;
    end;
    if RegValueExists(HKCU, 'Software\Classes\CLSID\{{#NotificationActivator}}\LocalServer32', '') then
    begin
      if not DesktopIsInstalled or not RegQueryStringValue(HKCU, 'Software\Classes\CLSID\{{#NotificationActivator}}\LocalServer32', '', Server) or
        (CompareText(Server, '"' + AddBackslash(Root) + 'interceptor-desktop.exe" --toast-activated') <> 0) then Exit;
    end;
    Result := True;
  except Result := False;
  end;
end;
function EnginePayloadValid(const Root: String): Boolean;
var Provider, Directory: String; ExitCode: Integer;
begin
  Directory := AddBackslash(Root) + 'engines';
  Provider := AddBackslash(Root) + 'interceptor-desktop.exe';
  Result := FileExists(Provider) and
    Exec(Provider, '--engines-check "' + Directory + '"', Root, SW_HIDE,
      ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;
function EngineBundleOwned(const Root: String): Boolean;
var Directory, Manifest, Provider, StateRoot, ManifestHash, ProviderHash: String;
    Schema: Cardinal;
begin
  Result := False;
  if Root = '' then begin Result := True; Exit; end;
  if not PathIsRooted(Root) then Exit;
  Directory := AddBackslash(Root) + 'engines';
  if not DirExists(Directory) then
  begin
    Result := not FileExists(Directory) and not RegValueExists(HKCU, StateKey, 'EngineSchemaVersion');
    Exit;
  end;
  Manifest := AddBackslash(Directory) + 'manifest.json';
  Provider := AddBackslash(Root) + 'interceptor-desktop.exe';
  try
    Result := DesktopIsInstalled and
      RegQueryStringValue(HKCU, StateKey, 'InstallRoot', StateRoot) and SamePath(StateRoot, Root) and
      RegQueryDWordValue(HKCU, StateKey, 'EngineSchemaVersion', Schema) and (Schema = 1) and
      RegQueryStringValue(HKCU, StateKey, 'EngineManifestSHA256', ManifestHash) and
      RegQueryStringValue(HKCU, StateKey, 'EngineProviderSHA256', ProviderHash) and
      FileExists(Manifest) and FileExists(Provider) and
      (Lowercase(GetSHA256OfFile(Manifest)) = ManifestHash) and
      (Lowercase(GetSHA256OfFile(Provider)) = ProviderHash) and EnginePayloadValid(Root);
  except Result := False;
  end;
end;
function RecordEngineBundle(const Root: String): Boolean;
var Directory, Manifest, Provider: String;
begin
  Result := False;
  Directory := AddBackslash(Root) + 'engines';
  if not DirExists(Directory) then
  begin
    // [InstallDelete] removed the prior owned bundle; a payload that ships none drops its record.
    RegDeleteValue(HKCU, StateKey, 'EngineSchemaVersion');
    RegDeleteValue(HKCU, StateKey, 'EngineManifestSHA256');
    RegDeleteValue(HKCU, StateKey, 'EngineProviderSHA256');
    Result := not FileExists(Directory) and not RegValueExists(HKCU, StateKey, 'EngineSchemaVersion');
    Exit;
  end;
  if not EnginePayloadValid(Root) then Exit;
  Manifest := AddBackslash(Directory) + 'manifest.json';
  Provider := AddBackslash(Root) + 'interceptor-desktop.exe';
  try
    Result := RegWriteDWordValue(HKCU, StateKey, 'EngineSchemaVersion', 1) and
      RegWriteStringValue(HKCU, StateKey, 'EngineManifestSHA256', Lowercase(GetSHA256OfFile(Manifest))) and
      RegWriteStringValue(HKCU, StateKey, 'EngineProviderSHA256', Lowercase(GetSHA256OfFile(Provider)));
  except Result := False;
  end;
end;
function StopPriorDesktop(const Root: String): Boolean;
var
  Helper: String;
  ExitCode: Integer;
begin
  Result := True;
  if not DesktopIsInstalled then Exit;
  Helper := AddBackslash(Root) + 'interceptor-desktop.exe';
  Result := FileExists(Helper) and Exec(Helper, '--stop', Root, SW_HIDE,
    ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
  if not Result then SetupFailureText := 'The owned native desktop provider could not be stopped in this login session.';
end;
