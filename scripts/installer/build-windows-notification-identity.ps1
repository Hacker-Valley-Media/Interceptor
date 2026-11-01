param(
  [Parameter(Mandatory=$true)][string]$StageDir,
  [Parameter(Mandatory=$true)][string]$SdkBin,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Arch
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or @($Version.Split('.') | Where-Object {[long]$_ -gt 65535}).Count){throw 'Invalid notification identity version'}
# Sparse external-location package identities work on Windows 10 build 19041+.
# ARM64 keeps the existing Windows 11 24H2 requirement.
$minVersion=if($Arch -eq 'x64'){'10.0.19041.0'}else{'10.0.26100.0'}
$stage=(Resolve-Path -LiteralPath $StageDir).Path
$sdk=(Resolve-Path -LiteralPath $SdkBin).Path
$exe=Join-Path $stage 'desktop\interceptor-notification-badge.exe'
if((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'NotSigned'){throw 'Embed identity before signing the badge helper'}
$provider=Join-Path $stage 'desktop\interceptor-desktop.exe'
$contacts=Join-Path $stage 'desktop\interceptor-contacts-native.exe'
if((Get-AuthenticodeSignature -LiteralPath $provider).Status -ne 'NotSigned'){throw 'Stage Contacts from the unsigned provider before signing'}
if(Test-Path -LiteralPath $contacts){throw 'Contacts identity output already exists'}
Copy-Item -LiteralPath $provider -Destination $contacts
$executables=@(@{id='Desktop';path=$exe},@{id='Contacts';path=$contacts})
foreach($application in $executables){
$exeToCheck=$application.path
$reader=New-Object IO.BinaryReader([IO.File]::OpenRead($exeToCheck))
try {
  if($reader.ReadUInt16() -ne 0x5a4d){throw 'Native provider is not a PE executable'}
  $reader.BaseStream.Position=0x3c;$offset=$reader.ReadUInt32();$reader.BaseStream.Position=$offset
  if($reader.ReadUInt32() -ne 0x4550){throw 'Native provider has no PE signature'}
  $machine=$reader.ReadUInt16();$expected=if($Arch -eq 'arm64'){0xaa64}else{0x8664}
  if($machine -ne $expected){throw 'Native provider architecture mismatch'}
} finally {$reader.Dispose()}
}
foreach($tool in @('mt.exe','makeappx.exe')){
  $signature=Get-AuthenticodeSignature -LiteralPath (Join-Path $sdk $tool)
  if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike 'CN=Microsoft Windows Kits Publisher,*'){throw ('Invalid SDK signing identity: '+$tool)}
}
$name='HackerValleyMedia.Interceptor.Desktop'
$publisher='CN=Hacker Valley Media LLC, O=Hacker Valley Media LLC, L=Austin, S=Texas, C=US'
$output=Join-Path $stage 'desktop\notifications'
if(Test-Path -LiteralPath $output){throw 'Notification identity output already exists'}
$package=Join-Path $output 'package'
New-Item -ItemType Directory -Path (Join-Path $package 'Assets') | Out-Null
Copy-Item -LiteralPath (Join-Path $stage 'extension\icons\icon128.png') -Destination (Join-Path $package 'Assets\logo.png')
$utf8=New-Object Text.UTF8Encoding($false)
$manifest=@"
<?xml version="1.0" encoding="utf-8"?>
<Package IgnorableNamespaces="uap uap10 rescap"
 xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
 xmlns:uap4="http://schemas.microsoft.com/appx/manifest/uap/windows10/4"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
 <Identity Name="$name" Publisher="$publisher" Version="$Version.0" ProcessorArchitecture="neutral"/>
 <Properties><DisplayName>Interceptor</DisplayName><PublisherDisplayName>Hacker Valley Media LLC</PublisherDisplayName><Logo>Assets\logo.png</Logo><uap10:AllowExternalContent>true</uap10:AllowExternalContent></Properties>
 <Resources><Resource Language="en-us"/></Resources>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="$minVersion" MaxVersionTested="10.0.26100.0"/></Dependencies>
 <Applications><Application Id="Desktop" Executable="interceptor-notification-badge.exe" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
  <uap:VisualElements AppListEntry="none" DisplayName="Interceptor" Description="Interceptor native desktop provider" BackgroundColor="transparent" Square150x150Logo="Assets\logo.png" Square44x44Logo="Assets\logo.png"/>
 </Application><Application Id="Contacts" Executable="interceptor-contacts-native.exe" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
  <uap:VisualElements AppListEntry="none" DisplayName="Interceptor Contacts" Description="Interceptor native Contacts helper" BackgroundColor="transparent" Square150x150Logo="Assets\logo.png" Square44x44Logo="Assets\logo.png"/>
 </Application></Applications>
 <Capabilities><uap:Capability Name="contacts"/><uap:Capability Name="appointments"/><uap4:Capability Name="userDataTasks"/><rescap:Capability Name="runFullTrust"/><rescap:Capability Name="unvirtualizedResources"/><rescap:Capability Name="contactsSystem"/></Capabilities>
