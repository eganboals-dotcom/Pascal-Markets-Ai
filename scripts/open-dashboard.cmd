@echo off
REM Pascal Markets - opens the Kalshi scanner dashboard in its own window. Double-click to run.
REM Closing the window also stops the local server this started.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0open-dashboard.ps1"
