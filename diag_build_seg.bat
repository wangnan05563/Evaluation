
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

REM === DIAG SEGMENT ===
REM 旧冒烟标记可能来自上一次构建（SKIP_CLEAN=1 时 release 不清空），先删避免误读
if exist "%ZIP_DIR%\logs\prod_smoke.exit" del /q "%ZIP_DIR%\logs\prod_smoke.exit" >nul 2>&1
if exist "%ZIP_DIR%\logs\prod_smoke.log" del /q "%ZIP_DIR%\logs\prod_smoke.log" >nul 2>&1
set "EB_TMP=%TEMP%\we-eb-out"
if exist "%EB_TMP%" rd /s /q "%EB_TMP%" >nul 2>&1
if not exist "%EB_TMP%" mkdir "%EB_TMP%"
"!NODE_EXE!" node_modules\electron-builder\cli.js --win nsis -c.directories.output=%EB_TMP%
if errorlevel 1 (
    echo   [ERROR] electron-builder failed, see output above
    if "%WE_PUBLISH%"=="1" set "BUILD_FAILED=1"
    goto :done_summary
)
set "SETUP_BUILT=0"
set "SETUP_SRC="
rem T00630: version is date-seq (changes every build), locate setup.exe by wildcard
for %%f in ("%EB_TMP%\WorkloadEstimate-*-setup.exe") do set "SETUP_SRC=%%~ff"
if defined SETUP_SRC move /Y "%SETUP_SRC%" "%ZIP_DIR%\" >nul 2>&1
set "SETUP_DST="
for %%f in ("%ZIP_DIR%\WorkloadEstimate-*-setup.exe") do set "SETUP_DST=%%~ff"
if defined SETUP_DST (
    echo   [OK] installer: !SETUP_DST!
    set "SETUP_BUILT=1"
) else (
    echo   [WARN] installer not generated, see electron-builder output above
    if "%WE_PUBLISH%"=="1" set "BUILD_FAILED=1"
)
REM 发布链专用：win-unpacked 只存在于临时输出（历史修复——不落 release，避免 app.asar
REM 被 IDE/索引独占导致 release 目录删不掉）。必须在清理临时目录之前就地冒烟，
REM 结果写 release\logs\prod_smoke.exit（退出码）与 prod_smoke.log，供 publish.ps1 读取。
if "%WE_PROD_SMOKE%"=="1" if not defined BUILD_FAILED (
    set "WE_PROD_DIR="
    if not exist "%EB_TMP%\win-unpacked" (
        echo   [WARN] win-unpacked missing in temp output, prod smoke cannot run
        if "%WE_PUBLISH%"=="1" set "BUILD_FAILED=1"
    ) else (
        echo   [INFO] unpacked-product smoke (temp output, not released)...
        set "WE_PROD_DIR=%EB_TMP%\win-unpacked"
        REM 构建期间可能有别的实例重新占住 8020；先按端口回收（与清理脚本同口径）
        for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8020.*LISTENING"') do taskkill /F /T /PID %%a >nul 2>&1
        REM 发布门 watchdog 从产物脚本的 15 分钟压到 3 分钟，避免流水线长时间挂起
        set "WE_PROD_WATCHDOG_MS=180000"
        "!NODE_EXE!" tests\prod_smoke.mjs > "%ZIP_DIR%\logs\prod_smoke.log" 2>&1
        set "SMOKE_RC=!ERRORLEVEL!"
        (echo !SMOKE_RC!)> "%ZIP_DIR%\logs\prod_smoke.exit"
        if not "!SMOKE_RC!"=="0" (
            echo   [WARN] prod smoke failed, exit=!SMOKE_RC! (see release\logs\prod_smoke.log)
            if "%WE_PUBLISH%"=="1" set "BUILD_FAILED=1"
        ) else (
            echo   [OK] prod smoke passed
        )
        set "WE_PROD_DIR="
    )
)
if exist "%EB_TMP%" rd /s /q "%EB_TMP%" >nul 2>&1
:done_summary

REM 发布模式：electron-builder / 冒烟失败必须让发布脚本感知（手动构建维持原行为）
if defined BUILD_FAILED (
    echo   [FAIL] 发布模式构建失败（electron-builder 或免安装冒烟），中断发布
    if not "%1"=="-NoPause" pause >nul
    exit /b 1
)

REM 完成
echo.
echo ========================================
echo   构建打包完成
echo ========================================
echo   源码压缩包 : %ZIP_PATH%
echo   注: release 下为全部可重建产物（exe/安装包/PyInstaller 缓存/日志），可用 scripts\清理发布目录.bat 随时清空
if "!EXE_EXISTS!"=="1" echo   可执行版exe  : %ZIP_DIR%\exe\工作量评估工具.exe
if "!SETUP_BUILT!"=="1" echo   桌面安装包  : !SETUP_DST!
echo.
pause >nul
exit /b 0
