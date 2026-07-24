# PinkCode — Windows 11 dev environment check / setup hints
# Run: powershell -ExecutionPolicy Bypass -File scripts\windows-setup.ps1

$ErrorActionPreference = "Continue"
Write-Host "=== PinkCode Windows setup check ===" -ForegroundColor Cyan

function Ok($msg) { Write-Host "[OK]  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!!]  $msg" -ForegroundColor Yellow }
function Bad($msg) { Write-Host "[NO]  $msg" -ForegroundColor Red }

# Node
try {
  $nv = node --version 2>$null
  $nodeMajor = if ($nv) { [int](($nv -replace '^v', '').Split('.')[0]) } else { 0 }
  if ($nodeMajor -ge 24) { Ok "Node $nv" } else { Bad "Node $nv found (need 24+)" }
} catch { Bad "Node not found (need 24+)" }

# Rust
try {
  $rv = rustc --version 2>$null
  if ($rv) { Ok "Rust: $rv" } else { Bad "rustc not found" }
} catch { Bad "rustc not found" }

# MSVC linker: PATH first, then vswhere (any install drive)
$link = Get-Command link.exe -ErrorAction SilentlyContinue
$vsInstall = $null
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
  $vsInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null |
    Select-Object -First 1
}
if (-not $link -and $vsInstall) {
  $hostLink = Get-ChildItem (Join-Path $vsInstall "VC\Tools\MSVC") -Recurse -Filter "link.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "Hostx64\\x64" } |
    Select-Object -First 1
  if ($hostLink) {
    $env:Path = "$(Split-Path $hostLink.FullName);$env:Path"
    $link = Get-Command link.exe -ErrorAction SilentlyContinue
  }
}
if ($link) {
  Ok "MSVC linker: $($link.Source)"
} elseif ($vsInstall) {
  $vsdev = Join-Path $vsInstall "Common7\Tools\VsDevCmd.bat"
  Warn "MSVC at $vsInstall but link.exe not on PATH — use x64 Native Tools or VsDevCmd.bat"
  if (Test-Path $vsdev) {
    Write-Host "      `"$vsdev`" -arch=amd64 -host_arch=amd64" -ForegroundColor DarkGray
  }
} else {
  Bad "link.exe not found — install VS 2022 Build Tools (C++ workload)"
  Write-Host @"
      winget install Microsoft.VisualStudio.2022.BuildTools ``
        --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
"@ -ForegroundColor DarkGray
}

# WebView2
$wv2 = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
) | ForEach-Object {
  try { (Get-ItemProperty $_ -ErrorAction Stop).pv } catch { $null }
} | Where-Object { $_ } | Select-Object -First 1
if ($wv2) { Ok "WebView2 Runtime $wv2" } else { Warn "WebView2 Runtime not detected (required by Tauri on Windows)" }

# Grok
$grokCandidates = @()
if ($env:GROK_BIN) { $grokCandidates += $env:GROK_BIN }
if ($env:GROK_HOME) {
  $grokCandidates += (Join-Path $env:GROK_HOME "bin\grok.exe")
  $grokCandidates += (Join-Path $env:GROK_HOME "bin\grok")
}
$grokCandidates += (Join-Path $env:USERPROFILE ".grok\bin\grok.exe")
$which = Get-Command grok.exe -ErrorAction SilentlyContinue
if ($which) { $grokCandidates += $which.Source }

$found = $grokCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($found) {
  Ok "grok binary: $found"
} else {
  Warn "grok.exe not found — install Grok Build and/or set GROK_BIN / GROK_HOME"
}

if ($env:GROK_HOME) {
  Ok "GROK_HOME=$env:GROK_HOME"
} elseif (Test-Path (Join-Path $env:USERPROFILE ".grok")) {
  Ok "Grok home: $env:USERPROFILE\.grok"
} else {
  Warn "No GROK_HOME and no %USERPROFILE%\.grok"
}

Write-Host ""
Write-Host "When MSVC + Node + Rust are ready:" -ForegroundColor Cyan
Write-Host "  npm install"
Write-Host "  npm run tauri:dev"
Write-Host ""
