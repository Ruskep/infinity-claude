Add-Type -AssemblyName System.Drawing

# 1) Render SVG logo -> PNG sizes using Electron (pixel-perfect sparkle)
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root "node_modules\.bin\electron.cmd"
$render = Join-Path $PSScriptRoot "render-icons.js"
& $electron $render | Out-Null
if (-not $?) { Write-Error "render-icons failed"; exit 1 }

# 2) Pack pre-rendered PNGs into icon.ico
$autoDir = Join-Path $PSScriptRoot "_auto-icon"
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs = @()
foreach ($s in $sizes) {
  $pngs += Join-Path $autoDir ("icon-{0}.png" -f $s)
}

$entries = @()
foreach ($p in $pngs) {
  $sz = [int]([System.IO.Path]::GetFileName($p) -replace '[^0-9]' , '')
  $bytes = [System.IO.File]::ReadAllBytes($p)
  $entries += [PSCustomObject]@{
    Size   = $sz
    Length = $bytes.Length
    Data   = $bytes
  }
}

$headerLen = 6 + 16 * $entries.Count
$offset = $headerLen
$iconBytes = New-Object System.Collections.Generic.List[byte]

function AddU16([System.Collections.Generic.List[byte]]$lst, [uint16]$v) {
  foreach ($x in [BitConverter]::GetBytes($v)) { $lst.Add($x) }
}
function AddU32([System.Collections.Generic.List[byte]]$lst, [int]$v) {
  foreach ($x in [BitConverter]::GetBytes([uint32]$v)) { $lst.Add($x) }
}

AddU16 $iconBytes 0          # reserved
AddU16 $iconBytes 1          # type: icon
AddU16 $iconBytes ([uint16]$entries.Count)

foreach ($e in $entries) {
  $b = $e.Size
  $iconBytes.Add([byte]$(if ($b -ge 256) { 0 } else { $b }))   # width
  $iconBytes.Add([byte]$(if ($b -ge 256) { 0 } else { $b }))   # height
  $iconBytes.Add([byte]0)   # colors
  $iconBytes.Add([byte]0)   # reserved
  AddU16 $iconBytes 1       # planes
  AddU16 $iconBytes 32      # bpp
  AddU32 $iconBytes $e.Length
  AddU32 $iconBytes $offset
  $offset += $e.Length
}

foreach ($e in $entries) {
  foreach ($x in $e.Data) { $iconBytes.Add($x) }
}

$ico = Join-Path $PSScriptRoot "icon.ico"
[System.IO.File]::WriteAllBytes($ico, $iconBytes.ToArray())
Write-Output ("ICO written: {0} ({1} bytes, {2} sizes)" -f $ico, $iconBytes.Count, $entries.Count)