#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S20 一键发布「前置检查」离线回归（不触碰真实 GitHub / 不构建真实产物）。

参考 AirMirror scripts/一键发布.bat 的前置检查项，验证本仓库发布入口：
  静态：bat 纯 ASCII/无 BOM/CRLF、检查项齐备、token 不回显；ps1 UTF-8 BOM/CRLF、
        配置完整性/必需文件/凭据/告警/幂等 tag 提示齐备；publish.config.json 可解析。
  动态：临时沙箱里复制真实 bat + ps1 + 配置，把构建脚本、免安装产物、发布器换成 stub。
        4 个前置检查场景走 -PreflightOnly（不构建/不上传，秒级），1 个走完整 DryRun 链路：
          1) 无 token 且无 git credential helper → 前置即阻断，发布器未被调用
          2) .env 的 GH_TOKEN（带引号）→ 正确载入、不回显
          3) .env 的 GITHUB_TOKEN → 映射为 GH_TOKEN（publish-release.py 只认这个）
          4) git credential.helper 兜底 → 无 env token 也不误杀
          5) GH_DRY_RUN=1 完整链路 → 发布器收到干净 token / 演练标记 / 仓库坐标
          6) 关键文件缺失 → bat 前置检查直接 FAIL
          7) NO_PAUSE=1 → 全程不挂起（每个子进程都带超时 + stdin 关闭）
所有子进程都在 os.tmpdir() 的 we_publish_precheck_* 目录里跑，结束自动回收。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


# 重复字面量统一为模块常量（SonarQube python:S1192）
LOG_CODE_OUT = 'code=%s out=%s'
STEP_VERSION_LABEL = '1/6 读取版本号'
MSG_MISSING_FILE = 'Missing required file'
MSG_NO_CREDENTIAL = '缺少 GitHub 凭据'
MARK_PROD_SMOKE = 'prod_smoke.exit'
FAIL_TAG = '[FAIL]'
ENV_GH_TOKEN_LINE = 'GH_TOKEN="%s"'
ARGS_PREFLIGHT_DRY = '-PreflightOnly -DryRun'
CRED_SOURCE_ENV = 'GH_TOKEN（环境变量 / .env'
MSG_NO_TOKEN_ECHO = '控制台未回显 token 明文'
TAG_DRY_RUN = '[INFO] DRY-RUN'


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
BAT = SCRIPTS / "一键发布.bat"
PS1 = SCRIPTS / "publish.ps1"
CFG = SCRIPTS / "publish.config.json"

fails = []
_LOCK = threading.Lock()
_CTX = threading.local()   # 各动态场景并行跑，check 输出按线程收集后再分组打印


def check(name, ok, detail=""):
    line = ("  PASS  " if ok else "  FAIL  ") + name + ((" | " + detail) if detail and not ok else "")
    sink = getattr(_CTX, "sink", None)
    if sink is not None:
        sink.append(line)
    else:
        print(line, flush=True)
    if not ok:
        with _LOCK:
            fails.append(name)


def _decode(b):
    return b.decode("utf-8", "replace")


# ---------------------------------------------------------------- 静态断言
def _check_bat(t, b):
    check("bat 纯 ASCII + 无 BOM + CRLF",
          all(x < 128 for x in b) and not b.startswith(b"\xef\xbb\xbf")
          and sum(1 for i, x in enumerate(b) if x == 10 and (i == 0 or b[i - 1] != 13)) == 0)
    for token, label in [
        ('findstr /i "^GH_TOKEN="', "bat 从 .env 载入 GH_TOKEN"),
        ('findstr /i "^GITHUB_TOKEN="', "bat 从 .env 载入 GITHUB_TOKEN"),
        ('!GH_TOKEN:"=!', "bat 去掉 token 外层双引号"),
        ("!GH_TOKEN:'=!", "bat 去掉 token 外层单引号"),
        ("!GITHUB_TOKEN!", "bat 把 GITHUB_TOKEN 映射给 GH_TOKEN"),
        ("where git", "bat 检查 git"),
        ("where powershell", "bat 检查 PowerShell"),
        ("where gh", "bat 提示 gh CLI 可选"),
        (MSG_MISSING_FILE, "bat 检查发布链必需文件"),
        ("NO_PAUSE", "bat 支持无人值守跳过 pause"),
        ("set \"CODE=%ERRORLEVEL%\"", "bat 捕获流水线退出码"),
        ("!EXTRA!", "bat 原样透传 -DryRun / -SkipBuild 参数"),
        ("GH_DRY_RUN", "bat 识别演练环境变量"),
        ("-PreflightOnly", "bat 说明自检用法"),
        ("[DONE]", "bat 成功横幅"),
        (":fail", "bat 统一失败出口"),
    ]:
        check(label, token in t)
    echo_lines = [l.strip() for l in t.splitlines() if l.strip().lower().startswith("echo")]
    leaked = [l for l in echo_lines
              if ("GH_TOKEN" in l or "GITHUB_TOKEN" in l) and ("!" in l or "%" in l)]
    check("bat 所有 echo 均不展开 token 变量", not leaked, repr(leaked[:2]))


