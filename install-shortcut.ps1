# Owner: Time And Time Studio
#
# Creates a "TML" shortcut on the current user's desktop:
#   - target        run-tml.bat in this folder (starts the server + opens the
#                   launcher page in the default browser)
#   - icon          TML.ico next to it
#
#   powershell -File .\install-shortcut.ps1   (or double-click install-shortcut.bat)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat = Join-Path $root 'run-tml.bat'
$icon = Join-Path $root 'TML.ico'
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'TML.lnk'

foreach ($file in @($bat, $icon)) {
    if (-not (Test-Path -LiteralPath $file)) {
        Write-Error "missing $file - run this from the TML folder"
        exit 1
    }
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($lnk)
$shortcut.TargetPath = $bat
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = 'TML - Time Mini Launcher'
$shortcut.Save()

Write-Output "Created $lnk"
