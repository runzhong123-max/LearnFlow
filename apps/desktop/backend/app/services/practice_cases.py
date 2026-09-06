"""Bundled, version-pinned teaching cases. No producer credentials or hidden answers in public views."""
from __future__ import annotations
import hashlib
import json
from copy import deepcopy
from fastapi import HTTPException

CASE_ID = "support-ticket-import"


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _field(key: str, label: str, placeholder: str = "") -> dict:
    return {"key": key, "label": label, "kind": "textarea", "placeholder": placeholder}


_CASE = {
    "schema_version": "learnflow.practice-case.v1",
    "id": CASE_ID, "version": "1.0.0", "title": "接手客服工单导入工具",
    "summary": "扮演新入职开发者，澄清导入约定、修复数据转换、接受新批次复测并交接。",
    "estimated_minutes": 90,
    "provenance": {
        "kind": "authored_teaching_case", "author": "LearnFlow",
        "license": "project_repository_license", "authenticity": "教学案例，独立编写；不声称来自企业内部工作区",
        "source_locator": "bundled://support-ticket-import/1.0.0",
        "case_as_of": "2026-09-05",
    },
    "starter_files": [
        {"path": "README.md", "content": "# 客服工单导入\n\n这是独立编写的教学工单。先阅读工作台中的任务契约，再实现 importer.c。\n在桌面选择 importer.c 并运行；将 input.csv 正文粘贴到标准输入，再将 JSON 输出提交到工作台。下一阶段会收到新批次复测。\n"},
        {"path": "input.csv", "content": "id,email,status\n101, ALICE@Example.com ,new\n102,bob@example.com,done\n101, alice+work@example.com ,open\n103,cara@example.com,closed\n104,dan@example.com,waiting\n"},
        {"path": "importer.c", "content": "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <ctype.h>\n\n/* Teaching fixture: simple comma-separated rows, no quoted commas.\n * Input arrives on stdin; emit the accepted JSON contract on stdout. */\nint transform(FILE *input, FILE *output) {\n    char line[512];\n    if (fgets(line, sizeof line, input) == NULL) return 1; /* header */\n    while (fgets(line, sizeof line, input) != NULL) {\n        /* TODO: parse id/email/status, normalize, reject, and keep last row. */\n    }\n    /* TODO: sort accepted ids and serialize tickets/rejected. */\n    fputs(\"{\\\"tickets\\\":[],\\\"rejected\\\":[]}\\n\", output);\n    return 0;\n}\n\nint main(void) { return transform(stdin, stdout); }\n"},
    ],
    "stages": [
        {
            "key": "clarify", "title": "读懂工单与澄清边界", "objective": "确认重复记录、状态映射和邮箱规范化的契约。",
            "materials": [{"id": "ticket", "title": "工单 #184 · 导入数据重复与状态不一致", "body": "客服需要导入历史工单。开发约定：同 id 保留输入中的最后一行；邮箱去除首尾空白并转小写；new/open 映射为 open，done/closed 映射为 closed；未知状态不导入，将整数 id 放入 rejected。返回对象包含 tickets 和 rejected，tickets 每项只有整数 id、email、status，并按 id 升序。先预测原程序可能在哪些边界失败，再确认契约。"}],
            "fields": [_field("rules", "确认接口契约（JSON）", '{"duplicate_policy":"...","unknown_status":"...","email_normalization":"..."}'), _field("prediction", "预测：哪类输入最容易造成错误，为什么？")],
            "hints": ["把重复记录策略、未知状态策略、邮箱规范化分别写清楚。", "规则值分别使用 last_row_wins、reject、trim_lowercase。"],
            "validator": "contract", "required_artifacts": False,
        },
        {
            "key": "implement", "title": "最小实现与分组件检查", "objective": "实现并检查初始批次转换，记录观察与失败解释。",
            "materials": [{"id": "batch-a", "title": "第一批数据与验收接口", "body": "选择 importer.c 并把 starter_files 中 input.csv 的正文粘贴到标准输入（教学输入不含带引号的逗号字段）。交付 JSON 结构为 {tickets:[{id,email,status}],rejected:[id]}。重复、状态、邮箱分别检查，再检查组合输入。请提交程序实际输出，先用最小变更解释失败。"}],
            "fields": [_field("result", "程序输出（JSON）"), _field("observation", "观察：运行结果与预测有什么差别？"), _field("explanation", "解释：修改了什么，为什么能解决问题？")],
            "hints": ["先逐行规范化并决定拒绝项，再按 id 去重。", "请特别检查 id=101 的最后一行，以及 waiting 状态。"],
            "validator": "batch_a", "required_artifacts": False,
        },
        {
            "key": "handoff", "title": "新批次复测与工作交接", "objective": "用新输入验证迁移，记录风险与下一步实验。",
            "materials": [{"id": "batch-b", "title": "同事追加的复测批次", "body": "请用这批新输入复测，不修改原契约：\nid,email,status\n201, FIRST@EXAMPLE.COM ,new\n202, second@example.com ,closed\n201, FINAL@EXAMPLE.COM ,done\n203,other@example.com,pending\n\n交接需要包含：运行方式、仍有的边界风险、下一步实验。核心完成后，可选比较大数据量下的实现复杂度。"}],
            "fields": [_field("result", "新批次程序输出（JSON）"), _field("handoff", "交接：运行方式、风险和下一步实验")],
            "hints": ["保持契约不变，只替换输入文件。", "把输出正确性与交接文档质量分开检查。"],
            "validator": "batch_b", "required_artifacts": False,
        },
    ],
}
_CASE["root_hash"] = digest(_CASE)


