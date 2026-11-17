
@echo off
chcp 936 >nul 2>&1
REM 工作量评估工具构建打包：停止占用 -> 依赖校验 -> 金标准校验 -> 打 zip 发布包
cd /d "%~dp0.."
setlocal enabledelayedexpansion

set "ENGINE_PORT=8020"
if defined WE_PYTHON (set "PY_EXE=%WE_PYTHON%") else (set "PY_EXE=python")
set "ZIP_DIR=release"
set "ZIP_NAME=workload-estimate"
set "ZIP_PATH=%ZIP_DIR%\%ZIP_NAME%.zip"

set "EB_TMP=%TEMP%\we-eb-out"
set "NODE_EXE=C:\PYFIX_~4\fake_node.bat"
set "SETUP_BUILT=1"
set "SETUP_DST=dummy"
if "%WE_PROD_SMOKE%"=="1" if not defined BUILD_FAILED (
  echo   [INFO] unpacked-product smoke (temp output, not released)...
  set "WE_PROD_DIR=%EB_TMP%\win-unpacked"
  set "WE_PROD_WATCHDOG_MS=180000"
  "!NODE_EXE!" tests\prod_smoke.mjs > "release\logs\prod_smoke.log" 2>&1
  set "SMOKE_RC=!ERRORLEVEL!"
  (echo !SMOKE_RC!)> "release\logs\prod_smoke.exit"
  if not "!SMOKE_RC!"=="0" (echo [WARN] failed) else (echo   [OK] prod smoke passed)
  set "WE_PROD_DIR="
)
if defined BUILD_FAILED (echo [FAIL] && exit /b 1)
echo [DONE] exit 0
exit /b 0
