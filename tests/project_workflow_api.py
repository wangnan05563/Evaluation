# -*- coding: utf-8 -*-
"""T06198 / REQ-020 / AC-23 / AC-24：状态机、签收页与审计包真实 HTTP 验收。"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8033").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
fails = []
total = 0


def call(path, payload=None, method=None, timeout=180, raw=False):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(API + path, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, (body if raw else (json.loads(body.decode("utf-8")) if body else {}))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"msg": body}


def check(name, ok, detail=""):
    global total
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def main():
    print(f"API={API}")
    st, cfg = call("/api/config")
    check("GET /api/config 返回部署模式", st == 200 and cfg.get("config", {}).get("deployment", {}).get("mode") in ("standalone", "workgroup"),
          json.dumps(cfg.get("config", {}).get("deployment"), ensure_ascii=False))

    # 单机版默认隐藏 / 工作组版启用；切换只改入口
    st, off = call("/api/config", {"deployment": {"mode": "standalone"}})
    check("切到单机版成功", st == 200 and off["config"]["deployment"]["mode"] == "standalone",
          off.get("config", {}).get("deployment", {}).get("mode"))
    st, on = call("/api/config", {"deployment": {"mode": "workgroup"}})
    check("切到工作组版成功", st == 200 and on["config"]["deployment"]["mode"] == "workgroup",
          on.get("config", {}).get("deployment", {}).get("mode"))

    # 生成一条真实估算历史，自动创建草稿项目
    st, sample = call("/api/onboarding/sample")
    check("样例数据可用", st == 200 and sample.get("name") and sample.get("b64"), sample.get("name"))
    st, rec = call("/api/recognize", {"name": sample["name"], "b64": sample["b64"], "params": {}})
    check("样例识别 6 项", st == 200 and len(rec.get("items", [])) == 6, str(len(rec.get("items", []))))
    its = rec["items"]
    title = f"T06198 API 签收流转 {time.strftime('%H%M%S')}"
    st, gen = call("/api/generate", {"items": its, "method": "估算功能点", "title": title,
                                     "job": "t06198_api", "hist_items": [{**x, "cx": "中", "ok": True} for x in its],
                                     "source_name": sample["name"]})
    pid = gen.get("version_group")
    check("生成成功并返回 version_group", st == 200 and gen.get("ok") and pid, str(pid))

    st, lst = call("/api/workflow/projects")
    row = next((p for p in lst.get("projects", []) if p.get("project_id") == pid), None)
    check("新版本自动登记为 draft 项目", st == 200 and row and row.get("status") == "draft",
          json.dumps(row, ensure_ascii=False) if row else "missing")
    check("草稿项目含 64 位版本哈希", row and len(row.get("version_hash") or "") == 64,
          (row or {}).get("version_hash", "")[:16])

    st, detail = call("/api/workflow/project?project_id=" + pid)
    ev0 = detail.get("project", {}).get("events", [])
    check("项目详情含创建审计事件（人/时间/对象/意见）",
          st == 200 and len(ev0) == 1 and all(ev0[0].get(k) for k in ("actor", "at", "object_ref", "opinion")),
          json.dumps(ev0[:1], ensure_ascii=False))
    check("创建事件版本哈希与项目冻结哈希一致",
          bool(row) and ev0 and ev0[0].get("version_hash") == row.get("version_hash"),
          f"{(ev0[0].get('version_hash') or '')[:16]} / {(row or {}).get('version_hash', '')[:16]}")

    def transition(action, actor, role, opinion=""):
        return call("/api/workflow/transition",
                    {"project_id": pid, "action": action, "actor": actor, "role": role, "opinion": opinion})

    st, sub = transition("submit_review", "张评估", "评估师", "提交项目经理评审")
    check("draft → review（提交评审）", st == 200 and sub["project"]["status"] == "review"
          and sub["project"]["submitted_by"] == "张评估", sub.get("project", {}).get("status"))
    st, dup = transition("submit_review", "张评估", "评估师")
    check("重复提交返回 409 且状态不变", st == 409 and dup.get("code") == "invalid_transition",
          f"{st} / {dup.get('code')}")
    st, noop = transition("reject", "李经理", "项目经理")
    check("无意见驳回返回 400 opinion_required", st == 400 and noop.get("code") == "opinion_required",
          f"{st} / {noop.get('code')}")
    st, rej = transition("reject", "李经理", "项目经理", "范围说明需补充")
    check("review → rejected（驳回）", st == 200 and rej["project"]["status"] == "rejected"
          and rej["project"]["reviewer"] == "李经理", rej.get("project", {}).get("status"))
    st, rev = transition("revise", "张评估", "评估师", "")
    check("rejected → draft（修订）", st == 200 and rev["project"]["status"] == "draft",
          rev.get("project", {}).get("status"))
    st, sub2 = transition("submit_review", "张评估", "评估师", "已补充范围说明")
    check("draft → review（再次提交）", st == 200 and sub2["project"]["status"] == "review",
          sub2.get("project", {}).get("status"))
    st, noop2 = transition("sign", "王签收", "项目经理")
    check("无意见签收返回 400 opinion_required", st == 400 and noop2.get("code") == "opinion_required",
          f"{st} / {noop2.get('code')}")
    st, signed = transition("sign", "王签收", "项目经理", "同意签收")
    signed_p = signed.get("project", {})
    check("review → signed（签收）", st == 200 and signed_p.get("status") == "signed"
          and signed_p.get("signer") == "王签收" and signed_p.get("signed_at"),
          json.dumps({k: signed_p.get(k) for k in ("status", "signer", "signed_at")}, ensure_ascii=False))
    st, after = transition("revise", "张评估", "评估师")
    check("已签收后再次流转返回 409", st == 409 and after.get("code") == "invalid_transition",
          f"{st} / {after.get('code')}")

    st, detail2 = call("/api/workflow/project?project_id=" + pid)
    p = detail2.get("project", {})
    events = p.get("events", [])
    check("审计轨迹 6 条且每条四要素完整",
          len(events) == 6 and all(e.get("actor") and e.get("at") and e.get("object_ref")
                                   and (e.get("opinion") if e.get("action") in ("reject", "sign") else True)
                                   for e in events),
          str(len(events)))
    check("详情返回签收人/时间/意见/哈希",
          p.get("signer") == "王签收" and p.get("signed_at") and p.get("sign_opinion") == "同意签收"
          and p.get("version_hash") == signed_p.get("version_hash"), p.get("short_hash"))
    check("签收后项目计数包含 signed",
          (call("/api/workflow/projects")[1].get("counts") or {}).get("signed", 0) >= 1,
          json.dumps(call("/api/workflow/projects")[1].get("counts"), ensure_ascii=False))

    st, rep = call("/api/workflow/signoff-package", {"project_id": pid}, timeout=180)
    check("签收报告生成成功", st == 200 and rep.get("ok") and rep.get("pages", 0) >= 8,
          f"{st} pages={rep.get('pages')} {rep.get('version_hash')}")
    check("报告版本哈希与签收冻结哈希一致", rep.get("version_hash") == p.get("short_hash"),
          f"{rep.get('version_hash')} / {p.get('short_hash')}")

    # 下载 PDF 并逐字确认签收页四要素（人/时间/意见/哈希）
    st, pdf_bytes = call(rep.get("download", ""), None, raw=True, timeout=120)
    pdf_path = Path(ROOT / "docs" / "test-reports" / "phase3-20261122" / "results" / "project-workflow-signoff.pdf")
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    pdf_path.write_bytes(pdf_bytes)
    text = ""
    try:
        import fitz
        with fitz.open(str(pdf_path)) as doc:
            text = "\n".join(page.get_text() for page in doc)
    except Exception as e:
        print("  PDF 文本抽取失败:", e)
    check("签名/时间/意见/版本哈希进入签收页",
          "王签收" in text and "同意签收" in text and p.get("signed_at", "").replace("T", " ")[:16] in text.replace("T", " ")
          and p.get("short_hash", "") in text,
          f"bytes={len(pdf_bytes)} text={len(text)}")

    results = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results"
    out = {"suite": "project-workflow-api", "api": API, "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "ok": not fails, "checks": total, "fails": fails, "project_id": pid,
           "title": title, "version_hash": p.get("version_hash"), "short_hash": p.get("short_hash"),
           "signoff_pages": rep.get("pages"), "pdf": str(pdf_path), "events": len(events)}
    (results / "project-workflow-api.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n==== 项目签收 HTTP：{len(fails)} 失败 / {total} 项 ====")
    for f in fails:
        print("  FAIL:", f)
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
