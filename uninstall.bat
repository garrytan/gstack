@echo off
setlocal

set TARGET=%USERPROFILE%\.claude\skills\gstack

if not exist "%TARGET%" (
    echo gstack is not installed at %TARGET%
    pause
    exit /b 0
)

echo Uninstalling gstack from %TARGET% ...
rmdir /s /q "%TARGET%"

echo.
echo gstack uninstalled.
pause
