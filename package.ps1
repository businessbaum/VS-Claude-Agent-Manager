# Builds the distributable .vsix.
#
# Runs the tests first, then packages.  vsce is fetched on demand, so there is
# nothing to install up front and no node_modules in the repo.
#
#   powershell -ExecutionPolicy Bypass -File .\package.ps1
#
# Keep this file plain ASCII: Windows PowerShell reads a .ps1 without a byte
# order mark as ANSI, and a stray dash or quote breaks the parse.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$manifest = Get-Content 'package.json' -Raw | ConvertFrom-Json
$vsix = "$($manifest.name)-$($manifest.version).vsix"

Write-Host "Running tests..."
foreach ($test in 'lifecycle', 'ui', 'panel') {
    node "test\$test.js" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "test/$test.js failed, not packaging" }
    Write-Host "  ok  test/$test.js"
}

Write-Host ""
Write-Host "Packaging $vsix ..."
npx --yes @vscode/vsce@latest package --allow-missing-repository --out $vsix
if ($LASTEXITCODE -ne 0) { throw "vsce package failed" }

Write-Host ""
Write-Host "Built $vsix"
Write-Host ""
Write-Host "Install it with:"
Write-Host "  code --install-extension $vsix"
Write-Host ""
Write-Host "Or hand the file to someone else. In VS Code: Extensions view,"
Write-Host "the '...' menu at the top, then 'Install from VSIX'."
