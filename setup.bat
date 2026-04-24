@echo off
REM gstack setup - Windows batch version
REM For Windows users who want to set up gstack without WSL/Git Bash
REM 
REM This script:
REM   1. Checks for bun
REM   2. Builds binaries for Windows
REM   3. Registers gstack with Claude Code and other agents
REM
REM Usage: setup.bat
REM or run via Node.js: node setup.ts

setlocal enabledelayedexpansion

echo.
echo ==== gstack setup (Windows) ====
echo.

REM Get script directory
set "GSTACK_DIR=%~dp0"
set "GSTACK_DIR=%GSTACK_DIR:~0,-1%"

echo Home: %USERPROFILE%
echo gstack: %GSTACK_DIR%
echo.

REM Check for bun
echo Checking for bun...
bun --version >nul 2>&1
if errorlevel 1 (
    echo Error: bun is required but not installed
    echo Install with: powershell -Command "iwr https://bun.sh/install.ps1 | iex"
    exit /b 1
)
for /f "tokens=*" %%i in ('bun --version') do echo Found: %%i

REM Build binaries
echo.
echo Building binaries...
cd /d "%GSTACK_DIR%"
call bun run build
if errorlevel 1 (
    echo Build failed
    exit /b 1
)

REM Register with Claude Code
echo.
echo Registering with Claude Code...
set "CLAUDE_SKILLS=%USERPROFILE%\.claude\skills"
set "CLAUDE_GSTACK=%CLAUDE_SKILLS%\gstack"

if not exist "%CLAUDE_SKILLS%" (
    mkdir "%CLAUDE_SKILLS%"
)

REM Remove old directory if exists
if exist "%CLAUDE_GSTACK%" (
    echo Existing installation found at %CLAUDE_GSTACK%
    echo Updating...
    rmdir /s /q "%CLAUDE_GSTACK%" 2>nul
)

REM Try to create junction (symlink for directory)
mklink /J "%CLAUDE_GSTACK%" "%GSTACK_DIR%" >nul 2>&1
if errorlevel 1 (
    echo Note: Could not create junction (requires admin), copying directory instead...
    REM Fallback: copy directory
    xcopy "%GSTACK_DIR%" "%CLAUDE_GSTACK%" /E /I /Y >nul
)

echo Claude Code: registered at %CLAUDE_GSTACK%

REM Register with Codex (if installed)
set "CODEX_SKILLS=%USERPROFILE%\.codex\skills"
set "CODEX_GSTACK=%CODEX_SKILLS%\gstack"

if exist "%CODEX_SKILLS%" (
    echo.
    echo Registering with Codex...
    if exist "%CODEX_GSTACK%" (
        rmdir /s /q "%CODEX_GSTACK%" 2>nul
    )
    mklink /J "%CODEX_GSTACK%" "%GSTACK_DIR%" >nul 2>&1
    if errorlevel 1 (
        xcopy "%GSTACK_DIR%" "%CODEX_GSTACK%" /E /I /Y >nul
    )
    echo Codex: registered at %CODEX_GSTACK%
)

echo.
echo Setup complete! You can now use gstack with your AI agent.
echo.

endlocal
