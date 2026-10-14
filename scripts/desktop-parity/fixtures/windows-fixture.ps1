# Owned Windows parity fixture. WinForms on .NET Framework, so the menu is a
# classic HMENU and every control exposes UIA. State changes are written to
# <StatusDir>\state.json so batch checks can confirm an action landed. The observer
# window takes focus at start; background cases must leave it focused.
param([string]$StatusDir = $env:TEMP)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# The observer is a second window on its own UI thread in this process, like the Mac and Linux
# fixtures, so `--app powershell` names one application with two windows.
function Start-Observer {
  $runspace = [runspacefactory]::CreateRunspace(); $runspace.ApartmentState = 'STA'; $runspace.Open()
  $runspace.SessionStateProxy.SetVariable('statusDir', $StatusDir)
  $shell = [powershell]::Create(); $shell.Runspace = $runspace
  [void]$shell.AddScript({
    Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
    $watcher = New-Object System.Windows.Forms.Form
    $watcher.Text = 'Interceptor Parity Observer'
    $watcher.Size = New-Object System.Drawing.Size(236, 180)
    $watcher.StartPosition = 'Manual'
    $watcher.Location = New-Object System.Drawing.Point(556, 200)
    $note = New-Object System.Windows.Forms.TextBox
    $note.AccessibleName = 'Observer focus'; $note.Dock = 'Fill'; $note.Multiline = $true
    $note.Text = 'This window keeps focus while Interceptor works on the fixture.'
    $watcher.Controls.Add($note)
    Add-Type -Namespace Itc -Name Fg -MemberDefinition '
      [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
      [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);'
    Add-Type -Namespace Itc -Name Fg2 -MemberDefinition '
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);'
    # Reclaim foreground ONLY from the idle-console shell overlays (ShellExperienceHost, Start, Search,
    # the lock app, dwm) that grab it when no app is active. Never from ApplicationFrameHost/explorer
    # (a Settings grant page or a legitimately-activated helper) or the fixture's own windows. This keeps
    # an attachable fixture foreground for background cases; the runner's focus guard ignores these flaps.
    $shellNames = 'ShellExperienceHost|StartMenuExperienceHost|SearchHost|SearchApp|TextInputHost|LockApp|dwm|LogonUI|OpenWith'
    $reclaim = {
      $fg = [Itc.Fg2]::GetForegroundWindow(); $fgpid = 0; [void][Itc.Fg2]::GetWindowThreadProcessId($fg, [ref]$fgpid)
      if ($fgpid -ne $PID) {
        $name = (Get-Process -Id $fgpid -ErrorAction SilentlyContinue).ProcessName
        if (-not $name -or $name -match $shellNames) {
          [Itc.Fg]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [Itc.Fg]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
          [void][Itc.Fg]::SetForegroundWindow($watcher.Handle); $watcher.Activate(); [void]$note.Focus()
        }
      }
    }
    # The activate cases need a zero foreground lock timeout. HKCU ForegroundLockTimeout=0 applies only at logon,
    # and Windows refuses SPI_SETFOREGROUNDLOCKTIMEOUT unless the caller owns the foreground. The observer owns it
    # once shown, so it applies the live value there and records the result (lock.txt in the status folder).
    Add-Type -Namespace Itc -Name Spi -MemberDefinition '
      [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint u, IntPtr p, uint f);
      [DllImport("user32.dll", EntryPoint="SystemParametersInfo")] public static extern bool Get(uint a, uint u, ref uint p, uint f);'
    $watcher.Add_Shown({
      & $reclaim; [void][Itc.Fg]::SetForegroundWindow($watcher.Handle); $watcher.Activate()
      $set = [Itc.Spi]::SystemParametersInfo(0x2001, 0, [IntPtr]::Zero, 3); $now = 0; [void][Itc.Spi]::Get(0x2000, 0, [ref]$now, 0)
      "set=$set timeout=$now" | Set-Content -Path (Join-Path $statusDir 'lock.txt')
    })
    $keeper = New-Object System.Windows.Forms.Timer; $keeper.Interval = 400; $keeper.Add_Tick($reclaim); $keeper.Start()
    [System.Windows.Forms.Application]::Run($watcher)
  })
  $script:observerRun = @{ Shell = $shell; Handle = $shell.BeginInvoke() }
}
$state = [ordered]@{ input = ''; result = 'Not submitted'; menu = 'unchanged'; checkbox = $false; combo = ''; scroll = 'unchanged'; drag = 'unchanged'; keys = @(); clicks = 0 }
function Save-State { ($state | ConvertTo-Json -Compress -Depth 4) | Set-Content -Encoding UTF8 -Path (Join-Path $StatusDir 'state.json') }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Interceptor Parity Fixture'
$form.Size = New-Object System.Drawing.Size(540, 520)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(8, 8)

$menu = New-Object System.Windows.Forms.MainMenu
$file = $menu.MenuItems.Add('File')
$mark = $file.MenuItems.Add('Mark fixture')
$menuStatus = New-Object System.Windows.Forms.Label
$mark.Add_Click({ $menuStatus.Text = 'Menu fixture invoked'; $state.menu = 'invoked'; Save-State })
$form.Menu = $menu

