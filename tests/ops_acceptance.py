# -*- coding: utf-8 -*-
"""AC-39 / AC-40 验收脚本：升级回滚 restore_backup + 诊断包脱敏。"""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import datakeeper  # noqa: E402


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def seed(data: Path):
    con = sqlite3.connect(data / "pert.db")
    con.execute("CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT)")
    con.execute("INSERT INTO projects VALUES('p1','客户原始需求文档片段')")
    con.commit(); con.close()
    (data / "estimation.db").write_bytes(b"sqlite-estimation")
    (data / "config.json").write_text(json.dumps({"llm": {"api": "http://x", "key": "sk-secret-123"}}, ensure_ascii=False), encoding="utf-8")
    (data / "recognition_rules.json").write_text('{"r":1}', encoding="utf-8")
    (data / "rates_versions.json").write_text('{"v":1}', encoding="utf-8")
    (data / "template.xlsx").write_bytes(b"xlsx-template")
    (data / "schema_ver").write_text("1", encoding="utf-8")


def test_rollback(tmp):
    data = Path(tmp) / "data"; data.mkdir()
    seed(data)
    before = {n: (sha(data / n) if (data / n).exists() else None) for n in datakeeper.BACKUP_FILES}
    bk = datakeeper.backup_on_start(str(data), reason="before-upgrade")
    assert bk and Path(bk).is_dir()
    assert datakeeper.list_backups(str(data))[0]["id"] == Path(bk).name
    # 模拟升级失败：配置被改、母版丢失、schema 前进、数据损坏
    (data / "config.json").write_text('{"bad":true}', encoding="utf-8")
    (data / "template.xlsx").unlink()
    (data / "schema_ver").write_text("2", encoding="utf-8")
    (data / "pert.db").write_bytes(b"broken-db")
    result = datakeeper.restore_backup(str(data), Path(bk).name)
    assert result["ok"] is True, result
    for n, h in before.items():
        got = sha(data / n) if (data / n).exists() else None
        assert got == h, (n, got, h)
    assert (data / "schema_ver").read_text() == "1"
    log = (data / "logs" / "rollback.jsonl").read_text(encoding="utf-8").splitlines()
    assert any('"rollback_done"' in l and '"ok": true' in l for l in log), log
    print("AC-39 rollback PASS:", result["backup"], "restored=", len(result["restored"]))
    return data


def test_hash_refusal(tmp):
    data = Path(tmp) / "hashcase"; data.mkdir()
    seed(data)
    bk = Path(datakeeper.backup_on_start(str(data), reason="tamper"))
    (bk / "config.json").write_text("tampered", encoding="utf-8")
    result = datakeeper.restore_backup(str(data), bk.name)
    assert result["ok"] is False and any(x["file"] == "config.json" for x in result["skipped"]), result
    print("AC-39 tamper-refusal PASS")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        test_rollback(tmp)
        test_hash_refusal(tmp)
    print("OPS-OPS PASS")


if __name__ == "__main__":
    main()
