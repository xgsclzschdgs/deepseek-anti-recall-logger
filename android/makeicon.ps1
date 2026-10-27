Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Continue'

$res = Join-Path $PSScriptRoot 'app\res'
$sizes = [ordered]@{ 'mipmap-mdpi' = 48; 'mipmap-hdpi' = 72; 'mipmap-xhdpi' = 96; 'mipmap-xxhdpi' = 144; 'mipmap-xxxhdpi' = 192 }

function Fill-RoundedRect($g, $brush, [int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
    if ($r * 2 -gt $w) { $r = [int]($w / 2) }
    if ($r * 2 -gt $h) { $r = [int]($h / 2) }
    $g.FillRectangle($brush, $x + $r, $y, $w - 2 * $r, $h)
    $g.FillRectangle($brush, $x, $y + $r, $w, $h - 2 * $r)
    $d = $r * 2
    $g.FillEllipse($brush, $x, $y, $d, $d)
    $g.FillEllipse($brush, $x + $w - $d, $y, $d, $d)
    $g.FillEllipse($brush, $x, $y + $h - $d, $d, $d)
    $g.FillEllipse($brush, $x + $w - $d, $y + $h - $d, $d, $d)
}

foreach ($k in $sizes.Keys) {
    $S = $sizes[$k]
    $dir = Join-Path $res $k
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $bmp = New-Object System.Drawing.Bitmap($S, $S)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 29, 78, 216))
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 220, 38, 38))

    Fill-RoundedRect $g $blue 0 0 $S $S ([int]($S * 0.22))

    $mx = [int]($S * 0.23); $my = [int]($S * 0.16)
    $mw = [int]($S * 0.54); $mh = [int]($S * 0.66)
    Fill-RoundedRect $g $white $mx $my $mw $mh ([int]($S * 0.07))

    $lineH = [Math]::Max(1, [int]($S * 0.06))
    $lx = $mx + [int]($S * 0.10)
    $lw = $mw - [int]($S * 0.20)
    $y1 = $my + [int]($S * 0.15)
    $g.FillRectangle($blue, $lx, $y1, $lw, $lineH)
    $g.FillRectangle($blue, $lx, ($y1 + [int]($S * 0.14)), $lw, $lineH)
    $g.FillRectangle($blue, $lx, ($y1 + [int]($S * 0.28)), [int]($lw * 0.6), $lineH)

    $dr = [int]($S * 0.32)
    $dx = $S - $dr - [int]($S * 0.06)
    $dy = $S - $dr - [int]($S * 0.06)
    $g.FillEllipse($white, ($dx - [int]($S * 0.035)), ($dy - [int]($S * 0.035)), ($dr + [int]($S * 0.07)), ($dr + [int]($S * 0.07)))
    $g.FillEllipse($red, $dx, $dy, $dr, $dr)

    $penW = [Math]::Max(1.0, $S * 0.05)
    $wpen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penW)
    $wpen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $wpen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $cx = [int]($dx + $dr / 2)
    $g.DrawLine($wpen, $cx, ($dy + $dr * 0.30), $cx, ($dy + $dr * 0.58))
    $dotR = [Math]::Max(1.0, $penW * 0.6)
    $g.FillEllipse($white, ($cx - $dotR), ($dy + $dr * 0.68), ($dotR * 2), ($dotR * 2))

    $g.Dispose()
    $out = Join-Path $dir 'ic_launcher.png'
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ('{0}  {1}px  {2} bytes' -f $k, $S, (Get-Item $out).Length)
}
Write-Host 'icons done'
