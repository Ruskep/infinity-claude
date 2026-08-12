$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root "node_modules\.bin\electron.cmd"
$render = Join-Path $PSScriptRoot "render-icons.js"
& $electron $render | Out-Null
if (-not $?) { Write-Error "render-icons failed"; exit 1 }

$src = Join-Path $PSScriptRoot "_auto-icon\icon-256.png"
$dst = Join-Path $PSScriptRoot "icon.png"
Copy-Item -Path $src -Destination $dst -Force
Write-Host "icon.png OK"