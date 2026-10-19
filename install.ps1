# Installs the extension straight into VS Code's user extensions folder, for
# working on it: VS Code loads unpacked folders on startup, so there is no
# packaging step.  Re-run after changing the source, then reload the window.
#
# To hand the extension to someone else, build a .vsix instead:
#   powershell -ExecutionPolicy Bypass -File .\package.ps1
#
# Keep this file plain ASCII: Windows PowerShell reads a .ps1 without a byte
# order mark as ANSI, and a stray dash or quote breaks the parse.

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$manifest = Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
$target = Join-Path $env:USERPROFILE ".vscode\extensions\$($manifest.name)-$($manifest.version)"

# Remove every previously installed copy, not just the matching version: two
# copies both register the same view, and the panel then appears twice.  The
# second pattern catches a copy installed from a .vsix, which VS Code names
# with the publisher in front.
foreach ($pattern in "$($manifest.name)-*", "*.$($manifest.name)-*") {
    Get-ChildItem (Split-Path $target -Parent) -Directory -Filter $pattern -ErrorAction SilentlyContinue |
        ForEach-Object {
            Write-Host "Removing $($_.FullName)"
            Remove-Item $_.FullName -Recurse -Force
        }
}
New-Item -ItemType Directory -Path $target -Force | Out-Null

# Everything the extension needs at runtime; tests and scratch files stay behind.
Copy-Item (Join-Path $source 'package.json') $target
Copy-Item (Join-Path $source 'extension.js') $target
Copy-Item (Join-Path $source 'README.md') $target
Copy-Item (Join-Path $source 'src') $target -Recurse
Copy-Item (Join-Path $source 'resources') $target -Recurse
Copy-Item (Join-Path $source 'media') $target -Recurse

Write-Host ""
Write-Host "Installed $($manifest.displayName) $($manifest.version) to:"
Write-Host "  $target"
Write-Host ""
Write-Host "Reload VS Code to pick it up (Command Palette -> Developer: Reload Window)."
