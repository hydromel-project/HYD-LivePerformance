#Requires -Version 5.1
<#
.SYNOPSIS
    HYD Playrate Bot Installer
.DESCRIPTION
    Installs Node.js (if needed), dependencies, and creates a desktop shortcut.
    Will request elevation if needed for Node.js installation.
#>

param(
    [switch]$Elevated
)

# ============ CONFIGURATION ============
$BotName = "HYD Playrate Bot"
$ConfigUrl = "http://localhost:9030"

# ============ HELPER FUNCTIONS ============

function Write-Header {
    param([string]$Text)
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "   $Text" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Status {
    param(
        [string]$Status,
        [string]$Message,
        [string]$Color = "White"
    )
    $statusColors = @{
        "OK" = "Green"
        "ERROR" = "Red"
        "WARN" = "Yellow"
        "INFO" = "Cyan"
        "SETUP" = "Magenta"
    }
    $sColor = if ($statusColors[$Status]) { $statusColors[$Status] } else { "White" }
    Write-Host "[$Status] " -ForegroundColor $sColor -NoNewline
    Write-Host $Message -ForegroundColor $Color
}

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Request-Elevation {
    param([string]$Reason)

    Write-Host ""
    Write-Status "INFO" "Administrator privileges required: $Reason"
    Write-Host ""

    $scriptPath = $MyInvocation.ScriptName
    if (-not $scriptPath) {
        $scriptPath = $PSCommandPath
    }

    try {
        Start-Process PowerShell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Elevated" -Verb RunAs -Wait
        return $true
    }
    catch {
        Write-Status "ERROR" "Failed to elevate privileges. Please run as Administrator."
        return $false
    }
}

function Test-NodeInstalled {
    try {
        $null = Get-Command node -ErrorAction Stop
        return $true
    }
    catch {
        return $false
    }
}

function Get-NodeVersion {
    if (Test-NodeInstalled) {
        return (node --version 2>$null)
    }
    return $null
}

function Install-NodeJS {
    Write-Header "Installing Node.js"

    # Check if winget is available
    $hasWinget = $false
    try {
        $null = Get-Command winget -ErrorAction Stop
        $hasWinget = $true
    }
    catch {}

    if ($hasWinget) {
        Write-Status "INFO" "Installing Node.js via Windows Package Manager..."
        Write-Host ""

        try {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements

            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

            if (Test-NodeInstalled) {
                Write-Host ""
                Write-Status "OK" "Node.js installed successfully!"
                return $true
            }
        }
        catch {
            Write-Status "WARN" "Winget installation failed, trying alternative..."
        }
    }

    # Fallback: Open download page
    Write-Status "INFO" "Opening Node.js download page..."
    Start-Process "https://nodejs.org"

    Write-Host ""
    Write-Host "Please install Node.js from the website, then run this installer again." -ForegroundColor Yellow
    Write-Host ""

    return $false
}

function New-DesktopShortcut {
    param(
        [string]$Name,
        [string]$TargetPath,
        [string]$WorkingDirectory,
        [string]$Description
    )

    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "$Name.lnk"

    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $TargetPath
        $shortcut.WorkingDirectory = $WorkingDirectory
        $shortcut.Description = $Description
        $shortcut.WindowStyle = 1
        $shortcut.Save()

        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($shell) | Out-Null

        return $true
    }
    catch {
        Write-Status "ERROR" "Failed to create shortcut: $_"
        return $false
    }
}

function Install-Dependencies {
    param([string]$Path)

    Write-Status "SETUP" "Installing npm dependencies..."
    Write-Host "        This may take a minute..." -ForegroundColor Gray
    Write-Host ""

    Push-Location $Path
    try {
        $process = Start-Process -FilePath "npm" -ArgumentList "install" -NoNewWindow -Wait -PassThru

        if ($process.ExitCode -eq 0) {
            Write-Status "OK" "Dependencies installed successfully!"
            return $true
        }
        else {
            Write-Status "ERROR" "npm install failed with exit code $($process.ExitCode)"
            return $false
        }
    }
    catch {
        Write-Status "ERROR" "Failed to run npm install: $_"
        return $false
    }
    finally {
        Pop-Location
    }
}

