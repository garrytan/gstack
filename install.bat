@echo off
setlocal

set TARGET=%USERPROFILE%\.claude\skills\gstack

echo Installing gstack to %TARGET% ...

if exist "%TARGET%" (
    echo Existing installation found. Removing...
    rmdir /s /q "%TARGET%"
)

xcopy /e /i /q "%~dp0" "%TARGET%"

cd /d "%TARGET%"

:: Find Git Bash and run setup
set "GITBASH="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if "%GITBASH%"=="" if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "GITBASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if "%GITBASH%"=="" for /f "delims=" %%i in ('where bash 2^>nul') do set "GITBASH=%%i"

if "%GITBASH%"=="" (
    echo.
    echo WARNING: Git Bash not found. Skipping setup.
    echo Install Git for Windows, then re-run install.bat, or run ./setup from Git Bash manually.
    echo.
) else (
    echo Running setup via Git Bash...
    "%GITBASH%" -c "cd '%TARGET%' && ./setup"
)

echo.
echo gstack installed globally. Available in all Claude Code sessions.
echo Skills: all gstack skills are now available.
echo.
echo To uninstall, run uninstall.bat
pause
