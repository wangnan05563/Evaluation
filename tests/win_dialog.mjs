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
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool join);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
}
"@
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
// T04539 通道 4：不经 UIA 的原生 MSAA。UIA 那两条（通道 1/2）在本机问不出 pattern，
// 所以「默认动作到底能不能发出去」这个问题一直没被真正量过——oleacc 才是 TaskDialog 按钮
// 背后那一层（系统控件的 IAccessible 由 oleacc 代理提供），走它才能把「客户端问不出来」
// 与「控件不支持」分开。
// 两个必须写死的坑（都是本机实测撞出来的）：
//  · IAccessible 是 IDispatch 派生的 dual 接口，vtable = IUnknown 3 + IDispatch 4 + 自身 20。
//    声明成 InterfaceIsIUnknown 会少算 IDispatch 那 4 个槽，第一次 get_accName 直接打进
//    GetTypeInfoCount → System.AccessViolationException，整个 PS 进程当场崩。
//  · 走查逻辑必须写在 C# 里，不能写在 PowerShell 里：PowerShell 拿到 RCW 后按 __ComObject
//    做晚期绑定，typed interface 的方法名根本绑不上，每条调用都抛
//    「System.__ComObject 不包含名为 get_accName 的方法」。若外面裹了 try/catch，
//    这就会被读成「CHILDCOUNT=0、代理没给子表」——假结论就是这么来的。
[ComImport]
[Guid("618736e0-3c3d-11cf-810c-00aa00389b71")]
[InterfaceType(ComInterfaceType.InterfaceIsDual)]
public interface MSAA_IAccessible {
  [PreserveSig] int get_accParent([MarshalAs(UnmanagedType.Interface)] out MSAA_IAccessible ppaccParent);
  [PreserveSig] int get_accChildCount([MarshalAs(UnmanagedType.Struct)] out object pvarChildCount);
  [PreserveSig] int get_accChild([In] object varChildId, [MarshalAs(UnmanagedType.Interface)] out MSAA_IAccessible ppaccChild);
  [PreserveSig] int get_accName([In] object varChildId, [MarshalAs(UnmanagedType.BStr)] out string pszName);
  [PreserveSig] int get_accValue([In] object varChildId, [MarshalAs(UnmanagedType.BStr)] out string pszValue);
  [PreserveSig] int get_accDescription([In] object varChildId, [MarshalAs(UnmanagedType.BStr)] out string pszDescription);
  [PreserveSig] int get_accRole([In] object varChildId, [MarshalAs(UnmanagedType.Struct)] out object pvarRole);
  [PreserveSig] int get_accState([In] object varChildId, [MarshalAs(UnmanagedType.Struct)] out object pvarState);
  [PreserveSig] int get_accHelp([In] object varChildId, [MarshalAs(UnmanagedType.BStr)] out string pszHelp);
  [PreserveSig] int get_accHelpTopic([MarshalAs(UnmanagedType.BStr)] out string pszHelpFile, [In] object varChildId, [Out] out int pidHelpTopic);
  [PreserveSig] int get_accKeyboardShortcut([In] object varChildId, [MarshalAs(UnmanagedType.BStr)] out string pszKeyboardShortcut);
  [PreserveSig] int get_accFocus([MarshalAs(UnmanagedType.Struct)] out object pvarChild);
  [PreserveSig] int get_accSelection([MarshalAs(UnmanagedType.Struct)] out object pvarChildren);
  [PreserveSig] int get_accDefaultAction([In] object varChildId, [MarshalAs(UnmanagedType.BStr)] out string pszDefaultAction);
  [PreserveSig] int accSelect(int flagsSelect, [In] object varChildId);
  [PreserveSig] int accLocation(out int pxLeft, out int pyTop, out int pcxWidth, out int pcyHeight, [In] object varChildId);
  [PreserveSig] int accNavigate(int navDir, [In] object varChildStart, [MarshalAs(UnmanagedType.Struct)] out object pvarChild);
  [PreserveSig] int accHitTest(int xLeft, int yTop, [MarshalAs(UnmanagedType.Struct)] out object pvarChild);
  [PreserveSig] int accDoDefaultAction([In] object varChildId);
  [PreserveSig] int put_accValue([In] object varChildId, [MarshalAs(UnmanagedType.BStr)] string pszNewValue);
}
public static class MSAAW {
  // ROLE_SYSTEM_PUSHBUTTON = 0x2B = 43。不是 22——22 是 ROLE_SYSTEM_ANIMATION，
  // 早先按 22 匹配过，永远匹配不上，那时误当成「代理不给子对象」。
  public const int PB = 43;
  [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, int dwId, ref Guid riid, out IntPtr ppvObject);
  struct PT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out PT p);
  static string Hex(int hr) { return "0x" + hr.ToString("x8"); }
  static int RoleOf(object r) { try { return Convert.ToInt32(r); } catch { return -1; } }
  // 与 PS 侧 Esc 同一口径：非 ASCII、反斜杠、双引号转 \uXXXX，Node 侧 JSON.parse 还原。
  static string Esc(string s) {
    if (s == null) return "";
    StringBuilder o = new StringBuilder();
    foreach (char c in s) {
      if (c >= 32 && c < 127 && c != '\\' && c != '"') o.Append(c);
      else o.Append("\\u").Append(((int) c).ToString("x4"));
    }
    return o.ToString();
  }

  // doAct=1 且命中「role=43 且 accName 与目标文案逐字相等」的子对象时，真的把默认动作发出去。
  // 命中判据只认文案，不认序号（T04475 z-order 教训）。返回一行取证串，RESULT 是唯一口径：
  //   sent=调用带 0 的 HRESULT 回来；not_issued=命中了但这一路只取证不点；其余
  //   （accessible_object_failed / no_children / name_unmatched / hr=0x…）都是「压根没发到控件」，
  //   必须与「发出去但被对话框吞掉」分开计。
  public static string Run(IntPtr hwnd, int objid, string wantName, int doAct) {
    StringBuilder sb = new StringBuilder();
    sb.Append("OBJID=" + objid + " ");
    Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
    IntPtr ptr;
    int hrGet = AccessibleObjectFromWindow(hwnd, objid, ref iid, out ptr);
    sb.Append("GET_HR=" + Hex(hrGet) + " ");
    if (hrGet != 0 || ptr == IntPtr.Zero) return sb.ToString() + "RESULT=accessible_object_failed";
    MSAA_IAccessible acc = null;
    try { acc = Marshal.GetTypedObjectForIUnknown(ptr, typeof(MSAA_IAccessible)) as MSAA_IAccessible; }
    catch (Exception e) { return sb.ToString() + "WRAP_THREW=" + Esc(e.GetType().Name + ":" + e.Message) + " RESULT=wrap_failed"; }
    if (acc == null) return sb.ToString() + "RESULT=wrap_null";

    string selfName = null; object selfRole = null; object cc = null;
    int hrN = acc.get_accName(0, out selfName);
    int hrR = acc.get_accRole(0, out selfRole);
    int hrC = acc.get_accChildCount(out cc);
    int n = 0; try { n = Convert.ToInt32(cc); } catch { }
    sb.Append("SELF_NAME_HR=" + Hex(hrN) + " SELF_NAME=" + Esc(selfName) +
      " SELF_ROLE_HR=" + Hex(hrR) + " SELF_ROLE=" + RoleOf(selfRole) +
      " CC_HR=" + Hex(hrC) + " CC=" + n + " ");
    if (n <= 0) {
      // 对话框的 client 对象实测报 0 个子对象（CC_HR=0 且自身 name/role 都对，不是调用失败）。
      // 这时唯一还能问到的形状是「对象自己」——按钮 HWND 的 IAccessible 正是这种。
      string sda = null; int hrSDA = -1;
      try { hrSDA = acc.get_accDefaultAction(0, out sda); }
      catch (Exception e) { hrSDA = -2; sda = e.GetType().Name; }
      object sst = null; try { acc.get_accState(0, out sst); } catch { }
      sb.Append("SELF_DA_HR=" + Hex(hrSDA) + " SELF_DA=" + Esc(sda) + " SELF_STATE=" + sst + " ");
      if (RoleOf(selfRole) != PB || selfName != wantName) return sb.ToString() + "RESULT=no_children";
      return Issue(acc, 0, doAct, sb, PB);
    }

    MSAA_IAccessible hitObj = null; object hitId = null; int btnCnt = 0, nameCnt = 0;
    int lim = n > 48 ? 48 : n;
    for (int i = 1; i <= lim; i++) {
      MSAA_IAccessible child = null; int hrChild = -99;
      try { hrChild = acc.get_accChild(i, out child); } catch { child = null; }
      MSAA_IAccessible q = (child != null) ? child : acc;
      object cid = (child != null) ? (object) 0 : (object) i;
      string cn = null; object cr = null; string cda = null;
      try { q.get_accName(cid, out cn); } catch { }
      try { q.get_accRole(cid, out cr); } catch { }
      try { q.get_accDefaultAction(cid, out cda); } catch { }
      int roleI = RoleOf(cr);
      sb.Append("KID[" + i + "]" + (child != null ? "/obj" : ("/id" + i)) +
        " chdHr=" + Hex(hrChild) + " role=" + roleI + " name=" + Esc(cn) + " da=" + Esc(cda) + ";");
      if (roleI == PB) btnCnt++;
      if (cn == wantName) nameCnt++;
      if (hitObj == null && roleI == PB && cn == wantName) { hitObj = q; hitId = cid; }
    }
    sb.Append("PUSHBUTTONS=" + btnCnt + " NAMEMATCH=" + nameCnt + " ");
    if (hitObj == null) return sb.ToString() + "RESULT=name_unmatched";
    return Issue(hitObj, hitId, doAct, sb, PB);
  }

  static string Issue(MSAA_IAccessible hit, object hitId, int doAct, StringBuilder sb, int role) {
    sb.Append("TARGET=" + (Convert.ToInt32(hitId) == 0 ? "self" : "child_id") +
      " ROLE=" + role + " CHILDID=" + hitId + " ");
    string da = null; object st0 = null;
    try { hit.get_accDefaultAction(hitId, out da); } catch { }
    try { hit.get_accState(hitId, out st0); } catch { }
    sb.Append("DEFAULT_ACTION=" + Esc(da) + " STATE_BEFORE=" + st0 + " ");
    if (doAct != 1) return sb.ToString() + "RESULT=not_issued";
    // CURSOR_DELTA：oleacc 若靠合成鼠标输入实现「默认动作」，指针必然被搬动。为 0 才说明
    // 它走的是消息/直接调用，不是把屏幕坐标点了一遍——这条决定了它算不算 BM_CLICK 的换皮。
    PT p0, p1; GetCursorPos(out p0);
    int hrCall = -1;
    try { hrCall = hit.accDoDefaultAction(hitId); }
    catch (Exception e) { sb.Append("CALL_THREW=" + Esc(e.GetType().Name + ":" + e.Message) + " "); }
    GetCursorPos(out p1);
    object st1 = null; try { hit.get_accState(hitId, out st1); } catch { }
    sb.Append("CALL_HR=" + Hex(hrCall) + " CURSOR_DELTA=" + Math.Abs(p1.X - p0.X) + "," +
      Math.Abs(p1.Y - p0.Y) + " STATE_AFTER=" + st1 + " ");
    return sb.ToString() + "RESULT=" + (hrCall == 0 ? "sent" : ("hr=" + Hex(hrCall)));
  }
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
$dlgHwnd = [IntPtr]::Zero
$foundVia = 'uia'
if ($null -ne $dlg) { $dlgHwnd = [IntPtr]$dlg.Current.NativeWindowHandle }
else {
  # UIA 兜底前的实测缺口：同一台机器、同一个打法，某些轮 RootElement 的枚举就是看不到刚建好的
  # #32770（T04505 里 15 轮批次的第 1 轮命中，之后弹框一直挂着、后续轮全部 not_found）。
  # 弹框在 Win32 侧确实在（EnumWindows 按 pid + class 找得到），所以先退回 Win32 找句柄：
  # 按钮点击本来就走 Win32 句柄，只有复选框/文案取证还要 UIA——那两样在退回路径上如实标不可用。
  $w32 = New-Object 'System.Collections.Generic.List[System.IntPtr]'
  $kwb = [WD+EnumProc] { param($h, $l)
    $pid2 = 0
    $null = [WD]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($pid2 -ne $ProcId) { return $true }
    $sb = New-Object System.Text.StringBuilder 256
    $null = [WD]::GetClassNameW($h, $sb, 256)
    if ($sb.ToString() -eq '#32770' -and [WD]::IsWindowVisible($h)) { $null = $script:w32.Add($h) }
    return $true }
  $w32Deadline = [datetime]::Now.AddMilliseconds($WaitMs)
  while ([datetime]::Now -lt $w32Deadline) {
    $null = [WD]::EnumWindows($kwb, [IntPtr]::Zero)
    if ($w32.Count -gt 0) { $dlgHwnd = $w32[0]; break }
    Start-Sleep -Milliseconds 300
  }
  if ($dlgHwnd -eq [IntPtr]::Zero) { Write-Output 'DIALOG=not_found'; exit 2 }
  $foundVia = 'win32'
}
Write-Output ('DIALOG_VIA=' + $foundVia)
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
$chk = $null
if ($null -ne $dlg) { $chk = $dlg.FindFirst($TS::Descendants, (New-Object $PC($ctProp, [System.Windows.Automation.ControlType]::CheckBox))) }
if ($null -eq $chk) {
  # UIA 句柄拿不到（退回路径）时，复选框这维如实标不可用而不是谎报 Off；调用方按
  # CHECKBOX_BEFORE=Off / CHECKBOX_AFTER=On 断言，读到这里会红——红了才对。
  # 但「要勾选」（Tick=1）在退回路径上根本做不到，只能停手，不能默默按下去把没勾的当勾了。
  if ($null -eq $dlg) {
    if ($Tick -eq 1) { Write-Output 'CHECKBOX=uia_unavailable'; exit 4 }
    Write-Output 'CHECKBOX_BEFORE=uia_unavailable CHECKBOX_AFTER=uia_unavailable'
  } else { Write-Output 'CHECKBOX=absent'; exit 4 }
} else {
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
}
if ($Dump -eq 1) {
  # 退回路径下 UIA 那三样（对话框标题/正文/复选框文案）取不到，如实标 unavailable：
  # readDialogTexts 拿到空串，断言会红——比假装文案对得上更有用。BTN= 走 Win32，照常出。
  if ($null -ne $dlg) {
    Write-Output ('DLG_NAME=' + (Esc $dlg.Current.Name))
    $tcond = New-Object $PC($ctProp, [System.Windows.Automation.ControlType]::Text)
    foreach ($t in $dlg.FindAll($TS::Descendants, $tcond)) { Write-Output ('TEXT=' + (Esc $t.Current.Name)) }
    Write-Output ('CHK_NAME=' + (Esc $chk.Current.Name))
  } else {
    Write-Output 'DLG_NAME=uia_unavailable'
    Write-Output 'CHK_NAME=uia_unavailable'
  }
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
if ($Mode -eq 4) { $channel = 'msaa_default_action' }
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
  # 通道 3 要测的是「真抢到前台再点」，所以必须自证抢到了没有：跨进程 SetForegroundWindow 会被
  # 前台锁挡掉（实测返回 False），此时它等价于通道 0，拿它的 0/N 当「抢前台有效」是假结论。
  # 顺序：先报当前前台 → 申请放行 → SetForegroundWindow → 不行就补一次 ALT 键（解锁前台锁的常规
  # 手法）→ 还不行用 SwitchToThisWindow → 焦点走 AttachThreadInput 后 SetFocus（跨线程直接 SetFocus 必失败）。
  $dlgPid = 0
  $dlgTid = [WD]::GetWindowThreadProcessId($dlgHwnd, [ref]$dlgPid)
  $foreBefore = [WD]::GetForegroundWindow()
  $allow = [WD]::AllowSetForegroundWindow($dlgPid)
  $fore = [WD]::SetForegroundWindow($dlgHwnd)
  if (-not $fore) {
    [WD]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [WD]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    $fore = [WD]::SetForegroundWindow($dlgHwnd)
  }
  $sw = 'no'
  if (-not $fore) { [WD]::SwitchToThisWindow($dlgHwnd, $true); $sw = 'tried' }
  $cur = [WD]::GetCurrentThreadId()
  $joined = [WD]::AttachThreadInput($cur, $dlgTid, $true)
  $foc = ([WD]::SetFocus($btnHwnds[$Button]) -ne [IntPtr]::Zero)
  if ($joined) { $null = [WD]::AttachThreadInput($cur, $dlgTid, $false) }
  $isFore = ([WD]::GetForegroundWindow() -eq $dlgHwnd)
  Write-Output ('PRE=ALLOW=' + $allow + ' SFW=' + $fore + ' SWITCH=' + $sw +
    ' ATTACH=' + $joined + ' FOCUS=' + $foc + ' IS_FOREGROUND=' + $isFore +
    ' FORE_BEFORE=0x' + ('{0:x}' -f ([long]$foreBefore)) + ' FORE_AFTER=0x' + ('{0:x}' -f ([long][WD]::GetForegroundWindow())))
}
if ($Mode -eq 4) {
  # 通道 4（T04539）：不经 UIA，直接问 oleacc 的 IAccessible 要「默认动作」。
  # 三条自证缺一不可，否则又会写出「返回值对上了但控件没动」这种假结论：
  #   · 先只读取证对话框自己的对象（name/role/childCount 逐个带 HRESULT），再问按钮；
  #   · 命中判据是 role=43(ROLE_SYSTEM_PUSHBUTTON) 且 accName 与目标文案逐字相等——按文案取，绝不按序号；
  #   · accDoDefaultAction 的 PreserveSig HRESULT 与 CURSOR_DELTA，前者=0 才叫「真的送到了控件」，
  #     后者=0 才排除「代理其实是合成鼠标输入」。返回值本身仍不当投递判据。
  # 投递判据与通道 0 同一条：按完后 IsWindow(对话框句柄) 变 false，外加探针的 GRACE 宽限窗。
  # 两条问法按顺序试，实测本机走的是第二条：
  #   ① 对话框 OBJID_CLIENT 的子对象表——TaskDialog 在这里报 CC=0（一个子对象都不给），
  #      并且 get_accDefaultAction 直接 E_NOTIMPL，这条路压根问不到按钮；
  #   ② 按钮 HWND 自己的 OBJID_CLIENT——name/role(43)/默认动作「推」都在，
  #      accDoDefaultAction(CHILDID_SELF) 能发出去。
  # 一发只点一次：MSAA_ISSUE/MSAA_BUTTON 里只有一条会带 doAct=1。
  $wantName = $sbB.ToString()
  $repDlg = [MSAAW]::Run($dlgHwnd, -4, $wantName, 0)
  Write-Output ('MSAA_DIALOG=' + $repDlg)
  $path = 'dialog_children'
  if ($repDlg -match 'RESULT=not_issued') {
    # 子对象表里就命中了：在同一次问法里把默认动作发出去（第二次调用只走命中那一条）
    $rep = [MSAAW]::Run($dlgHwnd, -4, $wantName, 1)
    Write-Output ('MSAA_ISSUE=' + $rep)
  } else {
    # 对话框这层没命中按钮，换「按钮自己的对象」这条问法
    $path = 'button_hwnd'
    $rep = [MSAAW]::Run($btnHwnds[$Button], -4, $wantName, 1)
    Write-Output ('MSAA_BUTTON=' + $rep)
  }
  Write-Output ('MSAA_PATH=' + $path)
  $resTok = ([regex]::Match($rep, 'RESULT=(\S+)')).Groups[1].Value
  # sent 只表示「调用带着 0 的 HRESULT 回来了、且命中对象是按文案挑出来的」；
  # 这一按有没有真的变成关闭决策，仍由下面的 IsWindow 判。
  $sent = ($resTok -eq 'sent')
  if (-not $sent -and -not $why) { $why = $(if ($resTok) { $resTok } else { 'msaa_no_report' }) }
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
 *  2=UIA LegacyIAccessible.DoDefaultAction、3=先抢前台+给焦点再 BM_CLICK、
 *  4=原生 MSAA oleacc IAccessible.accDoDefaultAction（T04539，不经任何 UIA 客户端）。
 *  1/2/3 是 T04505 为「首按被吞」加的对照通道，4 是 T04539 补的那条「问都问不到」的路；
 *  四条对照通道都只由 tests/tools/native_dialog_probe.mjs 用，回归仍走 0。
 *  投递判据全部同一条：IsWindow(对话框句柄) 变 false。 */
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
  [Parameter(Mandatory = $true)][int]$ProcId,
  [switch]$Close
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
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
$total = 0
$visible = 0
# 回调里的 Write-Output 浮不到管道（EnumerWindows 是从 native 代码反过来调它），
# 所以主窗句柄先收进列表，枚举完再打印/再投 WM_CLOSE。
$mainH = New-Object 'System.Collections.Generic.List[System.IntPtr]'
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
      $null = $script:mainH.Add($h)
    }
  }
  return $true }
