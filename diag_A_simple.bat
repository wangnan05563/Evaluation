@echo off
chcp 936 >nul 2>&1
setlocal enabledelayedexpansion
if "%WE_PROD_SMOKE%"=="1" if not defined BUILD_FAILED (
  echo ENTERED
)
echo AFTER