function Add-Control($control, $name, $y, $height = 28, $x = 12) {
  $control.AccessibleName = $name
  $control.Location = New-Object System.Drawing.Point($x, $y)
  $control.Size = New-Object System.Drawing.Size(250, $height)
  $form.Controls.Add($control)
  $control
}
$entry = Add-Control (New-Object System.Windows.Forms.TextBox) 'Fixture input' 10
$entry.Add_TextChanged({ $state.input = $entry.Text; Save-State })
# Keys are recorded at the form (KeyPreview), whichever control has focus, like the Linux fixture.
$form.KeyPreview = $true
$form.Add_KeyDown({ $state.keys += ('{0}{1}{2}' -f ($(if ($_.Control) { 'Ctrl+' })), ($(if ($_.Shift) { 'Shift+' })), $_.KeyCode); Save-State })
$submit = Add-Control (New-Object System.Windows.Forms.Button) 'Submit fixture' 44 32
$submit.Text = 'Submit fixture'
$result = Add-Control (New-Object System.Windows.Forms.Label) 'Fixture result' 82
$result.Text = 'Not submitted'
$submit.Add_Click({ $result.Text = 'Submitted: ' + $entry.Text; $state.result = $result.Text; $state.clicks++; Save-State })
$password = Add-Control (New-Object System.Windows.Forms.TextBox) 'Fixture password' 114
$password.UseSystemPasswordChar = $true; $password.Text = 'PARITY-SYNTHETIC-SECRET'
$readonly = Add-Control (New-Object System.Windows.Forms.TextBox) 'Read-only fixture input' 148
$readonly.ReadOnly = $true; $readonly.Text = 'UNCHANGED READ ONLY'
$disabled = Add-Control (New-Object System.Windows.Forms.TextBox) 'Disabled fixture input' 182
$disabled.Enabled = $false; $disabled.Text = 'UNCHANGED DISABLED'
$disabledButton = Add-Control (New-Object System.Windows.Forms.Button) 'Disabled fixture button' 216 32
$disabledButton.Text = 'Disabled fixture button'; $disabledButton.Enabled = $false
$check = Add-Control (New-Object System.Windows.Forms.CheckBox) 'Fixture checkbox' 254
$check.Text = 'Fixture checkbox'
$check.Add_CheckedChanged({ $state.checkbox = $check.Checked; Save-State })
$combo = Add-Control (New-Object System.Windows.Forms.ComboBox) 'Fixture combo' 288
$combo.DropDownStyle = 'DropDownList'; [void]$combo.Items.AddRange(@('One', 'Two', 'Three'))
$combo.Add_SelectedIndexChanged({ $state.combo = [string]$combo.SelectedItem; Save-State })
$selected = Add-Control (New-Object System.Windows.Forms.RichTextBox) 'Selection fixture input' 322 50
$selected.ReadOnly = $true; $selected.HideSelection = $false
$selected.Text = 'Before Selected ' + [char]::ConvertFromUtf32(0x1f642) + ' ' + [char]0x6587 + [char]0x4ef6 + ' After'
$selected.SelectionStart = 7; $selected.SelectionLength = 14
$scroll = Add-Control (New-Object System.Windows.Forms.TextBox) 'Scroll fixture input' 10 110 272
$scroll.Multiline = $true; $scroll.ScrollBars = 'Vertical'; $scroll.ReadOnly = $true
$scroll.Text = (0..199 | ForEach-Object { "Scroll fixture line $_" }) -join "`r`n"
$scrollTimer = New-Object System.Windows.Forms.Timer
$scrollTimer.Interval = 200
$lastLine = 0
$scrollTimer.Add_Tick({
  $first = $scroll.GetLineFromCharIndex($scroll.GetCharIndexFromPosition((New-Object System.Drawing.Point(2, 2))))
  if ($first -ne $script:lastLine) { $script:lastLine = $first; $state.scroll = "line $first"; Save-State }
})
$scrollTimer.Start()
$drag = Add-Control (New-Object System.Windows.Forms.Panel) 'Drag fixture' 130 120 272
$drag.BackColor = [System.Drawing.Color]::LightSteelBlue
$dragStart = $null
$drag.Add_MouseDown({ $script:dragStart = $_.Location })
$drag.Add_MouseUp({ if ($script:dragStart) { $state.drag = ('{0},{1}->{2},{3}' -f $script:dragStart.X, $script:dragStart.Y, $_.X, $_.Y); Save-State; $script:dragStart = $null } })
$menuStatus.Location = New-Object System.Drawing.Point(272, 260); $menuStatus.Size = New-Object System.Drawing.Size(250, 24)
$menuStatus.Text = 'Menu fixture unchanged'; $menuStatus.AccessibleName = 'Menu fixture status'
$form.Controls.Add($menuStatus)
$list = Add-Control (New-Object System.Windows.Forms.ListBox) 'Fixture list' 382 60
[void]$list.Items.AddRange(@('Alpha', 'Beta', 'Gamma'))

$form.ActiveControl = $entry
$form.Add_Shown({
  Save-State
  Start-Observer
})
[System.Windows.Forms.Application]::Run($form)
