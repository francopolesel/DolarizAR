# Empaqueta la extensión en un ZIP limpio listo para compartir.
# Uso: powershell -ExecutionPolicy Bypass -File scripts/pack.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$stage = Join-Path $root 'dist/stage'
$zip = Join-Path $root ("dist/dolarizar-" + $version + ".zip")

if (Test-Path (Join-Path $root 'dist')) { Remove-Item (Join-Path $root 'dist') -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$files = @(
  'manifest.json', 'background.js', 'content.js', 'content.css',
  'popup.html', 'popup.js', 'popup.css', 'README.md'
)
foreach ($f in $files) { Copy-Item (Join-Path $root $f) $stage }
Copy-Item (Join-Path $root 'utils') (Join-Path $stage 'utils') -Recurse
New-Item -ItemType Directory -Path (Join-Path $stage 'icons') | Out-Null
Copy-Item (Join-Path $root 'icons/icon16.png') (Join-Path $stage 'icons')
Copy-Item (Join-Path $root 'icons/icon32.png') (Join-Path $stage 'icons')
Copy-Item (Join-Path $root 'icons/icon48.png') (Join-Path $stage 'icons')
Copy-Item (Join-Path $root 'icons/icon128.png') (Join-Path $stage 'icons')
Copy-Item (Join-Path $root 'extras/INSTALAR-AMIGOS.txt') $stage

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Write-Output ("OK: " + $zip)
tar -tf $zip
