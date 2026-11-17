@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
REM ============================================================
REM WorkloadEval one-click publish (build + GitHub Release).
REM Thin ASCII entry: delegate all logic to publish.ps1 (UTF-8 BOM).
REM
REM v2 preflight (aligned with AirMirror one-click publish launcher):
REM   0) load GH_TOKEN / GITHUB_TOKEN from repo-root .env, never echo the value
REM   1) tool checks: git, PowerShell, gh (optional); python/node resolved by ps1 config
REM   2) required files: publish.ps1 / publish.config.json / publish-release.py / package.json
REM   3) dry-run awareness, exit-code banner, pause on double-click
REM
REM Usage (this .bat lives in scripts/):
REM   one-click publish              build + publish
REM   one-click publish -SkipBuild  reuse the existing setup.exe
REM   one-click publish -DryRun     build + smoke, print publish actions only
REM   one-click publish -PreflightOnly  run preflight checks only, no build / upload
REM   set GH_DRY_RUN=1 && one-click publish
REM
REM Env (all optional):
REM   GH_TOKEN / GITHUB_TOKEN   GitHub PAT, or repo-root .env (see scripts\.env.example)
REM   GH_DRY_RUN=1              dry run without touching GitHub
REM   NO_PAUSE=1                skip the final pause (CI / automation)
REM
REM Encoding: pure ASCII, no BOM, CRLF - enforced by scripts\verify.ps1.
REM ============================================================
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
cd /d "%REPO_ROOT%" || goto :fail
set "RELEASE_PS=%SCRIPT_DIR%publish.ps1"
set "CONFIG_JSON=%SCRIPT_DIR%publish.config.json"
set "PUBLISHER_PY=%SCRIPT_DIR%publish-release.py"
set "ENV_FILE=%REPO_ROOT%\.env"
set "EXTRA=%*"

echo.
echo [PRE] WorkloadEval publish preflight

REM --- 0. credentials from .env: environment wins, value is never printed ---
if not defined GH_TOKEN (
    for /f "tokens=1,* delims==" %%a in ('findstr /i "^GH_TOKEN=" "%ENV_FILE%" 2^>nul') do set "GH_TOKEN=%%b"
)
if not defined GITHUB_TOKEN (
    for /f "tokens=1,* delims==" %%a in ('findstr /i "^GITHUB_TOKEN=" "%ENV_FILE%" 2^>nul') do set "GITHUB_TOKEN=%%b"
)
if defined GH_TOKEN set "GH_TOKEN=!GH_TOKEN:"=!"
if defined GITHUB_TOKEN set "GITHUB_TOKEN=!GITHUB_TOKEN:"=!"
REM .env values are often single-quoted too; strip both quote styles before they reach the Bearer header.
if defined GH_TOKEN set "GH_TOKEN=!GH_TOKEN:'=!"
if defined GITHUB_TOKEN set "GITHUB_TOKEN=!GITHUB_TOKEN:'=!"
REM publish-release.py only reads GH_TOKEN: map GITHUB_TOKEN when GH_TOKEN is absent.
if not defined GH_TOKEN if defined GITHUB_TOKEN set "GH_TOKEN=!GITHUB_TOKEN!"
if defined GH_TOKEN (
    echo [OK]   GitHub token loaded from environment or .env - value hidden
) else (
    echo [WARN] No GH_TOKEN/GITHUB_TOKEN found; publish.ps1 will check git credential helper.
)

REM --- 1. tools ---
REM One git call replaces "where git" + "git --version": each extra process costs
REM several seconds on guarded Windows shells, while the version line proves git works.
set "GITVER="
for /f "tokens=*" %%v in ('git --version 2^>nul') do set "GITVER=%%v"
if not defined GITVER (
    echo [FAIL] git not found. Install Git for Windows and add it to PATH.
    goto :fail
)
echo [OK]   !GITVER!

where powershell >nul 2>nul
if errorlevel 1 (
    echo [FAIL] PowerShell not found; publish.ps1 cannot run.
    goto :fail
)
echo [OK]   PowerShell available

where gh >nul 2>nul
if errorlevel 1 (
    echo [INFO] gh CLI not installed; publishing uses GitHub REST via GH_TOKEN.
) else (
    echo [INFO] gh CLI available; this pipeline still uses GitHub REST.
)
echo [INFO] Python / Node resolved by publish.ps1 from publish.config.json

REM --- 2. required files ---
for %%F in ("%RELEASE_PS%" "%CONFIG_JSON%" "%PUBLISHER_PY%" "%REPO_ROOT%\package.json") do (
    if not exist "%%~F" (
        echo [FAIL] Missing required file: %%~F
        goto :fail
    )
)
echo [OK]   publish.ps1 / publish.config.json / publish-release.py / package.json present

REM --- 3. dry-run awareness: substring test is pure variable substitution,
REM     so args containing & or | cannot break out into a command ---
set "DRY=0"
if defined GH_DRY_RUN if "!GH_DRY_RUN!"=="1" set "DRY=1"
set "DRYCHK=!EXTRA:-DryRun=!"
if not "!DRYCHK!"=="!EXTRA!" set "DRY=1"
if "!DRY!"=="1" echo [INFO] DRY-RUN: build and smoke still run; GitHub upload is skipped.

echo.
echo [INFO] Delegating to publish.ps1 !EXTRA!
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%RELEASE_PS%" !EXTRA!
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
    echo [FAIL] Publish pipeline exited with code %CODE%. See PowerShell output above.
    goto :fail
)

echo.
echo [DONE] Publish finished. Release URL is printed above by publish.ps1.
if not defined NO_PAUSE pause
exit /b 0

:fail
echo [FAIL] Publish aborted by preflight or pipeline error.
if not defined NO_PAUSE pause
exit /b 1