def _check_ps1(s, p):
    check("ps1 UTF-8 BOM + CRLF", p.startswith(b"\xef\xbb\xbf")
          and sum(1 for i, x in enumerate(p) if x == 10 and (i == 0 or p[i - 1] != 13)) == 0)
    for token, label in [
        ("publish.config.json 缺少必需字段", "ps1 校验配置必需字段"),
        ("缺少发布链必需文件", "ps1 前置统一检查必需文件"),
        (MSG_NO_CREDENTIAL, "ps1 前置阻断缺凭据"),
        ("--get-regexp", "ps1 支持 git 凭据库兜底"),
        ("Invoke-Git", "ps1 用容错包装执行 git（PS 5.1 Stop 模式不误杀）"),
        ("值不回显", "ps1 明确不回显凭据"),
        ("origin 与配置一致", "ps1 校验 origin 与 publish.repo"),
        ("工作树有", "ps1 脏工作树告警"),
        ("不是 main/master", "ps1 非主分支告警"),
        ("DryRun", "ps1 说明演练语义"),
        ("$PreflightOnly", "ps1 支持自检开关"),
        ("幂等规则复用已有 Release", "ps1 tag 已存在时不误杀幂等重发"),
        (MARK_PROD_SMOKE, "ps1 读取构建期冒烟退出码标记"),
        ("WE_PROD_SMOKE", "ps1 注入构建期冒烟开关"),
        ("WE_PUBLISH", "ps1 注入发布模式开关"),
        ("构建未执行免安装产物冒烟", "ps1 缺失冒烟时明确阻断"),
        ("python_required_modules", "ps1 构建前校验 Python 依赖"),
    ]:
        check(label, token in s)
    check("ps1 不再把错误指向不存在的 build_installer.log", "build_installer.log" not in s)
    ps_token_echo = [l for l in s.splitlines()
                     if l.strip().lower().startswith("write-host") and "$env:GH_TOKEN" in l]
    check("ps1 不打印 GH_TOKEN 值", not ps_token_echo, repr(ps_token_echo[:2]))


def _check_builder(builder):
    for token, label in [
        ("WE_PROD_SMOKE", "构建脚本支持发布期冒烟钩子"),
        (MARK_PROD_SMOKE, "构建脚本写出冒烟退出码标记"),
        ("BUILD_FAILED", "构建脚本把 electron-builder 失败升级为阻断"),
        ("exit /b 1", "构建脚本发布模式失败返回非 0"),
        ("tests\\prod_smoke.mjs", "构建脚本在临时目录就地跑冒烟"),
        ("WE_PROD_WATCHDOG_MS=180000", "构建脚本限制发布门冒烟 watchdog"),
    ]:
        check(label, token in builder)
    # T05688 后续：cmd 按括号配块，块内 echo 文本含裸括号会把下一行 set 挤出块
    # 无条件执行（曾致冒烟通过后仍误判 BUILD_FAILED）。子过程内必须保持无括号。
    sub_start = builder.index(":run_smoke")
    sub = builder[sub_start:builder.index("goto :eof", sub_start)]
    paren_echoes = [l for l in sub.splitlines()
                    if l.strip().lower().startswith("echo") and ("(" in l or ")" in l)]
    check("冒烟子过程 echo 文本无裸括号", not paren_echoes, repr(paren_echoes[:1]))
    check("WARN 文案已改为无括号形式", "prod smoke failed, exit=!SMOKE_RC! - see" in builder)


