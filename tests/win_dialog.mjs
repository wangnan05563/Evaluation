/** 原生模态框驱动与文案取证（Windows UIA + Win32 BM_CLICK）。
 *  由 tests/shell_close_smoke.mjs（开发态）与 tests/prod_smoke.mjs（免安装产物）共用，
 *  两侧校验的是同一个 TaskDialog，期望文案在此逐字硬编码（不复用 i18n-shell.js 的表内容）——
 *  表写错了也必须被测出来，否则测试没有判定力。 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CLOSE_TEXTS = {
  'en-US': {
    title: 'Close Window',
    message: 'What should happen when you close the window?',
    detail: '"Minimize to tray" keeps the app running in the background, ready to restore from the tray icon. "Close the app" quits the program.',
    buttons: ['Minimize to tray', 'Close the app'],
    checkbox: 'Remember this choice and do not ask again'
  },
  'zh-CN': {
    title: '关闭窗口',
    message: '关闭窗口时要执行什么操作？',
    detail: '「最小化到托盘」会让应用继续在后台运行，可从托盘图标恢复；「直接关闭应用」将退出程序。',
    buttons: ['最小化到托盘', '直接关闭应用'],
    checkbox: '记住此选择，下次不再提示'
  }
}

// PS 侧把非 ASCII、反斜杠、双引号统一转成 \uXXXX，这里还原即可——比对不受控制台代码页影响
export const unesc = s => JSON.parse('"' + s + '"')

export function readDialogTexts(out) {
  const r = { title: '', texts: [], checkbox: '', buttons: [] }
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('DLG_NAME=')) r.title = unesc(line.slice('DLG_NAME='.length))
    else if (line.startsWith('CHK_NAME=')) r.checkbox = unesc(line.slice('CHK_NAME='.length))
    else if (line.startsWith('TEXT=')) r.texts.push(unesc(line.slice('TEXT='.length)))
    else if (line.startsWith('BTN=')) r.buttons.push(unesc(line.slice('BTN='.length)))
  }
  return r
}

// 关闭弹框是系统 TaskDialog（#32770），不是 DOM，CDP 触达不到。定位路径经实测：
// UIA 里它挂在主窗口的后代节点下，按钮以 ControlType.Pane（无 Invoke pattern）暴露，
// 但 Win32 侧是 class=Button 的真实子窗口，故复选框走 UIA Toggle、按钮走 BM_CLICK。
// 脚本只保留 ASCII，避免 Windows PowerShell 5.1 的源码编码歧义。
const UIA_PS = String.raw`param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [int]$Tick = 0,
  [int]$Button = -1,
  [int]$Dump = 0,
  [int]$Mode = 0,
  [int]$WaitMs = 20000,
  [int]$GraceMs = 0
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WD {
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr res);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
}
"@
# 文案以 \uXXXX 转义输出：PowerShell 控制台是 GBK，直接打印中文会被活动代码页毁字节，
# Node 侧再 JSON.parse 还原，比对结果与代码页无关（T03957 双语断言用）。
function Esc([string]$s) {
  $o = ''
  foreach ($c in $s.ToCharArray()) {
    $n = [int][char]$c
    # 反斜杠与双引号也转义掉，输出里的 \uXXXX 才不会有歧义，Node 侧可直接 JSON.parse 还原
    if ($n -ge 32 -and $n -lt 127 -and $c -ne '\' -and $c -ne '"') { $o += $c } else { $o += '\u' + $n.ToString('x4') }
  }
  return $o
}
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]
$ctProp = $AE::ControlTypeProperty
$clsCond = New-Object $PC($AE::ClassNameProperty, '#32770')
$deadline = [datetime]::Now.AddMilliseconds($WaitMs)
$dlg = $null
while ([datetime]::Now -lt $deadline) {
  foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ProcessId -ne $ProcId) { continue }
    if ($w.Current.ClassName -eq '#32770') { $dlg = $w; break }
    $d = $w.FindFirst($TS::Descendants, $clsCond)
    if ($null -ne $d) { $dlg = $d; break }
  }
  if ($null -ne $dlg) { break }
  Start-Sleep -Milliseconds 300
}
# 停手信号必须与调用方一致：shell_close_smoke/prod_smoke 的重试循环按 'DIALOG=not_found'
# 判断「弹框已销毁、别再补按」。写 absent 时那个判断从来没生效过（T04475 实测）。
if ($null -eq $dlg) { Write-Output 'DIALOG=not_found'; exit 2 }
$dlgHwnd = [IntPtr]$dlg.Current.NativeWindowHandle
# 按钮按「屏幕位置从左到右」编号，不按 EnumChildWindows 的返回顺序：那个顺序是 z-order，
# 补按一次就可能翻转（T04475 实测：E 第一次按被吞、补按按同一序号点到了另一个按钮，
# 落盘的 close_action 从 exit_app 变成 minimize_to_tray）。位置序与文案表 CLOSE_TEXTS 的
# 左右顺序一致，才敢拿它当稳定的按钮句柄。
$btnRaw = New-Object 'System.Collections.Generic.List[System.IntPtr]'
$kcb = [WD+EnumProc] { param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  $null = [WD]::GetClassNameW($h, $sb, 256)
  if ($sb.ToString() -eq 'Button' -and [WD]::IsWindowVisible($h)) { $null = $script:btnRaw.Add($h) }
  return $true }
$null = [WD]::EnumChildWindows($dlgHwnd, $kcb, [IntPtr]::Zero)
$btnPairs = @()
foreach ($h in $btnRaw) {
  $r = New-Object WD+RECT
  $null = [WD]::GetWindowRect($h, [ref]$r)
  $btnPairs += , @{ H = $h; X = [int]$r.L; T = [int]$r.T }
}
$btnHwnds = New-Object 'System.Collections.Generic.List[System.IntPtr]'
foreach ($b in ($btnPairs | Sort-Object -Property @{E={ $_.T }; A=$true}, @{E={ $_.X }; A=$true})) { $btnHwnds.Add($b.H) }
Write-Output ('DIALOG=found HWND=' + ($dlgHwnd -ne [IntPtr]::Zero) + ' BUTTONS=' + $btnHwnds.Count)
$chk = $dlg.FindFirst($TS::Descendants, (New-Object $PC($ctProp, [System.Windows.Automation.ControlType]::CheckBox)))
if ($null -eq $chk) { Write-Output 'CHECKBOX=absent'; exit 4 }
$tp = $chk.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
$sp = [System.Windows.Automation.TogglePattern]::ToggleStateProperty
$before = [string]$chk.GetCurrentPropertyValue($sp)
$after = $before
if ($Tick -eq 1) {
  $null = $tp.Toggle()
  # Toggle() 之后立刻读会撞上 UIA 缓存：实测同一份代码有几次读到 Off→Off（其实已勾上，
  # 落盘的 remember_choice=true 反证）。这里轮询到状态真的变了再收工，最多等 1s。
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 50
    $after = [string]$chk.GetCurrentPropertyValue($sp)
    if ($after -ne $before) { break }
  }
}
Write-Output ('CHECKBOX_BEFORE=' + $before + ' CHECKBOX_AFTER=' + $after)
if ($Dump -eq 1) {
  Write-Output ('DLG_NAME=' + (Esc $dlg.Current.Name))
  $tcond = New-Object $PC($ctProp, [System.Windows.Automation.ControlType]::Text)
  foreach ($t in $dlg.FindAll($TS::Descendants, $tcond)) { Write-Output ('TEXT=' + (Esc $t.Current.Name)) }
  Write-Output ('CHK_NAME=' + (Esc $chk.Current.Name))
  foreach ($h in $btnHwnds) {
    $sb2 = New-Object System.Text.StringBuilder 512
    $null = [WD]::GetWindowTextW($h, $sb2, 512)
    Write-Output ('BTN=' + (Esc $sb2.ToString()))
  }
}
# Button=-1 表示只取证不点击（先 dump 再按文案选按钮，避免硬编码按钮序号）
if ($Button -lt 0) { Write-Output 'INVOKE=skip'; exit 0 }
if ($Button -ge $btnHwnds.Count) { Write-Output 'BUTTON=missing'; exit 3 }
# 把「这一按按在哪个按钮上」写进证据：序号在不同调用之间是否同义，只有文案能自证。
$sbB = New-Object System.Text.StringBuilder 512
$null = [WD]::GetWindowTextW($btnHwnds[$Button], $sbB, 512)
Write-Output ('BTN_CLICKED=' + (Esc $sbB.ToString()))
# T04475：BM_CLICK 的返回不代表「决策被接住」——实测首按约 1/4 被 TaskDialog 吞掉（空载 30 次吞 7 次），
# 消息照常投递成功（SendMessageTimeout 返回 TRUE）、对话框却还开着。所以这里以
# 「对话框窗口是否真的没了」为投递判据，超时发送还能把「目标线程不取消息」和「吞点击」分开。
# T04505 在这条判据旁边加了三条可对照的投递通道：
#   1 = UIA InvokePattern.Invoke()  2 = UIA LegacyIAccessible.DoDefaultAction()
#   3 = 先 SetForegroundWindow+SetFocus 再 BM_CLICK（T04475 留下的参照，当时只有 8 次样本）
# UIA 两条通道走 COM（CUIAutomation8）而不是 managed System.Windows.Automation：后者压根没有
# LegacyIAccessiblePattern 这个类型（实测 TypeNotFound），用 managed 试通道 2 会把「客户端没实现」
# 读成「通道被吞」。投递判据四条共用一条：按完后 IsWindow(对话框句柄) 变 false。
# 「本次要按的那个按钮」仍按文案匹配（T04475 的 z-order 教训：按错按钮会把决策按成另一个动作）；
# 各来源的收获量打进 UIA_COM 行，好让「点击压根发不出去」与「发出去但被吞」可分。
function CTN([int]$n) {
  if ($n -eq 50000) { return 'Button' }
  if ($n -eq 50033) { return 'Pane' }
  if ($n -eq 50025) { return 'CheckBox' }
  if ($n -eq 50026) { return 'Text' }
  return "ct$n"
}
$res = [IntPtr]::Zero
$sent = $false
$err = 0
$why = ''
$channel = 'bm_click'
$patUsed = $null
if ($Mode -eq 1) { $channel = 'uia_invoke' }
if ($Mode -eq 2) { $channel = 'legacy_iaccessible' }
if ($Mode -eq 3) { $channel = 'foreground_focus' }
if ($Mode -eq 1 -or $Mode -eq 2) {
  $patId = 10000
  if ($Mode -eq 2) { $patId = 10015 }
  $wantName = $sbB.ToString()
  $uia = $null
  $comErr = ''
  try { $uia = New-Object -ComObject 'CUIAutomation8' } catch {
    try { $uia = New-Object -ComObject 'CUIAutomation' } catch { $comErr = $_.Exception.Message }
  }
  if ($null -ne $uia) {
    $sub = @()
    $subErr = ''
    try {
      $arr = $uia.ElementFromHandle($dlgHwnd).FindAll(4, $uia.CreateTrueCondition())
      for ($i = 0; $i -lt $arr.Length; $i++) { $sub += $arr.GetElement($i) }
    } catch { $subErr = $_.Exception.Message }
    $ctBtn = 0; $patCnt = 0; $named = 0; $hit = $null
    foreach ($e in $sub) {
      $n = ''
      try { $n = [string]$e.CurrentName } catch { $n = '' }
      try { if ($e.CurrentControlType -eq 50000) { $ctBtn += 1 } } catch { }
      if ($n -eq $wantName) { $named += 1 }
      $p = $null
      try { $p = $e.GetCurrentPattern($patId) } catch { $p = $null }
      if ($null -ne $p) {
        $patCnt += 1
        if ($null -eq $hit -and $n -eq $wantName) { $hit = @{ E = $e; P = $p } }
      }
    }
    $elH = $null
    try { $elH = $uia.ElementFromHandle($btnHwnds[$Button]) } catch { $elH = $null }
    $via = 'none'; $ctX = 'no-element'; $hName = ''
    if ($null -ne $hit) {
      $patUsed = $hit.P; $via = 'walk_pattern'
      try { $ctX = CTN ([int]$hit.E.CurrentControlType) } catch { }
    } elseif ($null -ne $elH) {
      $via = 'from_handle'
      try { $ctX = CTN ([int]$elH.CurrentControlType); $hName = [string]$elH.CurrentName } catch { }
      $p = $null
      try { $p = $elH.GetCurrentPattern($patId) } catch { $p = $null }
      if ($null -ne $p -and $hName -eq $wantName) { $patUsed = $p; $via = 'from_handle_pattern' }
    }
    Write-Output ('UIA_COM=ok PATID=' + $patId +
      ' SUB=' + $sub.Count + ' CTBUTTON=' + $ctBtn + ' PATELEM=' + $patCnt + ' NAMEMATCH=' + $named +
      ' VIA=' + $via + ' CT=' + $ctX + ' HASPAT=' + [bool]($null -ne $patUsed) +
      ' SUBERR=' + (Esc $subErr))
  } else {
    # COM 客户端起不来（本机 CUIAutomation8/CUIAutomation ProgID 未注册，0x80040154）时退回
    # managed System.Windows.Automation。managed 只表达得出 InvokePattern——LegacyIAccessible
    # 压根没有对应类型，所以通道 2 在这里明确写 NOTE=no_managed_type，
    # 别把「这个客户端问不出来」记成「这个控件不支持」。
    $all = @()
    try { $all = @($dlg.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) } catch { $all = @() }
    $wantPt = $null
    if ($Mode -eq 1) { $wantPt = [System.Windows.Automation.InvokePattern]::Pattern }
    $ctBtn = 0; $patCnt = 0; $named = 0
    foreach ($e in $all) {
      $n = ''
      try { $n = [string]$e.Current.Name } catch { }
      try { if ($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $ctBtn += 1 } } catch { }
      if ($n -eq $wantName) { $named += 1 }
      $p = $null
      if ($null -ne $wantPt) { try { $p = $e.GetCurrentPattern($wantPt) } catch { $p = $null } }
      if ($null -ne $p) {
        $patCnt += 1
        if ($null -eq $patUsed -and $n -eq $wantName) { $patUsed = $p }
      }
    }
    $elH = $null
    try { $elH = $AE::FromHandle($btnHwnds[$Button]) } catch { }
    $ctH = 'no-handle'
    if ($null -ne $elH) { try { $ctH = [string]$elH.Current.ControlType.ProgrammaticName } catch { } }
    if ($null -eq $patUsed -and $null -ne $wantPt -and $null -ne $elH) {
      $p = $null
      try { $p = $elH.GetCurrentPattern($wantPt) } catch { $p = $null }
      if ($null -ne $p -and [string]$elH.Current.Name -eq $wantName) { $patUsed = $p }
    }
    Write-Output ('UIA_MANAGED=1 SUB=' + $all.Count + ' PATID=' + $patId +
      ' CTBUTTON=' + $ctBtn + ' PATELEM=' + $patCnt + ' NAMEMATCH=' + $named + ' CT=' + $ctH +
      ' HASPAT=' + [bool]($null -ne $patUsed) +
      $(if ($Mode -eq 2) { ' NOTE=no_managed_type_for_LegacyIAccessible' } else { '' }) +
      ' COMERR=' + (Esc $comErr))
  }
  if ($null -eq $patUsed) { $why = 'pattern_unavailable' }
}
if ($Mode -eq 3) {
  $fore = [WD]::SetForegroundWindow($dlgHwnd)
  $foc = [WD]::SetFocus($btnHwnds[$Button])
  Write-Output ('PRE=FOREGROUND=' + $fore + ' FOCUS=' + ($foc -ne [IntPtr]::Zero))
}
$t0 = [datetime]::Now
if ($Mode -eq 0 -or $Mode -eq 3) {
  $sent = [WD]::SendMessageTimeoutW($btnHwnds[$Button], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 15000, [ref]$res)
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
} elseif ($null -ne $patUsed) {
  try {
    if ($Mode -eq 1) { $patUsed.Invoke() } else { $patUsed.DoDefaultAction() }
    $sent = $true
  } catch { $why = 'threw' }
}
$stillOpen = 'yes'
$settle = -1
for ($q = 0; $q -lt 14; $q++) {
  Start-Sleep -Milliseconds 50
  if (-not [WD]::IsWindow($dlgHwnd)) { $stillOpen = 'no'; $settle = [int]([datetime]::Now - $t0).TotalMilliseconds; break }
}
# GRACE：T04505 只给探针用的第二条判据。700ms 内窗口还在（DIALOG_AFTER=yes）不等于「这一按被吞」——
# 也可能是销毁排队。给到 GraceMs 再问一次，把两种形状分开；回归调用传 0，行为与本参数存在时一致。
$grace = 'off'
if ($GraceMs -gt 0) {
  if ($stillOpen -eq 'no') { $grace = 'closed' }
  else {
    $grace = 'open'
    for ($g = 0; $g -lt [int]($GraceMs / 100); $g++) {
      Start-Sleep -Milliseconds 100
      if (-not [WD]::IsWindow($dlgHwnd)) { $grace = 'closed@' + [int]([datetime]::Now - $t0).TotalMilliseconds; break }
    }
  }
}
Write-Output ('CHANNEL=' + $channel + ' INVOKE=' + $(if ($sent) { 'sent' } elseif ($why) { $why } else { 'failed err=' + $err }) + ' DIALOG_AFTER=' + $stillOpen + ' SETTLE_MS=' + $settle + ' GRACE=' + $grace)
`

let uiaScript = null
/** 驱动一次原生弹框。mode：0=BM_CLICK（默认，S17/装包烟测沿用）、1=UIA InvokePattern.Invoke、
 *  2=UIA LegacyIAccessible.DoDefaultAction、3=先抢前台+给焦点再 BM_CLICK。1/2/3 是 T04505 为
 *  「首按被吞」加的对照通道（只由 tests/tools/native_dialog_probe.mjs 用，回归仍走 0）；
 *  四条通道的投递判据同一条：IsWindow(对话框句柄) 变 false。 */
