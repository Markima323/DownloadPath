@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-native.ps1"
if errorlevel 1 echo Installation failed. See the error message above.
pause
