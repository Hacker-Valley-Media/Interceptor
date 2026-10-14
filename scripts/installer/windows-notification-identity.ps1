param(
 [Parameter(Mandatory=$true)][ValidateSet('check','prepare','install','rollback','finalize','remove')][string]$Action,
 [Parameter(Mandatory=$true)][string]$Root,
 [string]$Version,
 [string]$TransactionId
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if((Get-Process -Id $PID).SessionId -eq 0){throw 'Notification identity maintenance requires the graphical login'}
if(-not [IO.Path]::IsPathRooted($Root)){throw 'An absolute owned installation root is required'}
$Root=[IO.Path]::GetFullPath($Root).TrimEnd('\')
$name='HackerValleyMedia.Interceptor.Desktop'
$publisher='CN=Hacker Valley Media LLC, O=Hacker Valley Media LLC, L=Austin, S=Texas, C=US'
$family=$name+'_4xfsjzhwq8rce'
$statePath='HKCU:\Software\Hacker Valley Media\Interceptor\Installer\State'
$pendingPath='HKCU:\Software\Hacker Valley Media\Interceptor\Installer\Pending\NotificationIdentity'
$payload=Join-Path $Root 'notification-identity.msix'
function Require-ReceiptKinds([string]$Path,[string[]]$Numbers,[string[]]$Strings,[string[]]$Flags=@()) {
 $key=Get-Item -LiteralPath $Path
 foreach($field in $Numbers){if($key.GetValueKind($field) -ne [Microsoft.Win32.RegistryValueKind]::DWord){throw ('Notification receipt requires DWORD '+$field)}}
 foreach($field in $Strings){if($key.GetValueKind($field) -ne [Microsoft.Win32.RegistryValueKind]::String){throw ('Notification receipt requires REG_SZ '+$field)}}
 foreach($field in $Flags){
  if($key.GetValueNames() -contains $field){
   if($key.GetValueKind($field) -ne [Microsoft.Win32.RegistryValueKind]::DWord -or $key.GetValue($field) -notin @(0,1)){throw ('Notification receipt flag differs '+$field)}
  }
 }
}
function Read-OwnedPackage {
 $packages=@(Get-AppxPackage -Name $name)
 if($packages.Count -eq 0){return $null}
 if($packages.Count -ne 1){throw 'Notification package registration is ambiguous'}
 $p=$packages[0]
 if($p.Name -cne $name -or $p.Publisher -cne $publisher -or $p.PackageFamilyName -cne $family -or [string]$p.Status -ne 'Ok'){throw 'Notification package identity differs'}
 $manager=New-Object Windows.Management.Deployment.PackageManager
 $native=$manager.FindPackageForUser('',[string]$p.PackageFullName)
 if([IO.Path]::GetFullPath($native.EffectiveExternalPath).TrimEnd('\') -ne $Root){throw 'Notification package external root differs'}
 $manifest=Get-AppxPackageManifest -Package $p.PackageFullName
 $apps=$manifest.SelectNodes('/*[local-name()="Package"]/*[local-name()="Applications"]/*[local-name()="Application"]')
 $badge=@($apps | Where-Object {$_.Id -ceq 'Desktop' -and $_.Executable -ceq 'interceptor-notification-badge.exe'})
 $contacts=@($apps | Where-Object {$_.Id -ceq 'Contacts' -and $_.Executable -ceq 'interceptor-contacts-native.exe'})
 if($badge.Count -ne 1 -or $apps.Count -notin @(1,2) -or ($apps.Count -eq 2 -and $contacts.Count -ne 1)){throw 'Desktop package applications differ'}
 foreach($application in $apps){if($application.SelectNodes('*[local-name()="Extensions"]').Count -ne 0){throw 'Desktop package must not register packaged toast activation'}}
 $caps=$manifest.SelectNodes('/*[local-name()="Package"]/*[local-name()="Capabilities"]/*')
 $expected=if($apps.Count -eq 2 -and $caps.Count -eq 6){@('contacts','appointments','userDataTasks','runFullTrust','unvirtualizedResources','contactsSystem')}elseif($apps.Count -eq 2){@('contacts','runFullTrust','unvirtualizedResources','contactsSystem')}else{@('runFullTrust','unvirtualizedResources')}
 if($caps.Count -ne $expected.Count){throw 'Desktop package capabilities differ'}
 foreach($capability in $expected){
  $namespace=if($capability -in @('contacts','appointments')){'http://schemas.microsoft.com/appx/manifest/uap/windows10'}elseif($capability -eq 'userDataTasks'){'http://schemas.microsoft.com/appx/manifest/uap/windows10/4'}else{'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities'}
  if(@($caps | Where-Object {$_.LocalName -ceq 'Capability' -and $_.GetAttribute('Name') -ceq $capability -and $_.NamespaceURI -ceq $namespace}).Count -ne 1){throw ('Desktop package capability differs: '+$capability)}
 }
 return $p
}
function Require-InstallOwner {
 Require-ReceiptKinds $statePath @('SchemaVersion','ShutdownProtocolVersion') @('DesktopMode','InstallRoot','OwnedManifestPath')
 $state=Get-ItemProperty -LiteralPath $statePath
 if($null -ne $state.NotificationPackageFullName){Require-ReceiptKinds $statePath @() @('NotificationPackageFullName')}
 if($state.SchemaVersion -ne 1 -or $state.ShutdownProtocolVersion -ne 1 -or $state.DesktopMode -ne 'full' -or -not [IO.Path]::IsPathRooted($state.InstallRoot) -or -not [IO.Path]::IsPathRooted($state.OwnedManifestPath) -or [IO.Path]::GetFullPath($state.InstallRoot).TrimEnd('\') -ne $Root -or [IO.Path]::GetFullPath($state.OwnedManifestPath) -ne (Join-Path $Root 'daemon\com.interceptor.host.json')){throw 'Notification package is not owned by this full installation'}
 return $state
}
function Require-SignedPayload([string]$Path) {
 $parent=Get-Item -LiteralPath (Split-Path $Path)
 while($parent){if($parent.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Notification payload parent is a reparse point'};$parent=$parent.Parent}
 $file=Get-Item -LiteralPath $Path
 $signature=Get-AuthenticodeSignature -LiteralPath $Path
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -cne $publisher){throw 'Notification identity payload is not signed by the expected publisher'}
}
function Read-Transaction {
 Require-ReceiptKinds (Split-Path $pendingPath) @('SchemaVersion','Committed') @('DesktopMode')
 $installer=Get-ItemProperty -LiteralPath (Split-Path $pendingPath)
 if($installer.SchemaVersion -ne 1 -or $installer.DesktopMode -ne 'full' -or $installer.Committed -notin @(0,1)){throw 'Notification installer journal differs'}
 Require-ReceiptKinds $pendingPath @() @('Root','TransactionId','BackupPath','PriorFullName','PriorSHA256','TargetFullName') @('DeploymentUncertain','Finalized')
 $p=Get-ItemProperty -LiteralPath $pendingPath
 if($null -ne $p.NotificationPackageFullName){Require-ReceiptKinds $pendingPath @() @('NotificationPackageFullName')}
 if($p.Root -ne $Root -or $p.TargetFullName -notmatch '^HackerValleyMedia\.Interceptor\.Desktop_\d+\.\d+\.\d+\.0_neutral__4xfsjzhwq8rce$'){throw 'Notification transaction identity differs'}
 $guid=[guid]::ParseExact($p.TransactionId,'D')
 $backup=Join-Path $env:LOCALAPPDATA ('Interceptor\Installer\NotificationRollback\'+$guid.ToString()+'\prior.msix')
 if($p.BackupPath -ne $backup){throw 'Notification rollback path differs'}
 if($p.PriorFullName -ne '' -and ($p.PriorFullName -notmatch '^HackerValleyMedia\.Interceptor\.Desktop_\d+\.\d+\.\d+\.0_neutral__4xfsjzhwq8rce$' -or $p.PriorSHA256 -notmatch '^[0-9a-f]{64}$')){throw 'Notification prior identity receipt differs'}
 return $p
}
function Remove-OwnedBackup($Pending) {
 if(Test-Path -LiteralPath $Pending.BackupPath){
  Require-SignedPayload $Pending.BackupPath
  if((Get-FileHash -LiteralPath $Pending.BackupPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Pending.PriorSHA256){throw 'Notification rollback payload changed'}
  $directory=Get-Item -LiteralPath (Split-Path $Pending.BackupPath)
  if(($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or @(Get-ChildItem -LiteralPath $directory.FullName -Force).Count -ne 1){throw 'Notification rollback directory changed'}
  Remove-Item -LiteralPath $Pending.BackupPath
  Remove-Item -LiteralPath $directory.FullName
 }
}
function Invoke-Deployment([bool]$Remove,[string]$Target,[bool]$Downgrade) {
 $literal="'"+$Target.Replace("'","''")+"'"
 $command=if($Remove){"Remove-AppxPackage -Package "+$literal}else{"Add-AppxPackage -Path "+$literal+" -ExternalLocation '"+$Root.Replace("'","''")+"'"}
 if($Downgrade){$command+=' -ForceUpdateFromAnyVersion'}
 $script='$ErrorActionPreference=''Stop'';$ProgressPreference=''SilentlyContinue'';'+$command
 $child=New-Object Diagnostics.Process
 $started=$false
 try{
  $child.StartInfo.FileName=$PSHOME+'\powershell.exe'
  $child.StartInfo.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $child.StartInfo.UseShellExecute=$false;$child.StartInfo.CreateNoWindow=$true
  $child.StartInfo.RedirectStandardOutput=$true;$child.StartInfo.RedirectStandardError=$true
  if(-not $child.Start()){throw 'Package deployment process did not start'}
  $started=$true
  $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
  if(-not $child.WaitForExit(45000)){
   $child.Kill()
   if(Test-Path -LiteralPath $pendingPath){New-ItemProperty -LiteralPath $pendingPath -Name 'DeploymentUncertain' -Value 1 -PropertyType DWord -Force|Out-Null}
   else{New-ItemProperty -LiteralPath $statePath -Name 'NotificationDeploymentUncertain' -Value 1 -PropertyType DWord -Force|Out-Null}
   throw 'Package deployment exceeded 45 seconds; its native outcome is unknown'
  }
  if($child.ExitCode -ne 0){throw ('Package deployment failed: '+$stderr.GetAwaiter().GetResult())}
  $null=$stdout.GetAwaiter().GetResult()
 }finally{if($started -and -not $child.HasExited){$child.Kill()};$child.Dispose()}
}
if(Test-Path -LiteralPath $statePath){Require-ReceiptKinds $statePath @() @() @('NotificationDeploymentUncertain')}
if((Get-ItemProperty -LiteralPath $statePath -ErrorAction SilentlyContinue).NotificationDeploymentUncertain -eq 1){throw 'Package uninstall outcome is unknown; inspect the native deployment result before repair'}
$current=Read-OwnedPackage
switch($Action){
 'check' {
  if($current){$state=Require-InstallOwner;if($state.NotificationPackageFullName -cne $current.PackageFullName){throw 'Notification package ownership receipt differs'}}
 }
 'prepare' {
  if($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or @($Version.Split('.')|Where-Object {[long]$_ -gt 65535}).Count){throw 'Invalid notification package version'}
  $guid=[guid]::ParseExact($TransactionId,'D')
  Require-ReceiptKinds (Split-Path $pendingPath) @('SchemaVersion','Committed') @('DesktopMode')
  $installer=Get-ItemProperty -LiteralPath (Split-Path $pendingPath)
  if($installer.SchemaVersion -ne 1 -or $installer.DesktopMode -ne 'full' -or $installer.Committed -ne 0){throw 'Notification prepare requires the owned full installer journal'}
  if(Test-Path -LiteralPath $pendingPath){throw 'Notification transaction already exists'}
  $backup=Join-Path $env:LOCALAPPDATA ('Interceptor\Installer\NotificationRollback\'+$guid.ToString()+'\prior.msix')
  if(Test-Path -LiteralPath (Split-Path $backup)){throw 'Notification rollback directory already exists'}
  $prior='';$hash=''
  if($current){
   $state=Require-InstallOwner
   if($state.NotificationPackageFullName -cne $current.PackageFullName){throw 'Notification package ownership receipt differs'}
   Require-SignedPayload $payload
   $hash=(Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
   $prior=[string]$current.PackageFullName
  }
  New-Item -Path $pendingPath -Force|Out-Null
  foreach($entry in @{Root=$Root;TransactionId=$guid.ToString();BackupPath=$backup;PriorFullName=$prior;PriorSHA256=$hash;TargetFullName=($name+'_'+$Version+'.0_neutral__4xfsjzhwq8rce')}.GetEnumerator()){New-ItemProperty -LiteralPath $pendingPath -Name $entry.Key -Value $entry.Value -PropertyType String -Force|Out-Null}
  if($current){
   New-Item -ItemType Directory -Path (Split-Path $backup)|Out-Null
   Copy-Item -LiteralPath $payload -Destination $backup
   if((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash){throw 'Notification rollback copy differs'}
  }
 }
 'install' {
  $pending=Read-Transaction
  Require-SignedPayload $payload
  Require-SignedPayload (Join-Path $Root 'interceptor-desktop.exe')
  Require-SignedPayload (Join-Path $Root 'interceptor-notification-badge.exe')
  Require-SignedPayload (Join-Path $Root 'interceptor-contacts-native.exe')
  if($current -and $current.PackageFullName -cne $pending.PriorFullName -and $current.PackageFullName -cne $pending.TargetFullName){throw 'Notification registration changed during install'}
  if(-not $current -or $current.PackageFullName -cne $pending.TargetFullName){
   if($pending.DeploymentUncertain -eq 1){throw 'Package deployment outcome is unknown; no installation was replayed'}
   Invoke-Deployment $false $payload $false
  }
  $current=Read-OwnedPackage
  if(-not $current -or $current.PackageFullName -cne $pending.TargetFullName){throw 'Notification package installation did not establish the expected identity'}
  $installedManifest=Get-AppxPackageManifest -Package $current.PackageFullName
  if($installedManifest.SelectNodes('/*[local-name()="Package"]/*[local-name()="Applications"]/*[local-name()="Application" and @Id="Contacts" and @Executable="interceptor-contacts-native.exe"]').Count -ne 1){throw 'Contacts application identity is missing from the installed package; rebuild with a new package version'}
  foreach($capability in @('appointments','userDataTasks')){if($installedManifest.SelectNodes('/*[local-name()="Package"]/*[local-name()="Capabilities"]/*[@Name="'+$capability+'"]').Count -ne 1){throw ('Personal-data capability is missing from the installed package: '+$capability+'; rebuild with a new package version')}}
  New-ItemProperty -LiteralPath $pendingPath -Name 'NotificationPackageFullName' -Value $current.PackageFullName -PropertyType String -Force|Out-Null
 }
 'rollback' {
  if(-not (Test-Path -LiteralPath $pendingPath)){break}
  $pending=Read-Transaction
  if($pending.DeploymentUncertain -eq 1){throw 'Package deployment outcome is unknown; rollback requires a confirmed native deployment result'}
  if($current -and $current.PackageFullName -cne $pending.TargetFullName -and $current.PackageFullName -cne $pending.PriorFullName){throw 'Notification rollback refused a foreign registration'}
  if($pending.PriorFullName -eq ''){
   if($current){Invoke-Deployment $true $current.PackageFullName $false}
   if(Read-OwnedPackage){throw 'Notification rollback left a new registration'}
  }elseif(-not $current -or $current.PackageFullName -cne $pending.PriorFullName){
   Require-SignedPayload $pending.BackupPath
   if((Get-FileHash -LiteralPath $pending.BackupPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pending.PriorSHA256){throw 'Notification rollback payload differs'}
   Invoke-Deployment $false $pending.BackupPath $true
   $current=Read-OwnedPackage
   if(-not $current -or $current.PackageFullName -cne $pending.PriorFullName){throw 'Notification rollback did not restore the prior identity'}
  }
  Remove-OwnedBackup $pending
  Remove-Item -LiteralPath $pendingPath
 }
 'finalize' {
  $pending=Read-Transaction
  if((Get-ItemProperty -LiteralPath (Split-Path $pendingPath)).Committed -ne 1){throw 'Notification finalization requires a committed installer journal'}
  $state=Require-InstallOwner
  if(-not $current -or $current.PackageFullName -cne $pending.TargetFullName -or $state.NotificationPackageFullName -cne $current.PackageFullName){throw 'Notification commit receipt differs'}
  Remove-OwnedBackup $pending
  # Keep the commit receipt until the parent installer journal is removed.
  New-ItemProperty -LiteralPath $pendingPath -Name 'Finalized' -Value 1 -PropertyType DWord -Force|Out-Null
 }
 'remove' {
  $state=Require-InstallOwner
  if($current){
   if($state.NotificationPackageFullName -cne $current.PackageFullName){throw 'Notification uninstall refused a foreign registration'}
   Invoke-Deployment $true $current.PackageFullName $false
   if(Read-OwnedPackage){throw 'Notification package remains after uninstall'}
  }
 }
}
[ordered]@{ok=$true;action=$Action;root=$Root;packageFullName=if($current){[string]$current.PackageFullName}else{$null}}|ConvertTo-Json -Compress