def get_case(case_id: str, version: str | None = None, root_hash: str | None = None) -> dict:
    if case_id != CASE_ID:
        raise HTTPException(404, "案例不存在")
    if version is not None and version != _CASE["version"]:
        raise HTTPException(409, "案例版本不可用，请重新选择固定版本")
    if root_hash is not None and root_hash != _CASE["root_hash"]:
        raise HTTPException(409, "案例内容摘要不匹配，请重新核验候选")
    return deepcopy(_CASE)


def case_summary(case: dict) -> dict:
    return {key: deepcopy(case[key]) for key in (
        "schema_version", "id", "version", "root_hash", "title", "summary", "provenance", "estimated_minutes",
    )}


def case_catalog() -> list[dict]:
    return [case_summary(_CASE)]


def evaluate_case(stage: dict, answers: dict[str, str]) -> list[dict]:
    def check(key: str, label: str, passed: bool, detail: str) -> dict:
        return {"key": key, "label": label, "passed": passed, "detail": detail}
    validator = stage["validator"]
    field = "rules" if validator == "contract" else "result"
    try:
        result = json.loads(answers.get(field, ""))
    except (ValueError, TypeError):
        return [check("json", "有效 JSON", False, "请提交一个有效 JSON 对象；当前输入未被解析。")]
    if validator == "contract":
        expected = {"duplicate_policy": "last_row_wins", "unknown_status": "reject", "email_normalization": "trim_lowercase"}
        return [check(key, key, isinstance(result, dict) and result.get(key) == value,
                      "契约一致。" if isinstance(result, dict) and result.get(key) == value else "与当前工单契约不一致，请重新核对边界。") for key, value in expected.items()]
    # Evaluator remains server-only. Future fixtures and expected outputs are never projected.
    expected = ({"tickets": [
        {"id": 101, "email": "alice+work@example.com", "status": "open"},
        {"id": 102, "email": "bob@example.com", "status": "closed"},
        {"id": 103, "email": "cara@example.com", "status": "closed"}], "rejected": [104]}
        if validator == "batch_a" else {"tickets": [
        {"id": 201, "email": "final@example.com", "status": "closed"},
        {"id": 202, "email": "second@example.com", "status": "closed"}], "rejected": [203]})
    valid = isinstance(result, dict) and set(result) == {"tickets", "rejected"}
    checks = [check("shape", "输出字段", valid, "只接收 tickets 和 rejected 两个字段。")]
    for key, label in (("tickets", "保留记录、顺序与字段规范化"), ("rejected", "未知状态拒绝记录")):
        passed = valid and result.get(key) == expected[key]
        checks.append(check(key, label, passed, "符合当前批次契约。" if passed else "与当前批次的输入契约不一致；检查去重、顺序和状态边界。"))
    return checks
