# 构建执行器：脱离会话独立运行完整构建链，完成后写标记文件
$env:WE_PYTHON = 'F:\Program Files\Python3.14\python.exe'
# 以脚本自身位置定位项目根，目录改名或迁移后无需再改脚本
Set-Location (Split-Path -Parent $PSScriptRoot)
Remove-Item logs\build_done.flag -ErrorAction SilentlyContinue
'' | & '.\scripts\构建打包.bat' *> logs\build_t00630b.log
$LASTEXITCODE | Out-File -Encoding ascii logs\build_exitcode.txt
'DONE' | Out-File -Encoding ascii logs\build_done.flag