export function driveDialog(pid, { tick = 0, button = -1, dump = 0, mode = 0, waitMs = 20000, graceMs = 0 } = {}) {
  if (!uiaScript) {
    // BOM：Windows PowerShell 5.1 无 BOM 时脚本内容解析不稳
    uiaScript = path.join(os.tmpdir(), `we_uia_dialog_${process.pid}.ps1`)
    fs.writeFileSync(uiaScript, '\ufeff' + UIA_PS)
  }
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uiaScript,
    '-ProcId', String(pid), '-Tick', String(tick), '-Button', String(button), '-Dump', String(dump),
    '-Mode', String(mode), '-WaitMs', String(waitMs), '-GraceMs', String(graceMs)], { encoding: 'utf8' })
  // PowerShell stdout 是 CRLF，留着 \r 会让按行前缀匹配的解析全部落空
  const clean = s => (s || '').replace(/\r/g, '').trim()
  const out = clean(r.stdout) + (r.stderr ? ' | ERR:' + clean(r.stderr) : '')
  return { out, code: r.status }
}

export function cleanupDialogScript() {
  for (const f of [uiaScript, winScript]) {
    try { if (f) fs.rmSync(f, { force: true }) } catch { /* noop */ }
  }
}

// Win32 侧「窗口在不在屏幕上」的判据。CDP 的 document.visibilityState 会被 Chromium 的
// 遮挡（occlusion）记账影响——弹框盖住主窗时可能报 hidden，据此断言会假失败；
// IsWindowVisible 只看 ShowWindow 状态，hide() 之后必定为 false，才是关闭行为要的量。
const WIN_PS = String.raw`param(
  [Parameter(Mandatory = $true)][int]$ProcId
)
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WH {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$total = 0
$visible = 0
$cb = [WH+EnumProc] { param($h, $l)
  $owner = 0
  $null = [WH]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($owner -eq $script:ProcId) {
    $sb = New-Object System.Text.StringBuilder 256
    $null = [WH]::GetClassNameW($h, $sb, 256)
    # Electron 主窗的 Win32 类名是 Chrome_WidgetWin_1；系统弹框是 #32770，这里天然被排除
    if ($sb.ToString() -eq 'Chrome_WidgetWin_1') {
      $script:total += 1
      if ([WH]::IsWindowVisible($h)) { $script:visible += 1 }
    }
  }
  return $true }
$null = [WH]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output ('WINDOWS_TOTAL=' + $total + ' VISIBLE=' + $visible)
`
let winScript = null
export function probeWindow(pid) {
  if (!winScript) {
    winScript = path.join(os.tmpdir(), `we_win_probe_${process.pid}.ps1`)
    fs.writeFileSync(winScript, '\ufeff' + WIN_PS)
  }
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript, '-ProcId', String(pid)],
    { encoding: 'utf8' })
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\r/g, '').trim()
  const m = out.match(/WINDOWS_TOTAL=(\d+) VISIBLE=(\d+)/)
  return { total: m ? Number(m[1]) : -1, visible: m ? Number(m[2]) : -1, out }
}
