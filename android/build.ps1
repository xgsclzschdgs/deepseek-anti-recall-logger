# DeepSeek 文字留痕 · Android 构建脚本
# 依赖：Node.js、JDK 17、Android SDK Build-Tools、android.jar
# 用法见 README「构建安卓 App」

$ErrorActionPreference = 'Stop'

$APP  = Join-Path $PSScriptRoot 'app'
$W    = Join-Path $env:TEMP 'dsapk'
$OUT  = Join-Path $W 'out'
$TOOL = if ($env:DSLG_TOOLS) { $env:DSLG_TOOLS } else { Join-Path $W 'tool' }

function Stage($n) { Write-Host ''; Write-Host "===== $n =====" }

# ---------- 工具链定位 ----------
$JDK = if ($env:DSLG_JDK) { $env:DSLG_JDK } else {
    (Get-ChildItem $TOOL -Directory -Filter 'jdk*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1).FullName
}
$BT = if ($env:DSLG_BUILD_TOOLS) { $env:DSLG_BUILD_TOOLS } else {
    (Get-ChildItem $TOOL -Directory -Filter 'android-*' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'aapt2.exe') } |
        Sort-Object Name -Descending | Select-Object -First 1).FullName
}
$PLAT = if ($env:DSLG_PLATFORM) { $env:DSLG_PLATFORM } else {
    (Get-ChildItem $TOOL -Directory -Filter 'android-*' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'android.jar') } |
        Sort-Object Name -Descending | Select-Object -First 1).FullName
}
foreach ($p in @($JDK, $BT, $PLAT)) {
    if (-not $p -or -not (Test-Path $p)) { throw "工具链缺失：请设置 DSLG_TOOLS / DSLG_JDK / DSLG_BUILD_TOOLS / DSLG_PLATFORM" }
}
$env:JAVA_HOME = $JDK
$env:PATH = "$JDK\bin;$env:PATH"

# ---------- 密钥（绝不写入仓库） ----------
$KS = $env:DSLG_KEYSTORE
$KSPASS = $env:DSLG_KS_PASS
$ALIAS = if ($env:DSLG_KEY_ALIAS) { $env:DSLG_KEY_ALIAS } else { 'dslogger' }
if (-not $KS -or -not (Test-Path $KS)) { throw '缺少签名密钥：请设置 DSLG_KEYSTORE 指向你的 keystore' }
if (-not $KSPASS) { throw '缺少密钥口令：请设置 DSLG_KS_PASS' }

# ---------- 版本号（以 AndroidManifest 为准） ----------
[xml]$mf = Get-Content (Join-Path $APP 'AndroidManifest.xml')
$VC = [string]$mf.manifest.versionCode
$VN = [string]$mf.manifest.versionName
if (-not $VC -or -not $VN) { throw 'AndroidManifest.xml 缺少 versionCode/versionName' }

New-Item -ItemType Directory -Force -Path $OUT, (Join-Path $OUT 'classes'), (Join-Path $OUT 'dex') | Out-Null

Stage '0. prep assets'
node (Join-Path $PSScriptRoot 'prep.js')
if ($LASTEXITCODE -ne 0) { throw 'prep failed' }

Stage '1. aapt2 compile resources'
$resZip = Join-Path $OUT 'res.zip'
if (Test-Path $resZip) { Remove-Item $resZip -Force }
& (Join-Path $BT 'aapt2.exe') compile --dir (Join-Path $APP 'res') -o $resZip 2>&1
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Stage '1b. aapt2 link'
$baseApk = Join-Path $OUT 'base.apk'
if (Test-Path $baseApk) { Remove-Item $baseApk -Force }
& (Join-Path $BT 'aapt2.exe') link -o $baseApk -I (Join-Path $PLAT 'android.jar') `
    --manifest (Join-Path $APP 'AndroidManifest.xml') `
    -A (Join-Path $APP 'assets') `
    $resZip `
    --min-sdk-version 24 --target-sdk-version 34 `
    --version-code $VC --version-name $VN 2>&1
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }
Write-Host ('base.apk size: {0}' -f (Get-Item $baseApk).Length)

Stage '2. javac'
Remove-Item (Join-Path $OUT 'classes\*') -Recurse -Force -ErrorAction SilentlyContinue
$srcList = @(Get-ChildItem (Join-Path $APP 'src') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
& (Join-Path $JDK 'bin\javac.exe') -encoding UTF-8 -source 8 -target 8 `
    -classpath (Join-Path $PLAT 'android.jar') -d (Join-Path $OUT 'classes') $srcList 2>&1
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }
$classes = @(Get-ChildItem (Join-Path $OUT 'classes') -Recurse -Filter '*.class')
Write-Host ('class count: {0}' -f $classes.Count)

Stage '3. d8 dex'
Remove-Item (Join-Path $OUT 'dex\*') -Force -ErrorAction SilentlyContinue
$cf = @($classes | ForEach-Object { $_.FullName })
& (Join-Path $BT 'd8.bat') --release --min-api 24 --lib (Join-Path $PLAT 'android.jar') --output (Join-Path $OUT 'dex') $cf 2>&1
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }
Get-ChildItem (Join-Path $OUT 'dex') | ForEach-Object { Write-Host ('   {0}  {1}' -f $_.Name, $_.Length) }

Stage '4. inject classes.dex'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
foreach ($e in @($zip.Entries | Where-Object { $_.FullName -eq 'classes.dex' })) { $e.Delete() }
[void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $zip, (Join-Path $OUT 'dex\classes.dex'), 'classes.dex',
    [System.IO.Compression.CompressionLevel]::Optimal)
$zip.Dispose()

Stage '5. zipalign'
$aligned = Join-Path $OUT 'app-aligned.apk'
if (Test-Path $aligned) { Remove-Item $aligned -Force }
& (Join-Path $BT 'zipalign.exe') -f -p 4 $baseApk $aligned 2>&1
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

Stage '6. keystore check'
& (Join-Path $JDK 'bin\keytool.exe') -list -keystore $KS -storepass $KSPASS -alias $ALIAS 2>&1 |
    Select-String 'CN=|Alias'
if ($LASTEXITCODE -ne 0) { throw 'keystore 校验失败（口令/别名不正确？）' }

Stage '7. apksigner'
$final = Join-Path $OUT "DeepSeek_Logger_v$VN.apk"
if (Test-Path $final) { Remove-Item $final -Force }
Copy-Item $aligned $final
& (Join-Path $BT 'apksigner.bat') sign --ks $KS --ks-key-alias $ALIAS `
    --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" `
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true $final 2>&1
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

Stage '8. verify'
$verifyOut = & (Join-Path $BT 'apksigner.bat') verify --verbose --print-certs $final 2>&1
$verifyCode = $LASTEXITCODE
$verifyOut | Select-String 'Verifies|certificate SHA-256 digest|Verified using v' | Select-Object -First 6
if ($verifyCode -ne 0) { throw 'APK 签名校验失败' }

Write-Host ''
Write-Host ('FINAL: {0}' -f $final)
Write-Host ('SIZE : {0} bytes' -f (Get-Item $final).Length)
Write-Host ('SHA256: {0}' -f (Get-FileHash $final -Algorithm SHA256).Hash)
