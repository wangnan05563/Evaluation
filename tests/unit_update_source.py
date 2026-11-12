# -*- coding: utf-8 -*-
"""S19 · 内置更新源单测（T05688）：默认 GitHub Releases + 覆盖/停用 + Release 响应归一化。

离线验证思路：本地 mock HTTP 服务充当更新源，后端子进程用 WE_UPDATE_API_BASE 把
「内置默认地址」改指到 mock，因此不访问外网就能验证默认源真的会发请求并解析
GitHub Release 格式；WE_UPDATE_URL / 配置中心的覆盖与 off 停用也一并覆盖。

用法：python tests/unit_update_source.py（编排器作为 py 套件调用）。退出码 0=全过。
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
REPO_PATH = '/repos/wangnan05563/Evaluation/releases/latest'
fails = []
BASE = ''
PKG_URL = ''


def check(name, ok, detail=''):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ''))
    if not ok:
        fails.append(name)


class MockHandler(BaseHTTPRequestHandler):
    """按路径返回 GitHub Release / 自定义 JSON / 坏数据；记录默认路径是否被请求。"""
    release = {}
    hits = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split('?')[0]
        MockHandler.hits.append(path)
        routes = {
            REPO_PATH: MockHandler.release,
            '/gh/latest': MockHandler.release,
            '/gh/no-exe': {'tag_name': '0.1.20990101-999',
                           'assets': [{'name': 'release-notes.md',
                                       'browser_download_url': BASE + '/notes.md'}]},
            '/custom/latest.json': {'version': '0.1.20990101-999',
                                    'url': PKG_URL, 'notes': '自定义源'},
            '/custom/bad.json': {'version': '0.1.20990101-999'},
        }
        if path not in routes:
            self.send_error(404)
            return
        body = json.dumps(routes[path], ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def call(port, path, payload=None, timeout=20):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=data,
                                 method='POST' if data is not None else 'GET',
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8-sig'))


def start_backend(tmp, port, extra_env):
    """起隔离后端：独立 WE_DATA、独立端口，清掉外部可能带入的更新源环境变量。"""
    env = {**os.environ, 'WE_DATA': str(Path(tmp) / f'data{port}')}
    env.pop('WE_UPDATE_URL', None)
    env.pop('WE_UPDATE_API_BASE', None)
    env.update(extra_env)
    proc = subprocess.Popen([PY, '-u', 'scripts/server.py', str(port)], cwd=str(ROOT), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(150):
        if proc.poll() is not None:
            raise RuntimeError(f'后端提前退出 code={proc.returncode}')
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1) as r:
                if json.load(r).get('ok'):
                    return proc
        except Exception:
            time.sleep(0.1)
    proc.terminate()
    raise RuntimeError('隔离后端 15s 内未就绪')


def stop(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


mock = ThreadingHTTPServer(('127.0.0.1', 0), MockHandler)
BASE = f'http://127.0.0.1:{mock.server_address[1]}'
PKG_URL = f'{BASE}/pkg/WorkloadEstimate-0.1.20990101-999-setup.exe'
MockHandler.release = {
    'tag_name': 'v0.1.20990101-999',
    'name': 'WorkloadEval 0.1.20990101-999',
    'body': '# 更新日志\n新增内置更新源',
    'assets': [
        {'name': 'release-notes.md', 'browser_download_url': BASE + '/notes.md'},
        {'name': 'WorkloadEstimate-0.1.20990101-999-setup.exe',
         'browser_download_url': PKG_URL},
    ],
}
threading.Thread(target=mock.serve_forever, daemon=True).start()

p1 = p2 = None
try:
    # 1) 常量守卫：真实运行时的内置地址必须是官方仓库的 Release API
    src = (ROOT / 'scripts' / 'server.py').read_text(encoding='utf-8')
    check('内置仓库坐标与官方 API 域名（未引入临时测试 URL）',
          'GH_REPO = "wangnan05563/Evaluation"' in src
          and 'GH_API_BASE_DEFAULT = "https://api.github.com"' in src
          and 'f"{base}/repos/{GH_REPO}/releases/latest"' in src)

    with tempfile.TemporaryDirectory(prefix='we_upd_', ignore_cleanup_errors=True) as tmp:
        port1, port2 = free_port(), free_port()
        # 2) 主实例：内置默认地址改指本地 mock，验证「留空即可用」全链路
        p1 = start_backend(tmp, port1, {'WE_UPDATE_API_BASE': BASE})
        cfg = call(port1, '/api/config')
        info = cfg.get('update_source') or {}
        check('默认地址格式为 <API 域名>/repos/<owner>/<repo>/releases/latest',
              info.get('default_url') == BASE + REPO_PATH, str(info.get('default_url')))
        check('旧配置空值无需迁移：留空即走内置源',
              (cfg.get('config') or {}).get('update_url') == ''
              and info.get('source') == 'builtin'
              and info.get('url') == info.get('default_url'), str(info))

        r = call(port1, '/api/update/check')
        check('默认源真实发起请求：不再报「未配置更新源」',
              r.get('ok') is True and r.get('source') == 'builtin'
              and REPO_PATH in MockHandler.hits, str(r)[:160])
        check('GitHub Release 归一化：v 前缀/版本号/安装包/更新日志',
              r.get('latest') == '0.1.20990101-999' and r.get('hasUpdate') is True
              and r.get('url') == PKG_URL and '更新日志' in (r.get('notes') or ''), str(r)[:200])

        # 3) 配置中心覆盖：自定义 JSON 源仍兼容，保存接口回传内置/生效地址
        saved = call(port1, '/api/update/config',
                     {'update_url': BASE + '/custom/latest.json'})
        check('保存接口回传 default_url 与 effective_url',
              saved.get('ok') is True and saved.get('default_url') == BASE + REPO_PATH
              and saved.get('effective_url') == BASE + '/custom/latest.json', str(saved)[:160])
        r = call(port1, '/api/update/check')
        check('自定义 {version,url,notes} 源行为不变',
              r.get('ok') is True and r.get('latest') == '0.1.20990101-999'
              and r.get('url') == PKG_URL and r.get('notes') == '自定义源'
              and r.get('source') == 'config', str(r)[:160])

        # 4) 坏数据与无安装包资产：明确报错而非静默误判
        call(port1, '/api/update/config', {'update_url': BASE + '/custom/bad.json'})
        r = call(port1, '/api/update/check')
        check('自定义源缺 url 时报「数据不完整」',
              r.get('ok') is False and r.get('msgKey') == 'help.upd.msg_src_incomplete', str(r)[:160])
        call(port1, '/api/update/config', {'update_url': BASE + '/gh/no-exe'})
        r = call(port1, '/api/update/check')
        check('GitHub Release 无 exe 资产时报「数据不完整」',
              r.get('ok') is False and r.get('msgKey') == 'help.upd.msg_src_incomplete', str(r)[:160])

        # 5) 显式停用与恢复内置：off 是哨兵值，空值回到内置源
        call(port1, '/api/update/config', {'update_url': 'off'})
        r = call(port1, '/api/update/check')
        check('显式 off 仍可停用版本检测',
              r.get('ok') is False and r.get('msgKey') == 'help.upd.msg_unconfigured', str(r)[:160])
        call(port1, '/api/update/config', {'update_url': ''})
        info = (call(port1, '/api/config').get('update_source') or {})
        check('清空输入框恢复内置源（不再等同于停用）',
              info.get('source') == 'builtin' and info.get('url') == info.get('default_url'), str(info))

        # 6) 环境变量通道：编排器用 WE_UPDATE_URL=off 隔离外网，须确实生效
        p2 = start_backend(tmp, port2, {'WE_UPDATE_URL': 'off'})
        info = (call(port2, '/api/config').get('update_source') or {})
        check('WE_UPDATE_URL=off 隔离外网自动检测',
              info.get('source') == 'off' and info.get('url') == '', str(info))
        r = call(port2, '/api/update/check')
        check('隔离实例检测更新走守卫分支（供 i18n 套件稳定断言）',
              r.get('ok') is False and r.get('msgKey') == 'help.upd.msg_unconfigured', str(r)[:160])
finally:
    stop(p1)
    stop(p2)
    mock.shutdown()
    mock.server_close()

print(f"==== 内置更新源单测汇总 ==== 失败 {len(fails)}")
sys.exit(1 if fails else 0)