# ============ MAIN SCRIPT ============

Clear-Host
Write-Header $BotName

# Get script directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $ScriptDir) {
    $ScriptDir = $PWD.Path
}

Write-Status "INFO" "Bot location: $ScriptDir"
Write-Host ""

# Step 1: Check Node.js
Write-Host "Step 1: Checking Node.js..." -ForegroundColor White
Write-Host ""

if (Test-NodeInstalled) {
    $nodeVersion = Get-NodeVersion
    Write-Status "OK" "Node.js $nodeVersion is installed"
}
else {
    Write-Status "WARN" "Node.js is not installed"
    Write-Host ""

    $install = Read-Host "Install Node.js now? (Y/N)"

    if ($install -eq 'Y' -or $install -eq 'y') {
        # Need elevation for winget install
        if (-not (Test-Administrator)) {
            if (-not (Request-Elevation "Install Node.js")) {
                Write-Host ""
                Write-Host "Press any key to exit..." -ForegroundColor Gray
                $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
                exit 1
            }
            # If we get here after elevation, re-run checks
            exit 0
        }

        if (-not (Install-NodeJS)) {
            Write-Host ""
            Write-Host "Press any key to exit..." -ForegroundColor Gray
            $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
            exit 1
        }
    }
    else {
        Write-Host ""
        Write-Status "INFO" "You can install Node.js later from https://nodejs.org"
        Write-Host "        The bot won't work without it." -ForegroundColor Gray
    }
}

Write-Host ""

# Step 2: Install dependencies
Write-Host "Step 2: Installing dependencies..." -ForegroundColor White
Write-Host ""

$nodeModulesPath = Join-Path $ScriptDir "node_modules"
if (Test-Path $nodeModulesPath) {
    Write-Status "OK" "Dependencies already installed"
}
else {
    if (Test-NodeInstalled) {
        if (-not (Install-Dependencies $ScriptDir)) {
            Write-Host ""
            Write-Host "Press any key to exit..." -ForegroundColor Gray
            $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
            exit 1
        }
    }
    else {
        Write-Status "WARN" "Skipping - Node.js not installed"
    }
}

Write-Host ""

# Step 3: Create desktop shortcut
Write-Host "Step 3: Creating desktop shortcut..." -ForegroundColor White
Write-Host ""

$launchBat = Join-Path $ScriptDir "launch.bat"
if (Test-Path $launchBat) {
    if (New-DesktopShortcut -Name $BotName -TargetPath $launchBat -WorkingDirectory $ScriptDir -Description "Launch $BotName for Twitch") {
        Write-Status "OK" "Desktop shortcut created: $BotName"
    }
}
else {
    Write-Status "ERROR" "launch.bat not found in $ScriptDir"
}

Write-Host ""

# Done!
Write-Header "Installation Complete!"

Write-Host "A shortcut '$BotName' has been added to your desktop." -ForegroundColor Green
Write-Host ""
Write-Host "What the shortcut does:" -ForegroundColor White
Write-Host "  - First run: Installs any missing dependencies" -ForegroundColor Gray
Write-Host "  - After that: Launches the bot directly" -ForegroundColor Gray
Write-Host ""
Write-Host "Config panel: " -NoNewline -ForegroundColor White
Write-Host $ConfigUrl -ForegroundColor Cyan
Write-Host ""

# Ask to launch now
$launch = Read-Host "Launch the bot now? (Y/N)"

if ($launch -eq 'Y' -or $launch -eq 'y') {
    Write-Host ""
    Write-Status "INFO" "Starting bot..."
    Start-Process -FilePath $launchBat -WorkingDirectory $ScriptDir
}
else {
    Write-Host ""
    Write-Host "You can launch the bot anytime from the desktop shortcut." -ForegroundColor Gray
    Write-Host ""
    Write-Host "Press any key to exit..." -ForegroundColor Gray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
