param(
  [string] $FirefoxPath = "C:\Program Files\Mozilla Firefox\firefox.exe",
  [int] $LaunchSeconds = 20
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceDir = Join-Path $root ".output\firefox-mv2"
$manifest = Join-Path $sourceDir "manifest.json"
if (!(Test-Path $manifest)) {
  throw "Missing Firefox build at $manifest. Run pnpm build:firefox first."
}

if (!(Test-Path $FirefoxPath)) {
  throw "Firefox executable not found: $FirefoxPath"
}

$webExtScript = Join-Path $root "node_modules/web-ext/bin/web-ext.js"
if (!(Test-Path $webExtScript)) {
  throw "Install the locked development dependencies before running the smoke check."
}
$nodeCommand = Get-Command node.exe -ErrorAction Stop

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$profile = Join-Path $root "output\firefox-sideload-smoke\profile-$stamp"
$stdout = Join-Path $root "output\firefox-sideload-smoke\web-ext-$stamp.out.log"
$stderr = Join-Path $root "output\firefox-sideload-smoke\web-ext-$stamp.err.log"
New-Item -ItemType Directory -Force -Path $profile | Out-Null

$startUrl = "file:///" + ((Join-Path $root "test.html") -replace "\\", "/")
$arguments = @(
  $webExtScript,
  "run",
  "--source-dir",
  $sourceDir,
  "--firefox",
  $FirefoxPath,
  "--firefox-profile",
  $profile,
  "--keep-profile-changes",
  "--no-reload",
  "--start-url",
  $startUrl
)

function Format-ProcessArgument([string] $Value) {
  if ($Value -match '[\s"]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

$argumentLine = ($arguments | ForEach-Object { Format-ProcessArgument $_ }) -join " "

$webExt = Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList $argumentLine `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -WindowStyle Hidden `
  -PassThru

try {
  Start-Sleep -Seconds $LaunchSeconds
} finally {
  $profilePattern = "*$profile*"
  Get-CimInstance Win32_Process -Filter "name='firefox.exe'" |
    Where-Object { $_.CommandLine -like $profilePattern } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

  if (!$webExt.HasExited) {
    Stop-Process -Id $webExt.Id -Force -ErrorAction SilentlyContinue
  }
}

$prefs = Join-Path $profile "prefs.js"
if (!(Test-Path $prefs)) {
  throw "Firefox prefs.js was not created. web-ext stderr: $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)"
}

$prefsText = Get-Content $prefs -Raw
$manifestText = Get-Content $manifest -Raw -Encoding UTF8
$extensionId = ($manifestText | ConvertFrom-Json).browser_specific_settings.gecko.id
if ([string]::IsNullOrWhiteSpace($extensionId)) {
  throw "The built Firefox manifest must include an extension ID."
}
$required = @(
  $extensionId,
  "extensions.webextensions.uuids"
)

$missing = $required | Where-Object { !$prefsText.Contains($_) }
if ($missing.Count -gt 0) {
  throw "Firefox sideload smoke failed. Missing prefs entries: $($missing -join ', ')"
}

$hasSidebarKeys =
  $manifestText.Contains('"sidebar_action"') -or
  $manifestText.Contains('"side_panel"') -or
  $manifestText.Contains('"sidebar"')
if ($hasSidebarKeys) {
  throw "Firefox sideload smoke failed. Manifest unexpectedly contains sidebar keys."
}

[PSCustomObject]@{
  ok = $true
  profile = $profile
  stdout = $stdout
  stderr = $stderr
  extensionId = $extensionId
  sidebarRegistered = $false
} | ConvertTo-Json
