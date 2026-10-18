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
REM cd to repo root so publish-release.py can load .env (GH_TOKEN) from it
set "REPO_ROOT=%SCRIPT_DIR%.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
cd /d "%REPO_ROOT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%publish.ps1" %*
exit /b %ERRORLEVEL%
