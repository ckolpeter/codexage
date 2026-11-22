# Fix "Electron failed to install correctly" on Windows.
# Downloads (or reuses the cached) Electron zip and extracts it with PowerShell,
# bypassing the npm postinstall step that can exit silently on newer Node.js.
#
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File scripts\fix-electron.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electronDir = Join-Path $root 'node_modules\electron'
if (-not (Test-Path $electronDir)) { throw "node_modules\electron not found. Run 'npm install' first." }

$version = (Get-Content (Join-Path $electronDir 'package.json') -Raw | ConvertFrom-Json).version
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "electron-v$version-win32-$arch.zip"
Write-Host "Electron $version ($arch)"

# 1. Reuse the zip @electron/get already downloaded, if any
$cache = Join-Path $env:LOCALAPPDATA 'electron\Cache'
$zip = $null
if (Test-Path $cache) {
  $zip = Get-ChildItem $cache -Recurse -Filter $name -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

# 2. Otherwise download it (mirror first, then GitHub)
if ($zip) {
  $zipPath = $zip.FullName
  Write-Host "Using cached $zipPath"
} else {
  $zipPath = Join-Path $env:TEMP $name
  $urls = @()
  if ($env:ELECTRON_MIRROR) { $urls += "$($env:ELECTRON_MIRROR.TrimEnd('/'))/$version/$name" }
  $urls += "https://npmmirror.com/mirrors/electron/$version/$name"
  $urls += "https://github.com/electron/electron/releases/download/v$version/$name"
  $ok = $false
  foreach ($u in $urls) {
    try {
      Write-Host "Downloading $u ..."
      $ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster
      Invoke-WebRequest -Uri $u -OutFile $zipPath -UseBasicParsing
      $ok = $true; break
    } catch { Write-Host "  failed: $($_.Exception.Message)" }
  }
  if (-not $ok) { throw 'Could not download Electron.' }
}

# 3. Extract into node_modules\electron\dist and write path.txt
$dist = Join-Path $electronDir 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
Write-Host 'Extracting...'
Expand-Archive -Path $zipPath -DestinationPath $dist -Force

$typedef = Join-Path $dist 'electron.d.ts'
if (Test-Path $typedef) { Move-Item $typedef (Join-Path $electronDir 'electron.d.ts') -Force }
[IO.File]::WriteAllText((Join-Path $electronDir 'path.txt'), 'electron.exe')

if (Test-Path (Join-Path $dist 'electron.exe')) {
  Write-Host "Done. Run 'npm start'." -ForegroundColor Green
} else {
  throw 'electron.exe not found after extraction.'
}
