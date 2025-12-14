@echo off
setlocal EnableDelayedExpansion

:: HYD Playrate Bot Installer
:: Creates a desktop shortcut for easy launching

title HYD Playrate Bot - Installer

:: Get the directory where this script is located
set "BOT_DIR=%~dp0"
set "BOT_DIR=%BOT_DIR:~0,-1%"

:: Get desktop path
for /f "tokens=2*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" /v Desktop 2^>nul') do set "DESKTOP=%%b"

if not defined DESKTOP (
    set "DESKTOP=%USERPROFILE%\Desktop"
)

echo.
echo ========================================
echo    HYD Playrate Bot - Installer
echo ========================================
echo.

:: Check if Node.js is installed first
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [WARNING] Node.js is not installed yet!
    echo.
    echo The bot requires Node.js to run.
    echo.
    choice /C YN /M "Open Node.js download page now"
    if !ERRORLEVEL! equ 1 (
        start https://nodejs.org
        echo.
        echo After installing Node.js, run this installer again.
        echo.
        pause
        exit /b 0
    )
    echo.
    echo You can install Node.js later, but the bot won't work without it.
    echo.
)

echo [INFO] Bot location: %BOT_DIR%
echo [INFO] Desktop: %DESKTOP%
echo.

:: Create the desktop shortcut using PowerShell
echo [SETUP] Creating desktop shortcut...

set "SHORTCUT_NAME=HYD Playrate Bot"
set "SHORTCUT_PATH=%DESKTOP%\%SHORTCUT_NAME%.lnk"
set "TARGET=%BOT_DIR%\launch.bat"
set "ICON=%SystemRoot%\System32\cmd.exe"

:: Use PowerShell to create shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell; ^
    $shortcut = $ws.CreateShortcut('%SHORTCUT_PATH%'); ^
    $shortcut.TargetPath = '%TARGET%'; ^
    $shortcut.WorkingDirectory = '%BOT_DIR%'; ^
    $shortcut.Description = 'Launch HYD Playrate Bot for Twitch'; ^
    $shortcut.WindowStyle = 1; ^
    $shortcut.Save()"

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to create shortcut!
    echo.
    echo You can still run the bot manually:
    echo   1. Open: %BOT_DIR%
    echo   2. Double-click: launch.bat
    echo.
    pause
    exit /b 1
)

echo [OK] Desktop shortcut created!
echo.

:: Ask if user wants to run setup now
echo ========================================
echo    Installation Complete!
echo ========================================
echo.
echo A shortcut "HYD Playrate Bot" has been added to your desktop.
echo.
echo What the shortcut does:
echo   - First run: Installs dependencies automatically
echo   - After that: Launches the bot directly
echo.

choice /C YN /M "Launch the bot now to complete setup"
if %ERRORLEVEL% equ 1 (
    echo.
    echo Starting bot...
    call "%TARGET%"
) else (
    echo.
    echo You can launch the bot anytime from the desktop shortcut.
    echo.
    pause
)
