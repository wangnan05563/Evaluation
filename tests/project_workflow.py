# -*- coding: utf-8 -*-
"""T06198 / REQ-020 / AC-23 / AC-24：项目状态机、审计轨迹与签收冻结的最小单测。"""
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import history
import project_workflow


# 重复字面量统一为模块常量（SonarQube python:S1192）
METHOD_NAME = '估算功能点'
SAMPLE_PROJECT = 'T06198 状态机样例'

fails = []
checks = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    checks.append({"title": name, "ok": bool(ok), "detail": str(detail)})
    if not ok:
        fails.append(name)


def expect_error(fn, code):
    try:
        fn()
    except project_workflow.WorkflowError as e:
        return e.code == code, f"{e.code}: {e.message}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
    return False, "未抛出预期错误"


def main():
    tmp = tempfile.TemporaryDirectory()
    hist = history.HistStore(Path(tmp.name) / "estimation.db")
    store = project_workflow.WorkflowStore(Path(tmp.name) / "workflow.db")
    item = {"desc": "客户信息维护表", "type": "ILF", "reuse": "中", "modify": "新增"}
    rec = hist.insert(title=SAMPLE_PROJECT, method=METHOD_NAME,
                      params={"cx_mode": "企业母版"}, items=[item],
                      summary={"count": 1, "us_total": 6.67}, sid="wf-unit")
    h = store.hash_snapshot(title=SAMPLE_PROJECT, version_no=1, method=METHOD_NAME,
                            params={"cx_mode": "企业母版"}, items=rec["items"],
                            summary={"count": 1, "us_total": 6.67})
    check("版本哈希为 SHA-256 64 位", len(h) == 64 and all(c in "0123456789abcdef" for c in h), h)

    detail = store.ensure(project_id=rec["version_group"], title=SAMPLE_PROJECT, version_no=1,
                          history_id=rec["id"], version_hash=h)
    check("首版自动登记为 draft", detail["status"] == "draft" and detail["version_no"] == 1,
          detail["status"])
    check("创建事件含人/时间/对象/意见",
          len(detail["events"]) == 1 and detail["events"][0]["actor"] == "系统"
          and detail["events"][0]["at"] and detail["events"][0]["object_ref"],
          json.dumps(detail["events"][0], ensure_ascii=False))

    submitted = store.transition(rec["version_group"], "submit_review", actor="张评估", role="评估师",
                                 opinion="提交项目经理评审")
    check("draft → review 并记录提交人", submitted["status"] == "review"
          and submitted["submitted_by"] == "张评估" and submitted["submitted_at"], submitted["status"])
    check("重复提交被状态机拒绝", *expect_error(
        lambda: store.transition(rec["version_group"], "submit_review", actor="张评估"), "invalid_transition"))

    check("驳回必须填写意见", *expect_error(
        lambda: store.transition(rec["version_group"], "reject", actor="李经理", role="项目经理"), "opinion_required"))
    rejected = store.transition(rec["version_group"], "reject", actor="李经理", role="项目经理",
                                opinion="范围说明需补充")
    check("review → rejected 并记录审核人", rejected["status"] == "rejected"
          and rejected["reviewer"] == "李经理", rejected["status"])
    revised = store.transition(rec["version_group"], "revise", actor="张评估", role="评估师")
    check("rejected → draft 修订", revised["status"] == "draft", revised["status"])
    store.transition(rec["version_group"], "submit_review", actor="张评估", role="评估师", opinion="已补充")
    check("签收必须填写意见", *expect_error(
        lambda: store.transition(rec["version_group"], "sign", actor="王签收", role="项目经理"), "opinion_required"))
    signed = store.transition(rec["version_group"], "sign", actor="王签收", role="项目经理",
                              opinion="同意签收")
    check("review → signed 并冻结签收人/时间/意见",
          signed["status"] == "signed" and signed["signer"] == "王签收"
          and signed["signed_at"] and signed["sign_opinion"] == "同意签收",
          json.dumps({k: signed[k] for k in ("status", "signer", "signed_at", "sign_opinion")}, ensure_ascii=False))
    check("签收事件保留完整四要素",
          signed["events"][-1]["action"] == "sign" and signed["events"][-1]["actor"] == "王签收"
          and signed["events"][-1]["at"] and signed["events"][-1]["object_ref"]
          and signed["events"][-1]["opinion"] == "同意签收",
          json.dumps(signed["events"][-1], ensure_ascii=False))
    check("已签收后禁止再次流转", *expect_error(
        lambda: store.transition(rec["version_group"], "revise", actor="张评估"), "invalid_transition"))

    signoff = store.signoff(rec["version_group"])
    check("签收段含签收人/时间/意见/完整哈希",
          signoff["signer"] == "王签收" and signoff["signed_at"]
          and signoff["opinion"] == "同意签收" and signoff["version_hash"] == h
          and signoff["short_hash"] == h[:16], json.dumps(signoff, ensure_ascii=False))
    check("审计轨迹累计 6 个事件（创建/提交/驳回/修订/再提交/签收）",
          len(signed["events"]) == 6, str(len(signed["events"])))
    check("每个事件均有 actor/at/object_ref",
          all(e.get("actor") and e.get("at") and e.get("object_ref") for e in signed["events"]))
    check("驳回与签收意见进入评审意见",
          any("范围说明需补充" == x for x in signoff["opinions"])
          and any("同意签收" == x for x in signoff["opinions"]),
          json.dumps(signoff["opinions"], ensure_ascii=False))

    rec2 = hist.insert(title=SAMPLE_PROJECT, method=METHOD_NAME,
                       params={"cx_mode": "企业母版"}, items=[item],
                       summary={"count": 1, "us_total": 6.67}, sid="wf-unit",
                       reopen_group=rec["version_group"])
    h2 = store.hash_snapshot(title=SAMPLE_PROJECT, version_no=rec2["version_no"],
                             method=METHOD_NAME, params={"cx_mode": "企业母版"},
                             items=rec2["items"], summary={"count": 1, "us_total": 6.67})
    nextv = store.ensure(project_id=rec["version_group"], title=SAMPLE_PROJECT,
                         version_no=rec2["version_no"], history_id=rec2["id"], version_hash=h2)
    check("新版本自动回 draft 并清除当前签收字段",
          nextv["status"] == "draft" and nextv["signer"] is None and nextv["signed_at"] is None,
          json.dumps({k: nextv[k] for k in ("status", "signer", "signed_at")}))
    check("新版本仍保留旧签收事件链", any(e["action"] == "sign" for e in nextv["events"]), str(len(nextv["events"])))
    check("新版本哈希与旧版不同", nextv["version_hash"] != h, nextv["version_hash"][:16] + " / " + h[:16])

    store2 = project_workflow.WorkflowStore(Path(tmp.name) / "workflow2.db")
    synced = store2.sync_from_history(hist)
    projects = store2.list_projects()
    check("已有估算历史可补登记为草稿项目", synced >= 1 and len(projects) >= 1,
          f"synced={synced} projects={len(projects)}")
    check("补登记项目带哈希与历史版本组", projects[0]["version_hash"] and projects[0]["project_id"],
          projects[0]["project_id"])

    # 只读校验：非法 action 与缺少项目
    check("未知 action 被拒绝", *expect_error(
        lambda: store.transition(rec["version_group"], "unknown", actor="张评估"), "invalid_transition"))
    check("不存在的项目返回 not_found", *expect_error(
        lambda: store.transition("missing", "submit_review", actor="张评估"), "not_found"))
    check("空操作人被拒绝", *expect_error(
        lambda: store.transition(rec["version_group"], "submit_review", actor=""), "actor_required"))

    print(f"\n==== 项目状态机：{len(fails)} 失败 / {total} 项 ====")
    for f in fails:
        print("  FAIL:", f)
    out_dir = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "project-workflow.json").write_text(json.dumps({
        "suite": "project-workflow",
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "checks": checks, "pass": total - len(fails), "total": total, "fails": fails,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.cleanup()
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