def _check_bat(t, b):
    check("bat 纯 ASCII + 无 BOM + CRLF",
          all(x < 128 for x in b) and not b.startswith(b"\xef\xbb\xbf")
          and sum(1 for i, x in enumerate(b) if x == 10 and (i == 0 or b[i - 1] != 13)) == 0)
    for token, label in [
        ('findstr /i "^GH_TOKEN="', "bat 从 .env 载入 GH_TOKEN"),
        ('findstr /i "^GITHUB_TOKEN="', "bat 从 .env 载入 GITHUB_TOKEN"),
        ('!GH_TOKEN:"=!', "bat 去掉 token 外层双引号"),
        ("!GH_TOKEN:'=!", "bat 去掉 token 外层单引号"),
        ("!GITHUB_TOKEN!", "bat 把 GITHUB_TOKEN 映射给 GH_TOKEN"),
        ("where git", "bat 检查 git"),
        ("where powershell", "bat 检查 PowerShell"),
        ("where gh", "bat 提示 gh CLI 可选"),
        (MSG_MISSING_FILE, "bat 检查发布链必需文件"),
        ("NO_PAUSE", "bat 支持无人值守跳过 pause"),
        ("set \"CODE=%ERRORLEVEL%\"", "bat 捕获流水线退出码"),
        ("!EXTRA!", "bat 原样透传 -DryRun / -SkipBuild 参数"),
        ("GH_DRY_RUN", "bat 识别演练环境变量"),
        ("-PreflightOnly", "bat 说明自检用法"),
        ("[DONE]", "bat 成功横幅"),
        (":fail", "bat 统一失败出口"),
    ]:
        check(label, token in t)
    echo_lines = [l.strip() for l in t.splitlines() if l.strip().lower().startswith("echo")]
    leaked = [l for l in echo_lines
              if ("GH_TOKEN" in l or "GITHUB_TOKEN" in l) and ("!" in l or "%" in l)]
    check("bat 所有 echo 均不展开 token 变量", not leaked, repr(leaked[:2]))


def _check_ps1(s, p):
    check("ps1 UTF-8 BOM + CRLF", p.startswith(b"\xef\xbb\xbf")
          and sum(1 for i, x in enumerate(p) if x == 10 and (i == 0 or p[i - 1] != 13)) == 0)
    for token, label in [
        ("publish.config.json 缺少必需字段", "ps1 校验配置必需字段"),
        ("缺少发布链必需文件", "ps1 前置统一检查必需文件"),
        (MSG_NO_CREDENTIAL, "ps1 前置阻断缺凭据"),
        ("--get-regexp", "ps1 支持 git 凭据库兜底"),
        ("Invoke-Git", "ps1 用容错包装执行 git（PS 5.1 Stop 模式不误杀）"),
        ("值不回显", "ps1 明确不回显凭据"),
        ("origin 与配置一致", "ps1 校验 origin 与 publish.repo"),
        ("工作树有", "ps1 脏工作树告警"),
        ("不是 main/master", "ps1 非主分支告警"),
        ("DryRun", "ps1 说明演练语义"),
        ("$PreflightOnly", "ps1 支持自检开关"),
        ("幂等规则复用已有 Release", "ps1 tag 已存在时不误杀幂等重发"),
        (MARK_PROD_SMOKE, "ps1 读取构建期冒烟退出码标记"),
        ("WE_PROD_SMOKE", "ps1 注入构建期冒烟开关"),
        ("WE_PUBLISH", "ps1 注入发布模式开关"),
        ("构建未执行免安装产物冒烟", "ps1 缺失冒烟时明确阻断"),
        ("python_required_modules", "ps1 构建前校验 Python 依赖"),
    ]:
        check(label, token in s)
    check("ps1 不再把错误指向不存在的 build_installer.log", "build_installer.log" not in s)
    ps_token_echo = [l for l in s.splitlines()
                     if l.strip().lower().startswith("write-host") and "$env:GH_TOKEN" in l]
    check("ps1 不打印 GH_TOKEN 值", not ps_token_echo, repr(ps_token_echo[:2]))


