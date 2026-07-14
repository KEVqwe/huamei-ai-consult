# Compress images under assets/ for web delivery: resize to max 900px, JPEG quality 75.
# Usage: powershell -ExecutionPolicy Bypass -File deploy\compress-assets.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$assets = Join-Path $root 'assets'
$maxDim = 900
$quality = 75

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)

$totalBefore = 0; $totalAfter = 0; $n = 0
Get-ChildItem $assets -Recurse -File | Where-Object { $_.Extension -match '\.(jpe?g|png)$' } | ForEach-Object {
    $f = $_.FullName
    $before = $_.Length
    $img = [System.Drawing.Image]::FromFile($f)
    $w = $img.Width; $h = $img.Height
    $scale = [math]::Min(1.0, $maxDim / [math]::Max($w, $h))
    $nw = [int]($w * $scale); $nh = [int]($h * $scale)

    $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $nw, $nh)
    $g.Dispose(); $img.Dispose()

    $tmp = "$f.tmp"
    if ($_.Extension -match '\.png$') { $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png) }
    else { $bmp.Save($tmp, $jpegCodec, $encParams) }
    $bmp.Dispose()

    $after = (Get-Item $tmp).Length
    if ($after -lt $before) { Move-Item $tmp $f -Force } else { Remove-Item $tmp }  # keep smaller one
    $totalBefore += $before; $totalAfter += [math]::Min($after, $before); $n++
}
"{0} images: {1:N1} MB -> {2:N1} MB" -f $n, ($totalBefore/1MB), ($totalAfter/1MB)
