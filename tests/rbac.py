# -*- coding: utf-8 -*-
"""T06199 / REQ-021 / AC-25 / AC-28 / AC-29：RBAC 与 SSO 单元验收。"""
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import rbac  # noqa: E402


# 重复字面量统一为模块常量（SonarQube python:S1192）
SSO_USER = 'sso.user'
WORK_TAB_URL = '/work?tab=1'

checks = []


def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def expect_error(name, fn, code, status=400):
    try:
        fn()
    except rbac.RbacError as e:
        check(name, e.code == code and e.status == status, f"{e.code}/{e.status}")
        return e
    except Exception as e:
        check(name, False, f"{type(e).__name__}: {e}")
        return None
    check(name, False, "未抛出异常")
    return None


def _bootstrap_checks(store, tmp):
    check("空库要求初始化管理员", store.bootstrap_required() and store.user_count() == 0)
    expect_error("初始化拒绝弱密码", lambda: store.bootstrap("root", "short"), "WEAK_PASSWORD")
    expect_error("初始化拒绝非法用户名", lambda: store.bootstrap("root space", "LongEnough123"), "INVALID_USERNAME")
    admin = store.bootstrap("root", "AdminPass123", "系统管理员", ip="127.0.0.1")
    check("初始化创建 admin 并返回会话", admin["user"]["role"] == "admin"
          and len(admin["token"]) >= 32 and rbac.P_USER in admin["user"]["permissions"],
          admin["user"]["role"])
    expect_error("重复初始化被关闭", lambda: store.bootstrap("root2", "AdminPass123"), "BOOTSTRAP_CLOSED", 409)
    check("会话令牌可解析", store.session(admin["token"], ip="127.0.0.1")["username"] == "root")
    con = sqlite3.connect(tmp / "rbac.db")
    stored = con.execute("SELECT password_hash FROM users WHERE username='root'").fetchone()[0]
    con.close()
    check("密码不以明文落库", "AdminPass123" not in stored and stored.startswith("pbkdf2_sha256$"), stored[:22])
    expect_error("错误密码统一 401", lambda: store.login("root", "bad", ip="127.0.0.1"),
                 "LOGIN_FAILED", 401)
    check("admin 拥有全部权限", set(admin["user"]["permissions"]) == set(rbac.ALL_PERMISSIONS))
    return admin


def _matrix_checks():
    matrix = rbac.RbacStore.matrix()
    check("矩阵含 5 个角色 / 13 项权限", len(matrix["roles"]) == 5 and len(matrix["permissions"]) == 13,
          f"{len(matrix['roles'])}/{len(matrix['permissions'])}")
    check("风险权限分层：评估师不可签收/管用户，只读成员不可看项目",
          not rbac.has_permission("evaluator", rbac.P_PROJ_SIGN)
          and not rbac.has_permission("evaluator", rbac.P_USER)
          and rbac.has_permission("reviewer", rbac.P_PROJ_SIGN)
          and not rbac.has_permission("viewer", rbac.P_PROJ_READ))


def _user_checks(store, admin):
    evaluator = store.create_user(admin["user"], "eval1", "EvalPass123", "评估师甲", "evaluator", "127.0.0.1")
    viewer = store.create_user(admin["user"], "viewer1", "ViewPass123", "只读乙", "viewer", "127.0.0.1")
    expect_error("用户名重复返回 409",
                 lambda: store.create_user(admin["user"], "eval1", "OtherPass123", "重复", "viewer"),
                 "USERNAME_TAKEN", 409)
    eval_login = store.login("eval1", "EvalPass123", ip="127.0.0.1")
    view_login = store.login("viewer1", "ViewPass123", ip="127.0.0.1")
    check("评估师登录且可查看项目",
          eval_login["user"]["role"] == "evaluator"
          and store.authorize(eval_login["token"], rbac.P_PROJ_READ, ip="127.0.0.1")["username"] == "eval1")
    return evaluator, viewer, eval_login, view_login


def _audit_checks(store, view_login):
    expect_error(
        "只读成员访问项目被 403 拒绝",
        lambda: store.authorize(view_login["token"], rbac.P_PROJ_READ, object_type="project",
                                object_id="p-403", ip="127.0.0.1", method="GET",
                                path="/api/workflow/project?project_id=p-403"),
        "PERMISSION_DENIED", 403)
    audits = store.list_audit(limit=20, result="deny")
    denied_audit = next((a for a in audits if a["object_id"] == "p-403"), None)
    check("拒绝被记录到审计：对象/权限/操作人完整",
          denied_audit and denied_audit["permission"] == rbac.P_PROJ_READ
          and denied_audit["actor_name"] == "只读乙"
          and denied_audit["object_type"] == "project", denied_audit)
    expect_error("无会话访问返回 401",
                          lambda: store.authorize("", rbac.P_PROJ_READ, object_type="project",
                                                  object_id="p-401", ip="127.0.0.1"),
                          "UNAUTHORIZED", 401)
    check("匿名拒绝同样落审计", any(a["actor_name"] == "匿名" and a["object_id"] == "p-401"
                                for a in store.list_audit(limit=50, result="deny")))