def _check_builder(builder):
    for token, label in [
        ("WE_PROD_SMOKE", "构建脚本支持发布期冒烟钩子"),
        (MARK_PROD_SMOKE, "构建脚本写出冒烟退出码标记"),
        ("BUILD_FAILED", "构建脚本把 electron-builder 失败升级为阻断"),
        ("exit /b 1", "构建脚本发布模式失败返回非 0"),
        ("tests\\prod_smoke.mjs", "构建脚本在临时目录就地跑冒烟"),
        ("WE_PROD_WATCHDOG_MS=180000", "构建脚本限制发布门冒烟 watchdog"),
    ]:
        check(label, token in builder)
    # T05688 后续：cmd 按括号配块，块内 echo 文本含裸括号会把下一行 set 挤出块
    # 无条件执行（曾致冒烟通过后仍误判 BUILD_FAILED）。子过程内必须保持无括号。
    sub_start = builder.index(":run_smoke")
    sub = builder[sub_start:builder.index("goto :eof", sub_start)]
    paren_echoes = [l for l in sub.splitlines()
                    if l.strip().lower().startswith("echo") and ("(" in l or ")" in l)]
    check("冒烟子过程 echo 文本无裸括号", not paren_echoes, repr(paren_echoes[:1]))
    check("WARN 文案已改为无括号形式", "prod smoke failed, exit=!SMOKE_RC! - see" in builder)


def static_checks():
    print("== 静态：编码 / 检查项 / 凭据不回显 ==", flush=True)
    b = BAT.read_bytes()
    _check_bat(b.decode("ascii"), b)
    p = PS1.read_bytes()
    _check_ps1(p.decode("utf-8-sig"), p)
    builder = (SCRIPTS / "构建打包.bat").read_bytes().decode("gbk")
    _check_builder(builder)
    try:
        cfg = json.loads(CFG.read_text(encoding="utf-8"))
        ok = all(k in cfg for k in ("runtime", "env", "version", "build", "publish"))
    except Exception:
        ok, cfg = False, {}
    check("publish.config.json 合法且分区齐全", ok)
    check("publish.config.json 声明 Python 构建依赖",
          bool(cfg.get("runtime", {}).get("python_required_modules")))
    return cfg


PUBLISHER_STUB = '''# -*- coding: utf-8 -*-
"""沙箱发布器：只记录被调用事实与环境变量，绝不访问 GitHub。"""
import json, os, sys
from pathlib import Path
tok = os.environ.get("GH_TOKEN", "")
Path(os.environ["WE_STUB_MARKER"]).write_text(json.dumps({
    "argv": sys.argv[1:],
    "token_len": len(tok),
    "token_quoted": tok.startswith(("'", '"')),
    "dry_run": os.environ.get("GH_DRY_RUN", ""),
    "repo": os.environ.get("GH_REPO", ""),
    "tag": os.environ.get("GH_TAG", ""),
}, ensure_ascii=False), encoding="utf-8")
print("[stub] publisher invoked, no network")
'''


