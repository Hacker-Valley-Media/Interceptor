# Owned Windows media session for the music cases. A WinRT MediaPlayer plays a
# generated silent WAV in a loop, which registers a GlobalSystemMediaTransportControls session
# typed as Music with title "Interceptor Parity Track". Usage: windows-media-fixture.ps1 <statusDir>
param([string]$StatusDir = $env:TEMP)
$ErrorActionPreference = 'Stop'
$wav = Join-Path $StatusDir 'parity-silence.wav'
$rate = 8000; $seconds = 30; $samples = $rate * $seconds
$stream = [IO.File]::Create($wav); $w = New-Object IO.BinaryWriter($stream)
$w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write([int](36 + $samples)); $w.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
$w.Write([int]16); $w.Write([int16]1); $w.Write([int16]1); $w.Write([int]$rate); $w.Write([int]$rate); $w.Write([int16]1); $w.Write([int16]8)
$w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write([int]$samples); $w.Write([byte[]](,128 * $samples)); $w.Close()
[void][Windows.Media.Playback.MediaPlayer, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$player = New-Object Windows.Media.Playback.MediaPlayer
$player.Source = [Windows.Media.Core.MediaSource]::CreateFromUri([Uri]$wav)
$player.IsLoopingEnabled = $true
$smtc = $player.SystemMediaTransportControls
$smtc.IsEnabled = $true; $smtc.IsPlayEnabled = $true; $smtc.IsPauseEnabled = $true; $smtc.IsStopEnabled = $true; $smtc.IsNextEnabled = $true; $smtc.IsPreviousEnabled = $true
$player.CommandManager.IsEnabled = $true
$updater = $smtc.DisplayUpdater
$updater.Type = [Windows.Media.MediaPlaybackType]::Music
$updater.MusicProperties.Title = 'Interceptor Parity Track'; $updater.MusicProperties.Artist = 'Interceptor Parity'; $updater.Update()
$player.Play()
Set-Content -Path (Join-Path $StatusDir 'music.json') -Value '{"started":true}'
while ($true) { Start-Sleep -Seconds 1 }
