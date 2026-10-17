@echo off
setlocal
chcp 65001 >nul 2>&1
REM ============================================================
REM WorkloadEval one-click publish (build + GitHub Release).
REM Thin ASCII entry: delegate all logic to publish.ps1 (UTF-8 BOM).
REM Run: scripts\publish.bat   (double-click also works)
REM Set GH_DRY_RUN=1 to print actions without publishing.
REM ============================================================
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%publish.ps1" %*
exit /b %ERRORLEVEL%