def make_sandbox(tmp, cfg_src, *, env_lines=None, helper_config=None, with_config=True):
    s = tmp / "scripts"
    s.mkdir(parents=True, exist_ok=True)
    # 用 ASCII 文件名启动器，避免 cmd 对中文路径的代码页差异；内容即真实 bat 的字节副本
    shutil.copyfile(BAT, s / "publish_launcher.bat")
    shutil.copyfile(PS1, s / "publish.ps1")
    shutil.copyfile(SCRIPTS / "publish-release.py", s / "publish-release.py")
    (s / "publish_stub.py").write_text(PUBLISHER_STUB, encoding="utf-8")
    # 沙箱构建桩：模拟真实构建脚本在临时目录清理前写 prod_smoke.exit（0=通过）。
    # win_unpacked 仍故意不存在：完整链路靠标记放行，-SkipBuild 场景显式跳过。
    build_stub = (
        b"@echo off\r\n"
        b"if \"%WE_PROD_SMOKE%\"==\"1\" (\r\n"
        b"  if not exist \"%~dp0..\\release\\logs\" mkdir \"%~dp0..\\release\\logs\"\r\n"
        b"  (echo 0)> \"%~dp0..\\release\\logs\\prod_smoke.exit\"\r\n"
        b")\r\n"
        b"exit /b 0\r\n"
    )
    (s / "build_stub.bat").write_bytes(build_stub)

    (tmp / "package.json").write_text(
        json.dumps({"name": "we-sandbox", "version": "0.1.20260101-001"}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    (tmp / "tests").mkdir(exist_ok=True)
    (tmp / "tests" / "prod_smoke.mjs").write_text("// stub: 文件存在即可，本用例 -SkipBuild 跳过冒烟\n",
                                                  encoding="utf-8")
    (tmp / "release").mkdir(exist_ok=True)
    (tmp / "release" / "WorkloadEstimate-0.1.20260101-001-setup.exe").write_bytes(b"stub-setup")
    # win_unpacked 故意不存在：完整链路靠构建桩写的 prod_smoke.exit 放行
    cfg = json.loads(json.dumps(cfg_src))
    cfg["build"]["builder_bat"] = "scripts\\build_stub.bat"
    cfg["build"]["win_unpacked"] = "release\\__no_unpacked__"
    cfg["publish"]["py_publisher"] = "scripts\\publish_stub.py"
    # 沙箱里刻意不校验真实 Python 依赖（stub 构建不需要 openpyxl/python-docx）
    cfg["runtime"]["python_required_modules"] = []
    if with_config:
        (s / "publish.config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    if env_lines is not None:
        (tmp / ".env").write_text("\n".join(env_lines) + "\n", encoding="utf-8")
    # 隔离 git 配置：默认空文件（无 credential.helper），可按场景注入 helper
    (tmp / "empty.gitconfig").write_text(helper_config or "", encoding="utf-8")
    return s


def run_bat(sdir, args, *, extra_env=None, timeout=150):
    env = os.environ.copy()
    for k in ("GH_TOKEN", "GITHUB_TOKEN", "GH_DRY_RUN", "GH_REPO", "GH_TAG", "GH_API_BASE"):
        env.pop(k, None)
    env.update({
        "NO_PAUSE": "1",                 # 无人值守：若 pause 未生效，子进程会超时判红
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": str(sdir.parent / "empty.gitconfig"),
        "GIT_TERMINAL_PROMPT": "0",
        "WE_STUB_MARKER": str(sdir.parent / "marker.json"),
    })
    if extra_env:
        env.update(extra_env)
    cmd = 'publish_launcher.bat ' + args
    # stdout 落文件而不是管道：cmd 的孙进程（powershell/git）即使继承句柄也不会让
    # communicate 等 EOF 假死；stdin 关闭，双保险确保任何残留 pause 立即返回。
    log = sdir.parent / "run.log"
    with open(log, "wb") as fh:
        p = subprocess.Popen(["cmd.exe", "/d", "/c", cmd], cwd=str(sdir), env=env,
                             stdin=subprocess.DEVNULL, stdout=fh,
                             stderr=subprocess.STDOUT)
        try:
            code = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait(timeout=10)
            code = -99
    out = _decode(log.read_bytes())
    if code == -99:
        out = "[TIMEOUT] bat 未在 %ss 内返回\n" % timeout + out[-2500:]
    return code, out


def marker(tmp):
    p = tmp / "marker.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def scenario(name, fn):
    # 每个场景独立沙箱 + 独立输出缓冲；并发跑（外部命令启动在本环境有固定开销）
    t0 = time.time()
    tmp = Path(tempfile.mkdtemp(prefix="we_publish_precheck_"))
    buf = []
    _CTX.sink = buf
    try:
        fn(tmp)
    finally:
        del _CTX.sink
        shutil.rmtree(tmp, ignore_errors=True)
    return name, buf, time.time() - t0


# ---------------------------------------------------------------- 动态场景
def _s1(tmp, cfg):
    s = make_sandbox(tmp, cfg)
    code, out = run_bat(s, "-PreflightOnly")
    check("无 token + 无 helper：自检即阻断",
          code != 0 and FAIL_TAG in out and MSG_NO_CREDENTIAL in out,
          LOG_CODE_OUT % (code, out[-500:]))
    check("阻断发生在构建之前", STEP_VERSION_LABEL not in out)
    check("发布器未被调用", marker(tmp) is None)


def _s2(tmp, cfg):
    tok = "fake_token_0123456789abcdef"
    s = make_sandbox(tmp, cfg, env_lines=[ENV_GH_TOKEN_LINE % tok])
    code, out = run_bat(s, ARGS_PREFLIGHT_DRY)
    check(".env GH_TOKEN + 自检通过", code == 0 and "[完成] 前置检查通过" in out,
          LOG_CODE_OUT % (code, out[-600:]))
    check("凭据来源识别为 env/.env", CRED_SOURCE_ENV in out)
    check(MSG_NO_TOKEN_ECHO, tok not in out)
    check("自检未进入构建步骤", STEP_VERSION_LABEL not in out)
    check("bat 识别 -DryRun 参数", TAG_DRY_RUN in out)
    check("ps1 说明 DryRun 仍会构建", "DryRun" in out)


def _s3(tmp, cfg):
    tok = "another_fake_token_0123456789"
    s = make_sandbox(tmp, cfg, env_lines=["GITHUB_TOKEN='%s'" % tok])
    code, out = run_bat(s, ARGS_PREFLIGHT_DRY)
    check("GITHUB_TOKEN 映射为 GH_TOKEN 且自检通过",
          code == 0 and CRED_SOURCE_ENV in out,
          LOG_CODE_OUT % (code, out[-600:]))
    check("未回显 token 明文", tok not in out)


def _s4(tmp, cfg):
    s = make_sandbox(tmp, cfg, helper_config="[credential]\n\thelper = store\n")
    code, out = run_bat(s, "-PreflightOnly")
    check("git credential.helper 兜底不误杀（非演练）",
          code == 0 and "credential.helper 已配置" in out,
          LOG_CODE_OUT % (code, out[-600:]))


def _s5(tmp, cfg):
    tok = "full_chain_token_0123456789"
    s = make_sandbox(tmp, cfg, env_lines=[ENV_GH_TOKEN_LINE % tok])
    args, extra = "-SkipBuild", {"GH_DRY_RUN": "1"}
    code, out = run_bat(s, args, extra_env=extra, timeout=240)
    if code == -99:
        # 本环境新建 .ps1/.bat 偶发被安全软件扫描拖慢；只重试这一次，成功与否照实判
        print("   [RETRY] 首次超时，重跑完整链路场景", flush=True)
        code, out = run_bat(s, args, extra_env=extra, timeout=240)
    m = marker(tmp)
    check("GH_DRY_RUN=1 完整链路通过", code == 0 and m is not None,
          LOG_CODE_OUT % (code, out[-700:]))
    if m:
        check("双引号剥离：发布器收到干净 token",
              m["token_len"] == len(tok) and not m["token_quoted"],
              json.dumps(m, ensure_ascii=False))
        check("发布器收到 GH_DRY_RUN=1", m["dry_run"] == "1")
        check("发布器收到配置仓库坐标与版本 tag",
              m["repo"] == cfg["publish"]["repo"] and m["tag"] == "0.1.20260101-001")
    check(MSG_NO_TOKEN_ECHO, tok not in out)
    check("bat 识别环境变量演练", TAG_DRY_RUN in out)
    check("完整链路确实跑到发布步骤", STEP_VERSION_LABEL in out and "[完成] 一键发布结束" in out)


def _s6(tmp, cfg):
    s = make_sandbox(tmp, cfg, env_lines=["GH_TOKEN=env_token_0123456789abcdef"],
                     with_config=False)
    code, out = run_bat(s, "-PreflightOnly")
    check("缺少 publish.config.json 被 bat 直接挡住",
          code != 0 and MSG_MISSING_FILE in out and FAIL_TAG in out,
          LOG_CODE_OUT % (code, out[-400:]))
    check("未进入 PowerShell 流水线", "Delegating to publish.ps1" not in out)


def _s1(tmp, cfg):
    s = make_sandbox(tmp, cfg)
    code, out = run_bat(s, "-PreflightOnly")
    check("无 token + 无 helper：自检即阻断",
          code != 0 and FAIL_TAG in out and MSG_NO_CREDENTIAL in out,
          LOG_CODE_OUT % (code, out[-500:]))
    check("阻断发生在构建之前", STEP_VERSION_LABEL not in out)
    check("发布器未被调用", marker(tmp) is None)


def _s2(tmp, cfg):
    tok = "fake_token_0123456789abcdef"
    s = make_sandbox(tmp, cfg, env_lines=[ENV_GH_TOKEN_LINE % tok])
    code, out = run_bat(s, ARGS_PREFLIGHT_DRY)
    check(".env GH_TOKEN + 自检通过", code == 0 and "[完成] 前置检查通过" in out,
          LOG_CODE_OUT % (code, out[-600:]))
    check("凭据来源识别为 env/.env", CRED_SOURCE_ENV in out)
    check(MSG_NO_TOKEN_ECHO, tok not in out)
    check("自检未进入构建步骤", STEP_VERSION_LABEL not in out)
    check("bat 识别 -DryRun 参数", TAG_DRY_RUN in out)
    check("ps1 说明 DryRun 仍会构建", "DryRun" in out)


def _s3(tmp, cfg):
    tok = "another_fake_token_0123456789"
    s = make_sandbox(tmp, cfg, env_lines=["GITHUB_TOKEN='%s'" % tok])
    code, out = run_bat(s, ARGS_PREFLIGHT_DRY)
    check("GITHUB_TOKEN 映射为 GH_TOKEN 且自检通过",
          code == 0 and CRED_SOURCE_ENV in out,
          LOG_CODE_OUT % (code, out[-600:]))
    check("未回显 token 明文", tok not in out)


def _s4(tmp, cfg):
    s = make_sandbox(tmp, cfg, helper_config="[credential]\n\thelper = store\n")
    code, out = run_bat(s, "-PreflightOnly")
    check("git credential.helper 兜底不误杀（非演练）",
          code == 0 and "credential.helper 已配置" in out,
          LOG_CODE_OUT % (code, out[-600:]))


def _s5(tmp, cfg):
    tok = "full_chain_token_0123456789"
    s = make_sandbox(tmp, cfg, env_lines=[ENV_GH_TOKEN_LINE % tok])
    args, extra = "-SkipBuild", {"GH_DRY_RUN": "1"}
    code, out = run_bat(s, args, extra_env=extra, timeout=240)
    if code == -99:
        # 本环境新建 .ps1/.bat 偶发被安全软件扫描拖慢；只重试这一次，成功与否照实判
        print("   [RETRY] 首次超时，重跑完整链路场景", flush=True)
        code, out = run_bat(s, args, extra_env=extra, timeout=240)
    m = marker(tmp)
    check("GH_DRY_RUN=1 完整链路通过", code == 0 and m is not None,
          LOG_CODE_OUT % (code, out[-700:]))
    if m:
        check("双引号剥离：发布器收到干净 token",
              m["token_len"] == len(tok) and not m["token_quoted"],
              json.dumps(m, ensure_ascii=False))
        check("发布器收到 GH_DRY_RUN=1", m["dry_run"] == "1")
        check("发布器收到配置仓库坐标与版本 tag",
              m["repo"] == cfg["publish"]["repo"] and m["tag"] == "0.1.20260101-001")
    check(MSG_NO_TOKEN_ECHO, tok not in out)
    check("bat 识别环境变量演练", TAG_DRY_RUN in out)
    check("完整链路确实跑到发布步骤", STEP_VERSION_LABEL in out and "[完成] 一键发布结束" in out)


def _s6(tmp, cfg):
    s = make_sandbox(tmp, cfg, env_lines=["GH_TOKEN=env_token_0123456789abcdef"],
                     with_config=False)
    code, out = run_bat(s, "-PreflightOnly")
    check("缺少 publish.config.json 被 bat 直接挡住",
          code != 0 and MSG_MISSING_FILE in out and FAIL_TAG in out,
          LOG_CODE_OUT % (code, out[-400:]))
    check("未进入 PowerShell 流水线", "Delegating to publish.ps1" not in out)


def dynamic_checks(cfg):
    # 前置检查分支全部用 -PreflightOnly 验证：不构建、不跑 stub，一条 PowerShell 只做体检。
    jobs = [
        ("缺凭据提前阻断（不再等构建跑完才失败）", lambda tmp: _s1(tmp, cfg)),
        (".env 载入 GH_TOKEN（不回显/参数透传/自检）", lambda tmp: _s2(tmp, cfg)),
        ("GITHUB_TOKEN 兼容映射（单引号）", lambda tmp: _s3(tmp, cfg)),
        ("git 凭据库兜底", lambda tmp: _s4(tmp, cfg)),
        ("完整 DryRun 链路（token/演练/发布器调用）", lambda tmp: _s5(tmp, cfg)),
        ("关键文件缺失前置阻断", lambda tmp: _s6(tmp, cfg)),
    ]
    with ThreadPoolExecutor(max_workers=3) as ex:
        results = list(ex.map(lambda pair: scenario(pair[0], pair[1]), jobs))
    for name, buf, elapsed in results:
        print("== 动态：%s == (%.1fs)" % (name, elapsed), flush=True)
        for line in buf:
            print(line, flush=True)


def main():
    if sys.platform != "win32":
        print("SKIP 非 Windows：bat / PowerShell 前置检查链路不适用")
        return 0
    cfg = static_checks()
    dynamic_checks(cfg)
    print("\n==== S20 汇总 ==== 失败 %d 项" % len(fails))
    for f in fails:
        print("  - " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