$null = [WH]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output ('WINDOWS_TOTAL=' + $total + ' VISIBLE=' + $visible)
if ($Close) {
  # WM_CLOSE = 0x0010。刻意不看 PostMessage 的返回值：TRUE 只代表消息进了队列，
  # 「关闭请求有没有真的被接住」由调用方按产品侧的 [close-dialog] shown 行判（同 T04475 口径）。
  foreach ($h in $mainH) {
    $null = [WH]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Write-Output ('CLOSED_HWND=' + $h + ' VIS=' + [WH]::IsWindowVisible($h))
  }
}
`
let winScript = null
function ensureWinScript() {
  if (!winScript) {
    winScript = path.join(os.tmpdir(), `we_win_probe_${process.pid}.ps1`)
    fs.writeFileSync(winScript, '\ufeff' + WIN_PS)
  }
  return winScript
}
const runWinPs = (args) => {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    ensureWinScript(), ...args], { encoding: 'utf8' })
  return ((r.stdout || '') + (r.stderr || '')).replace(/\r/g, '').trim()
}

export function probeWindow(pid) {
  const out = runWinPs(['-ProcId', String(pid)])
  const m = out.match(/WINDOWS_TOTAL=(\d+) VISIBLE=(\d+)/)
  return { total: m ? Number(m[1]) : -1, visible: m ? Number(m[2]) : -1, out }
}

/** 向本进程的「主窗句柄」投 WM_CLOSE —— T04540 的探针专用关闭通道。
 *  和 requestClose 的 taskkill 的区别只在一种场景下要命：主窗已被「最小化到托盘」hide() 之后，
 *  不带 /F 的 taskkill 只给**可见**顶层窗发 WM_CLOSE，实测是个静默空操作（exp3：主窗隐藏后
 *  连发两次 taskkill，[close-dialog] shown 一直停在 1、2 不增；中间两次 PostMessage(主窗, WM_CLOSE)
 *  则把 shown 推到 2 和 3）。探针会把这种「实例其实活得好好的、只是关不掉」误判成实例已废。
 *  真实用户的 X 点击永远发生在可见窗口上，所以 S17/装包烟测沿用 taskkill，只有探针换这条通道。
 *  posted=0 表示该 pid 名下压根没有 Chrome_WidgetWin_1（进程已死或还没建窗）。 */
export function postCloseToMainWindow(pid) {
  const out = runWinPs(['-ProcId', String(pid), '-Close'])
  const handles = [...out.matchAll(/CLOSED_HWND=(\S+) VIS=(\S+)/g)].map(m => ({ hwnd: m[1], visible: m[2] === 'True' }))
  const m = out.match(/WINDOWS_TOTAL=(-?\d+)/)
  return { posted: handles.length, total: m ? Number(m[1]) : -1, handles, out }
}
