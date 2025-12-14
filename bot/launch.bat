@echo off
setlocal EnableDelayedExpansion

:: HYD Playrate Bot Launcher
:: This script handles first-time setup and subsequent launches

title HYD Playrate Bot

:: Get the directory where this script is located
cd /d "%~dp0"

:: Colors and formatting
echo.
echo ========================================
echo    HYD Playrate Bot
echo ========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo.
    echo Please install Node.js from:
    echo   https://nodejs.org
    echo.
    echo Download the LTS version, install it, then run this again.
    echo.
    pause
    exit /b 1
)

:: Show Node version
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo [OK] Node.js %NODE_VERSION% found

:: Check if npm is available
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm is not available!
    echo.
    echo This usually means Node.js wasn't installed correctly.
    echo Please reinstall Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Check if dependencies are installed
if not exist "node_modules" (
    echo.
    echo [SETUP] First time setup - installing dependencies...
    echo         This may take a minute...
    echo.

    call npm install

    if !ERRORLEVEL! neq 0 (
        echo.
        echo [ERROR] Failed to install dependencies!
        echo.
        echo Common fixes:
        echo   1. Make sure you have internet connection
        echo   2. Try running as Administrator
        echo   3. Delete node_modules folder and try again
        echo.
        pause
        exit /b 1
    )

    echo.
    echo [OK] Dependencies installed successfully!
    echo.

    :: Create a marker file to indicate successful setup
    echo Setup completed on %date% %time% > ".setup_complete"
)

:: Check if package.json exists
if not exist "package.json" (
    echo [ERROR] package.json not found!
    echo.
    echo The bot files may be corrupted. Please reinstall.
    echo.
    pause
    exit /b 1
)

:: All checks passed - launch the bot
echo.
echo [STARTING] Launching HYD Playrate Bot...
echo.
echo ----------------------------------------
echo   Config Panel: http://localhost:9030
echo ----------------------------------------
echo.
echo Press Ctrl+C to stop the bot.
echo.

:: Run the bot
call npm start

:: If we get here, the bot was stopped
echo.
echo Bot stopped.
pause
