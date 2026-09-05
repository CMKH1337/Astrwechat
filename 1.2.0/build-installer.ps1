[CmdletBinding()]
param(
    [switch]$ForceInstall,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot 'package.json'
$releasePath = Join-Path $projectRoot 'release'

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Npm([string[]]$Arguments) {
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

try {
    Set-Location $projectRoot

    if (-not (Test-Path -LiteralPath $packageJsonPath)) {
        throw "package.json was not found: $packageJsonPath"
    }

    $package = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $productName = if ($package.build.productName) { $package.build.productName } else { $package.name }
    $version = $package.version

    Write-Host "${productName} v${version} installer builder" -ForegroundColor Green
    Write-Host "Project directory: $projectRoot"

    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
        $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/'
    }
    Write-Host "Electron Builder binary mirror: $env:ELECTRON_BUILDER_BINARIES_MIRROR" -ForegroundColor DarkGray

    Write-Step 'Checking Node.js and npm'
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'Node.js was not found. Install Node.js 20 or newer and try again.'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm was not found. Check that Node.js is installed and available in PATH.'
    }

    $nodeVersionText = (& node.exe --version).Trim()
    if ($nodeVersionText -notmatch '^v(\d+)') {
        throw "Unable to parse Node.js version: $nodeVersionText"
    }
    $nodeMajor = [int]$Matches[1]
    if ($nodeMajor -lt 20) {
        throw "Node.js $nodeVersionText is too old. This project requires Node.js 20 or newer."
    }
    $npmVersionText = (& npm.cmd --version).Trim()
    Write-Host "Node.js $nodeVersionText / npm $npmVersionText" -ForegroundColor DarkGray

    $workspaceRoot = Split-Path -Parent $projectRoot
    $localFfmpegBinary = if ($env:WEFLOW_FFMPEG_BINARY) {
        $env:WEFLOW_FFMPEG_BINARY
    } else {
        Join-Path $workspaceRoot 'node_modules\ffmpeg-static\ffmpeg.exe'
    }
    $localElectronDist = if ($env:WEFLOW_ELECTRON_DIST) {
        $env:WEFLOW_ELECTRON_DIST
    } else {
        Join-Path $workspaceRoot 'node_modules\electron\dist'
    }
    $canReuseLocalBinaries = (
        (Test-Path -LiteralPath $localFfmpegBinary) -and
        (Test-Path -LiteralPath (Join-Path $localElectronDist 'electron.exe'))
    )

    $electronReady = Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\electron\package.json')
    $builderReady = Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\electron-builder\out\cli\cli.js')
    if ($ForceInstall -or -not $electronReady -or -not $builderReady) {
        if ($canReuseLocalBinaries) {
            Write-Step 'Installing dependencies without remote binary downloads'
            Invoke-Npm @('ci', '--ignore-scripts')

            $targetFfmpegBinary = Join-Path $projectRoot 'node_modules\ffmpeg-static\ffmpeg.exe'
            Copy-Item -LiteralPath $localFfmpegBinary -Destination $targetFfmpegBinary -Force

            $targetElectronDir = Join-Path $projectRoot 'node_modules\electron'
            Copy-Item -LiteralPath $localElectronDist -Destination $targetElectronDir -Recurse -Force
            Write-Host 'Reused local Electron and ffmpeg binaries.' -ForegroundColor DarkGray
        }
        else {
            Write-Step 'Installing dependencies (npm ci)'
            Invoke-Npm @('ci')
        }
    }
    else {
        Write-Host 'Build dependencies found; installation skipped. Use -ForceInstall to reinstall.' -ForegroundColor DarkGray
    }

    Write-Step 'Building frontend, Electron main process, and Windows installer'
    $buildStartedAt = (Get-Date).AddSeconds(-2)
    Invoke-Npm @('run', 'build')

    $installers = @(
        Get-ChildItem -LiteralPath $releasePath -Filter '*Setup.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $buildStartedAt } |
            Sort-Object LastWriteTime -Descending
    )

    if ($installers.Count -eq 0) {
        throw "Build finished, but no new Setup.exe was found in: $releasePath"
    }

    Write-Step 'Build complete'
    foreach ($installer in $installers) {
        Write-Host ("Installer: {0} ({1:N1} MB)" -f $installer.FullName, ($installer.Length / 1MB)) -ForegroundColor Green
    }
    Write-Host "Output directory: $releasePath" -ForegroundColor Green
}
catch {
    Write-Host "`nBuild failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if (-not $NoPause) {
        Write-Host ''
        Read-Host 'Press Enter to exit'
    }
}
