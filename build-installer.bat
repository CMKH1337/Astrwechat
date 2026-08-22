@echo off
setlocal
set "PROJECT_DIR=%~dp01.1.0"
if not exist "%PROJECT_DIR%\build-installer.ps1" (
    echo Cannot find 1.1.0\build-installer.ps1
    exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\build-installer.ps1" %*
exit /b %ERRORLEVEL%
