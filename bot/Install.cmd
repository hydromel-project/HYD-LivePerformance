@echo off
:: HYD Playrate Bot Installer
:: This launches the PowerShell installer with proper execution policy

cd /d "%~dp0"

:: Check if PowerShell is available
where powershell >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo PowerShell is not available on this system.
    echo Please install PowerShell or use install.bat instead.
    pause
    exit /b 1
)

:: Run the PowerShell installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-PlayrateBot.ps1"