def _role_checks(store, admin, evaluator, viewer, view_login, eval_login):
    updated = store.update_user(admin["user"], viewer["id"], role="evaluator", ip="127.0.0.1")
    check("管理员可改角色且立即生效",
          updated["role"] == "evaluator"
          and store.authorize(view_login["token"], rbac.P_PROJ_READ, ip="127.0.0.1")["role"] == "evaluator")
    store.update_user(admin["user"], evaluator["id"], status="disabled", ip="127.0.0.1")
    check("停用用户立即踢出会话并禁止登录",
          store.session(eval_login["token"]) is None
          and expect_error("停用账号登录被 401", lambda: store.login("eval1", "EvalPass123"), "LOGIN_FAILED", 401))
    expect_error("唯一管理员不可停用", lambda: store.update_user(admin["user"], admin["user"]["id"],
                                                                 status="disabled"), "LAST_ADMIN", 409)

    check("登出后会话失效", store.logout(admin["token"], ip="127.0.0.1")
          and store.session(admin["token"]) is None)
    store.login("root", "AdminPass123", ip="127.0.0.1")


def _sso_checks(store):
    sso_state, redirect = store.create_sso_state(WORK_TAB_URL)
    check("SSO state 生成并限制回跳", len(sso_state) >= 32 and redirect == WORK_TAB_URL)
    check("SSO state 一次性消费", store.consume_sso_state(sso_state) == WORK_TAB_URL)
    expect_error("SSO state 重放失败", lambda: store.consume_sso_state(sso_state), "SSO_BAD_STATE")

    sso_user = store.sso_login({"sub": "idp-001", "preferred_username": SSO_USER,
                                "name": "单点用户", "email": "sso@example.com"},
                               "MockIDP", auto_provision=True, default_role="viewer", ip="127.0.0.1")
    check("SSO 自动开通默认只读成员", sso_user["created"] and sso_user["user"]["role"] == "viewer")
    check("SSO 账号无本地密码不可密码登录",
          expect_error("SSO-only 账号密码登录被拒", lambda: store.login(SSO_USER, "anything"), "LOGIN_FAILED", 401))
    again = store.sso_login({"sub": "idp-001", "preferred_username": SSO_USER},
                            "MockIDP", auto_provision=True, default_role="viewer", ip="127.0.0.1")
    check("同一 SSO 主体复用已有账号", not again["created"] and again["user"]["id"] == sso_user["user"]["id"])
    expect_error("SSO 不允许自动开通管理员",
                 lambda: store.sso_login({"sub": "idp-admin"}, "MockIDP", auto_provision=True,
                                         default_role="admin"), "SSO_ROLE_INVALID", 500)
    return sso_state, sso_user


def _final_checks(store, sso_state, sso_user):
    cookies = rbac.cookie_header("tok")
    check("会话 Cookie 含 HttpOnly/SameSite", "HttpOnly" in cookies and "SameSite=Lax" in cookies)
    all_audit = json.dumps(store.list_audit(limit=500), ensure_ascii=False)
    check("审计不含密码或明文令牌",
          "AdminPass123" not in all_audit and "EvalPass123" not in all_audit
          and sso_state not in all_audit and sso_user["token"] not in all_audit)
    check("SSO 登录成功进入审计", any(a["action"] == "sso_login" and a["result"] == "success"
                                 for a in store.list_audit(limit=100)))
    check("角色变更进入审计", any(a["action"] == "user_update" for a in store.list_audit(limit=100)))
    check("审计结果过滤可用", all(a["result"] == "deny" for a in store.list_audit(result="deny")))


def main():
    tmp = Path(tempfile.mkdtemp(prefix="we_rbac_unit_"))
    store = rbac.RbacStore(tmp / "rbac.db")
    admin = _bootstrap_checks(store, tmp)
    _matrix_checks()
    evaluator, viewer, eval_login, view_login = _user_checks(store, admin)
    _audit_checks(store, view_login)
    _role_checks(store, admin, evaluator, viewer, view_login, eval_login)
    sso_state, sso_user = _sso_checks(store)
    _final_checks(store, sso_state, sso_user)

    result = {
        "suite": "rbac",
        "at": rbac._iso(rbac._now()),
        "checks": checks,
        "pass": sum(1 for c in checks if c["ok"]),
        "total": len(checks),
    }
    out = ROOT / "docs" / "test-reports" / "phase3-20261122" / "results" / "rbac.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nrbac: {result['pass']}/{result['total']} checks passed")
    return 0 if result["pass"] == result["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