</Package>
"@
[IO.File]::WriteAllText((Join-Path $package 'AppxManifest.xml'),$manifest,$utf8)
$commands=@()
foreach($application in $executables){
$applicationId=$application.id
$assembly=@"
<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
 <assemblyIdentity version="$Version.0" name="$name"/>
 <msix xmlns="urn:schemas-microsoft-com:msix.v1" publisher="$publisher" packageName="$name" applicationId="$applicationId"/>
</assembly>
"@
$assemblyPath=Join-Path $output ($applicationId+'.application.manifest')
[IO.File]::WriteAllText($assemblyPath,$assembly,$utf8)
$commands+=@(
 @{name=($applicationId+'-embed');tool='mt.exe';arguments=@('-nologo','-manifest',$assemblyPath,('-outputresource:'+ $application.path+';#1'))},
 @{name=($applicationId+'-readback');tool='mt.exe';arguments=@('-nologo',('-inputresource:'+ $application.path+';#1'),('-out:'+ (Join-Path $output ($applicationId+'.embedded-readback.manifest'))))}
)
}
$commands+=@(
 # Sparse packages reference external executables. Microsoft's identity guide
 # requires /nv for those paths; executable identity is checked above/below.
 @{name='package';tool='makeappx.exe';arguments=@('pack','/o','/d',$package,'/nv','/p',(Join-Path $output 'notification-identity.msix'))}
)
foreach($command in $commands){
 $process=New-Object Diagnostics.Process
 try {
  $process.StartInfo.FileName=Join-Path $sdk $command.tool
  $process.StartInfo.Arguments=($command.arguments | ForEach-Object {'"'+$_+'"'}) -join ' '
  $process.StartInfo.UseShellExecute=$false;$process.StartInfo.CreateNoWindow=$true
  $process.StartInfo.RedirectStandardOutput=$true;$process.StartInfo.RedirectStandardError=$true
  if(-not $process.Start()){throw ('Could not start '+$command.name)}
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(-not $process.WaitForExit(30000)){$process.Kill();throw ($command.name+' exceeded 30 seconds')}
  [IO.File]::WriteAllText((Join-Path $output ($command.name+'.stdout')),$stdout.GetAwaiter().GetResult())
  [IO.File]::WriteAllText((Join-Path $output ($command.name+'.stderr')),$stderr.GetAwaiter().GetResult())
  if($process.ExitCode -ne 0){throw ($command.name+' failed with exit '+$process.ExitCode)}
 } finally {$process.Dispose()}
}
foreach($application in $executables){
[xml]$embedded=Get-Content -LiteralPath (Join-Path $output ($application.id+'.embedded-readback.manifest')) -Raw
$identity=$embedded.assembly.msix
if($identity.packageName -ne $name -or $identity.publisher -ne $publisher -or $identity.applicationId -ne $application.id){throw 'Embedded desktop application identity differs'}
}
[ordered]@{packageName=$name;aumid=$name+'_4xfsjzhwq8rce!Desktop';version=$Version+'.0';architecture=$Arch;badgeHelperSHA256=(Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant();contactsHelperSHA256=(Get-FileHash $contacts -Algorithm SHA256).Hash.ToLowerInvariant();msixSHA256=(Get-FileHash (Join-Path $output 'notification-identity.msix') -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json
