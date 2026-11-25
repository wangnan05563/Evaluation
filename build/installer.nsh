; 工作量评估工具 NSIS 安装/卸载前自动关闭运行实例
; 由 electron-builder "nsis.include" 引用（相对项目根 27_Evaluation/）。
; 根因：若工作量评估工具（含 PyInstaller sidecar）正在运行，安装器覆盖 exe 时被占用。
; 宏：customInit（安装前）/ customUnInstall（卸载时）是 electron-builder 注入点。

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!insertmacro GetParent
!include "WordFunc.nsh"
!insertmacro WordFind2X

; 默认安装目录的末级名称：electron-builder 默认取 dev-shell 包名
; workload-estimate-dev-shell；产品要求安装到 ...\Evaluation。这里只改 NSIS 的
; APP_FILENAME，不影响应用显示名、快捷方式名和 exe 文件名。
!ifdef APP_FILENAME
  !undef APP_FILENAME
!endif
!define APP_FILENAME "Evaluation"

; 卸载键名由 electron-builder 按 appId 派生传入（UNINSTALL_APP_KEY）；
; 兜底值与 appId=com.workloadeval.app 对应，appId 变更时需同步更新
!ifdef UNINSTALL_APP_KEY
  !define WE_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
!else
  !define WE_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\6a45f195-e47c-56ce-a9b6-b3d8bfbb792f"
!endif

; 抢救老坏包存量配置（T00850）：老版本把数据写安装目录 resources\we-eval\data，
; 覆盖升级时 electron-builder 会先静默运行旧卸载器删整个安装目录，若不先拷出，
; 新版启动时 _migrate_legacy_data 已无数据可迁。仅当用户级目录尚无 config.json
; 时拷贝，绝不覆盖用户级已有数据；与 server.py 的 _migrate_legacy_data 幂等互补。
!ifndef BUILD_UNINSTALLER

Function _WeRescueLegacyData
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $R0 ""

  ClearErrors
  ReadRegStr $R1 HKCU "${WE_UNINST_KEY}" "UninstallString"
  ${If} ${Errors}
    StrCpy $R1 ""
  ${EndIf}
  ${If} $R1 == ""
    ; per-machine 安装的卸载键在 HKLM 64 位视图（32 位 NSIS 默认读会重定向到
    ; WOW6432Node 读不到）；本产品仅支持 64 位 Windows，读后保持 64 视图无副作用
    SetRegView 64
    ClearErrors
    ReadRegStr $R1 HKLM "${WE_UNINST_KEY}" "UninstallString"
    ${If} ${Errors}
      StrCpy $R1 ""
    ${EndIf}
  ${EndIf}

  ${If} $R1 != ""
    ; UninstallString 形如 "C:\...\Uninstall 工作量评估工具.exe" /currentuser
    ClearErrors
    ${WordFind2X} $R1 '"' '"' "E+1" $R2
    ${IfNot} ${Errors}
    ${AndIf} $R2 != ""
      ${GetParent} $R2 $R3
      StrCpy $R0 "$R3\resources\we-eval\data"
    ${EndIf}
  ${EndIf}

  ${If} $R0 != ""
  ${AndIf} ${FileExists} "$R0\config.json"
    StrCpy $R4 "$APPDATA\WorkloadEval"
    ${IfNot} ${FileExists} "$R4\config.json"
      CreateDirectory "$R4"
      CopyFiles /SILENT "$R0\config.json" "$R4"
      ${If} ${FileExists} "$R0\pert.db"
        CopyFiles /SILENT "$R0\pert.db" "$R4"
      ${EndIf}
      ${If} ${FileExists} "$R0\template.xlsx"
        CopyFiles /SILENT "$R0\template.xlsx" "$R4"
      ${EndIf}
      DetailPrint "已迁移老版本配置到 $R4"
    ${EndIf}
  ${EndIf}

  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; AC-39：安装/升级前把用户数据+配置留一份 preinstall 快照。
; electron-builder 覆盖升级会先静默运行旧卸载器；即使新版本启动迁移失败，
; 也能用 scripts/rollback.py --backup preinstall 还原到升级前状态。
Function _WeBackupBeforeUpgrade
  Push $R0
  Push $R1
  StrCpy $R0 "$APPDATA\WorkloadEval"
  CreateDirectory "$R0\backups\preinstall"
  CreateDirectory "$R0\logs"
  CopyFiles /SILENT "$R0\config.json" "$R0\backups\preinstall"
  CopyFiles /SILENT "$R0\pert.db" "$R0\backups\preinstall"
  CopyFiles /SILENT "$R0\estimation.db" "$R0\backups\preinstall"
  CopyFiles /SILENT "$R0\recognition_rules.json" "$R0\backups\preinstall"
  CopyFiles /SILENT "$R0\rates_versions.json" "$R0\backups\preinstall"
  CopyFiles /SILENT "$R0\template.xlsx" "$R0\backups\preinstall"
  CopyFiles /SILENT "$R0\schema_ver" "$R0\backups\preinstall"
  FileOpen $R1 "$R0\logs\installer.log" a
  ${IfNot} ${Errors}
    FileWrite $R1 "preinstall backup: $R0\backups\preinstall$\r$\n"
    FileClose $R1
  ${EndIf}
  DetailPrint "已备份升级前数据到 $R0\backups\preinstall"
  Pop $R1
  Pop $R0
FunctionEnd

!endif

!macro customInit
  DetailPrint "正在关闭已运行的工作量评估工具 ..."
  nsExec::ExecToLog 'taskkill /f /t /im 工作量评估工具.exe'
  Call _WeBackupBeforeUpgrade
  Call _WeRescueLegacyData
!macroend

!macro customUnInstall
  DetailPrint "正在关闭工作量评估工具进程 ..."
  nsExec::ExecToLog 'taskkill /f /t /im 工作量评估工具.exe'
!macroend
