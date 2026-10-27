# =============================================================================
#  Douyin4K - build script without Gradle (aapt2 -> javac -> d8 -> zipalign -> apksigner)
#
#  ASCII-only on purpose: Windows PowerShell 5.1 parses BOM-less scripts as ANSI,
#  so any CJK text here would break the parser. Keep this file ASCII.
#
#  Usage:
#    powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
#    powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -Install
#    powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -Reinstall
#
#  Requires: JDK 11+ (java/javac/keytool on PATH), Android SDK (platforms + build-tools)
# =============================================================================
param(
    [string]$SdkPath = 'F:\ruanjian\Android SDK',
    [string]$BuildTools = '36.1.0',
    [string]$Platform = 'android-34',
    [int]$MinSdk = 21,
    [int]$TargetSdk = 33,
    [switch]$Install,
    [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    # ---------------- environment ----------------
    $androidJar = Join-Path $SdkPath "platforms\$Platform\android.jar"
    $btDir = Join-Path $SdkPath "build-tools\$BuildTools"
    foreach ($p in @($androidJar, (Join-Path $btDir 'aapt2.exe'), (Join-Path $btDir 'd8.bat'),
                     (Join-Path $btDir 'zipalign.exe'), (Join-Path $btDir 'apksigner.bat'))) {
        if (-not (Test-Path $p)) { throw "missing build component: $p" }
    }
    if (-not (Get-Command java  -ErrorAction SilentlyContinue)) { throw 'java not on PATH (need JDK 11+)' }
    if (-not (Get-Command javac -ErrorAction SilentlyContinue)) { throw 'javac not on PATH (need JDK 11+)' }

    # d8.bat / apksigner.bat honour JAVA_HOME; stale values (e.g. dead Studio JDK) break them
    try {
        $javaExe = (Get-Command java).Source
        $jdkHome = Split-Path -Parent (Split-Path -Parent $javaExe)
        if (Test-Path (Join-Path $jdkHome 'bin\javac.exe')) { $env:JAVA_HOME = $jdkHome }
    } catch { }
    Write-Host ("      JAVA_HOME -> {0}" -f $env:JAVA_HOME)

    $build    = Join-Path $here 'build'
    $gen      = Join-Path $build 'gen'
    $classes  = Join-Path $build 'classes'
    $dexDir   = Join-Path $build 'dex'
    Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $gen, $classes, $dexDir | Out-Null

    # ---------------- assets: injected userscript ----------------
    $assets = Join-Path $here 'assets'
    New-Item -ItemType Directory -Force -Path $assets | Out-Null
    $userScript = Join-Path $here '..\mobile-web\douyin-4k.user.js'
    if (-not (Test-Path $userScript)) { throw "userscript not found: $userScript" }
    Copy-Item $userScript (Join-Path $assets 'dy4k.js') -Force
    Write-Host ("[1/7] assets/dy4k.js  <- {0} bytes" -f (Get-Item (Join-Path $assets 'dy4k.js')).Length)

    # ---------------- aapt2 compile ----------------
    $resZip = Join-Path $build 'res.zip'
    & (Join-Path $btDir 'aapt2.exe') compile --dir (Join-Path $here 'res') -o $resZip
    if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }
    Write-Host '[2/7] aapt2 compile ok'

    # ---------------- aapt2 link ----------------
    $baseApk = Join-Path $build 'base.apk'
    & (Join-Path $btDir 'aapt2.exe') link `
        -o $baseApk `
        -I $androidJar `
        --manifest (Join-Path $here 'AndroidManifest.xml') `
        -R $resZip `
        -A $assets `
        --java $gen `
        --min-sdk-version $MinSdk `
        --target-sdk-version $TargetSdk `
        --auto-add-overlay
    if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }
    Write-Host ("[3/7] aapt2 link ok ({0} bytes)" -f (Get-Item $baseApk).Length)

    # ---------------- javac ----------------
    $sources  = @()
    $sources += Get-ChildItem -Path (Join-Path $here 'java') -Filter *.java -Recurse | ForEach-Object { $_.FullName }
    $sources += Get-ChildItem -Path $gen -Filter *.java -Recurse | ForEach-Object { $_.FullName }
    & javac --release 11 -encoding UTF-8 -nowarn -classpath $androidJar -d $classes $sources
    if ($LASTEXITCODE -ne 0) { throw 'javac failed' }
    Write-Host '[4/7] javac ok'

    # ---------------- d8 -> classes.dex ----------------
    $classFiles = Get-ChildItem -Path $classes -Filter *.class -Recurse | ForEach-Object { $_.FullName }
    & (Join-Path $btDir 'd8.bat') --lib $androidJar --min-api $MinSdk --output $dexDir $classFiles
    if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }
    $dex = Join-Path $dexDir 'classes.dex'
    if (-not (Test-Path $dex)) { throw 'd8 produced no classes.dex' }
    Write-Host ("[5/7] d8 ok ({0} bytes)" -f (Get-Item $dex).Length)

    # ---------------- put classes.dex into the apk ----------------
    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    # NOTE: pass enum values as strings; PS 5.1 resolves the type literal too late otherwise
    $zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
    try {
        $entry = $zip.GetEntry('classes.dex')
        if ($entry) { $entry.Delete() }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $dex, 'classes.dex', 'Optimal') | Out-Null
    } finally { $zip.Dispose() }
    Write-Host '[6/7] classes.dex packed'

    # ---------------- zipalign + sign ----------------
    $unaligned = Join-Path $build 'unaligned.apk'
    Move-Item $baseApk $unaligned -Force
    $aligned = Join-Path $build 'aligned.apk'
    & (Join-Path $btDir 'zipalign.exe') -f -p 4 $unaligned $aligned
    if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

    $keysDir = Join-Path $here 'keys'
    New-Item -ItemType Directory -Force -Path $keysDir | Out-Null
    $ks = Join-Path $keysDir 'dypc4k.p12'
    if (-not (Test-Path $ks)) {
        Write-Host '      generating keystore...'
        & keytool -genkeypair -keystore $ks -storetype PKCS12 -alias dypc4k `
            -keyalg RSA -keysize 2048 -validity 10950 `
            -storepass dypc4k -keypass dypc4k `
            -dname 'CN=dypc4k, OU=personal, O=dypc4k, L=NA, S=NA, C=CN'
        if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
    }
    $apk = Join-Path $build 'Douyin4K.apk'
    & (Join-Path $btDir 'apksigner.bat') sign `
        --ks $ks --ks-pass 'pass:dypc4k' --key-pass 'pass:dypc4k' `
        --min-sdk-version $MinSdk `
        --out $apk $aligned
    if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }
    & (Join-Path $btDir 'apksigner.bat') verify --verbose $apk | Select-Object -First 5
    Write-Host ("[7/7] signed ok -> {0} ({1:N0} bytes)" -f $apk, (Get-Item $apk).Length)

    # ---------------- optional install ----------------
    if ($Install -or $Reinstall) {
        $devices = (& adb devices) -split "`r?`n" | Where-Object { $_ -match '\sdevice$' }
        if (-not $devices) { throw 'no adb device (enable USB debugging first)' }
        Write-Host '      installing...'
        & adb install -r -d $apk
        if ($LASTEXITCODE -ne 0) { throw 'adb install failed' }
        if ($Reinstall) {
            & adb shell am force-stop com.dypc4k.douyink4
            & adb shell am start -n com.dypc4k.douyink4/.MainActivity
        }
    }

    Write-Host ''
    Write-Host ("APK: {0}" -f $apk)
} finally {
    Pop-Location
}
