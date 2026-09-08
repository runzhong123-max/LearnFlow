"""Authored, deterministic work-task design compiler.

Recipes are bounded teaching analogues, not automatic expertise for every job.
Full compiled designs and assessments are server-only. Always project public_design
before transport. Content acceptance never creates a mastery assertion.
"""
from __future__ import annotations

from copy import deepcopy
import csv
import io
import hashlib
import json
import re
from pathlib import PurePosixPath
from fastapi import HTTPException

SCHEMA_VERSION = "learnflow.work-task-design.v1"
COMPILER_VERSION = "1.0.0"


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


_RECIPES = {
    "data-import-quality": {
        "title": "数据导入质量与可重放交付", "activity": "数据处理与导入",
        "description": "围绕规范化、拒绝项与重复输入，比较逐行导入和按业务键合并。",
        "cues": ["数据", "导入", "csv", "etl", "清洗", "去重", "data", "import"],
        "boundary": "适用于表格记录的确定性转换教学；不覆盖真实数据库迁移、复杂 CSV 语法或生产数据合规验收。",
        "question": "重复输入会怎样影响有效记录数？先验证字段，再按业务键保留最后一个有效版本，能否使重放结果稳定？",
        "variable": "duplicate_policy", "baseline": "append_valid_rows", "contrast": "last_valid_row_wins",
        "observables": ["accepted_count", "rejected_ids", "final_records"],
        "contract": {"duplicate_policy": "last_valid_row_wins", "invalid_quantity": "reject", "sku_normalization": "trim_uppercase"},
        "rules": "每行包含 id、sku、quantity。id 是整数业务键；sku 去首尾空格并转大写；quantity 必须是非负整数。先拒绝不合法 quantity，再对有效行按 id 保留最后一行，按 id 升序输出 records；rejected 记录拒绝行的 id，按输入顺序。重放同一批数据时，合并状态不增加记录。教学输入不含引号或逗号转义。",
        "filename": "inventory.csv", "format": "csv",
        "fixtures": [
            "id,sku,quantity\n11, bolt-a ,2\n12,NUT-B,3\n11,BOLT-A,5\n13,washer,-1\n",
            "id,sku,quantity\n21, cable-x ,1\n21,CABLE-X,4\n22,plug,0\n23,fuse,broken\n",
            "id,sku,quantity\n31, bracket ,2\n32,plate,7\n31,BRACKET,-4\n33,pin,0\n",
        ],
        "expected": [
            {"records": [{"id": 11, "sku": "BOLT-A", "quantity": 5}, {"id": 12, "sku": "NUT-B", "quantity": 3}], "rejected": [13]},
            {"records": [{"id": 21, "sku": "CABLE-X", "quantity": 4}, {"id": 22, "sku": "PLUG", "quantity": 0}], "rejected": [23]},
            {"records": [{"id": 31, "sku": "BRACKET", "quantity": 2}, {"id": 32, "sku": "PLATE", "quantity": 7}, {"id": 33, "sku": "PIN", "quantity": 0}], "rejected": [31]},
        ],
        "baseline_expected": {"accepted_count": 3, "rejected_ids": [13]},
        "contrast_expected": {"accepted_count": 2, "rejected_ids": [13]},
        "change": "仓库同事追加零库存、无法解析的数量和重复记录。保持原契约，说明如何证明重放不制造新记录。",
        "hints": ["把校验、字段规范化、业务键合并分成独立步骤，先手算两行。", "只将有效行放入按 id 索引的容器，最后再排序；记录拒绝项。"],
        "deliverable": "转换结果、拒绝清单、重放对照表和数据交接说明",
    },
    "service-integration-delivery": {
        "title": "服务接入与幂等交付演练", "activity": "服务实施与系统集成",
        "description": "从依赖与权限契约出发，对照首次接入、重复请求和失败补偿。",
        "cues": ["接口", "软件实施", "系统集成", "部署", "api", "integration", "service integration"],
        "boundary": "适用于服务接入流程与交付检查教学；使用离线状态表，不连接真实租户、不执行部署、不证明生产可用性。",
        "question": "接入请求被重复提交时，按操作编号复用结果是否能避免重复授权？失败发生在授权前后时，应如何保留可恢复状态？",
        "variable": "replay_policy", "baseline": "repeat_every_operation", "contrast": "reuse_operation_id",
        "observables": ["grant_count", "final_state", "failed_operation_ids"],
        "contract": {"dependency_order": ["validate", "configure", "grant", "verify"], "replay_policy": "reuse_operation_id", "failed_grant": "keep_configured"},
        "rules": "离线模拟接入流程。validate 成功后才能 configure，随后 grant，最后 verify。每条请求携带 operation_id；已成功的 operation_id 重放直接复用结果，不再执行。grant 失败保留 configured 状态，不能宣布 ready；授权成功且 verify 成功才 ready。按给定日志统计实际成功 grant 次数、最后状态及失败操作编号。这里只模拟明确列出的请求，不自行补充未出现的重试。",
        "filename": "onboarding.json", "format": "json",
        "fixtures": [
            '{"tenant":"training-a","requests":[["v1","validate","ok"],["c1","configure","ok"],["g1","grant","ok"],["g1","grant","ok"],["t1","verify","ok"]]}',
            '{"tenant":"training-b","requests":[["v2","validate","ok"],["c2","configure","ok"],["g2","grant","failed"]]}',
            '{"tenant":"training-c","requests":[["v3","validate","ok"],["c3","configure","ok"],["g3","grant","failed"],["g4","grant","ok"],["g4","grant","ok"],["t3","verify","ok"]]}',
        ],
        "expected": [
            {"grant_count": 1, "final_state": "ready", "failed_operation_ids": []},
            {"grant_count": 0, "final_state": "configured", "failed_operation_ids": ["g2"]},
            {"grant_count": 1, "final_state": "ready", "failed_operation_ids": ["g3"]},
        ],
        "baseline_expected": {"grant_count": 2, "final_state": "ready"},
        "contrast_expected": {"grant_count": 1, "final_state": "ready"},
        "change": "实施同事反馈授权步骤失败，但配置已经落地。客户要求尽快恢复；请说明当前状态、可以重试的步骤与不应重复的副作用。",
        "hints": ["画出每一步前后的状态，把操作编号与租户编号分开。", "成功操作建立记录；同编号重复请求只读记录。授权失败保留配置并记录失败，不跳到 ready。"],
        "deliverable": "接入状态表、重复请求对照、失败恢复方案和客户交接清单",
    },
    "incident-investigation": {
        "title": "故障调查与可逆恢复演练", "activity": "故障排查与服务运营",
        "description": "以时间线、对照组和变更记录提出有依据的假设，设计可逆处置与复核。",
        "cues": ["故障", "排查", "告警", "日志", "事故", "运维", "incident", "debug", "诊断"],
        "boundary": "适用于日志与变更线索的离线故障调查；答案只针对维护的合成场景，相关性不等于真实事故因果证明，不执行生产操作。",
        "question": "错误率上升是否只集中在变更组？比较同窗口未变更组后，哪些证据支持优先排查变更，哪些结论仍不能成立？",
        "variable": "rollout_group", "baseline": "unchanged_control", "contrast": "changed_cohort",
        "observables": ["control_error_rate", "changed_error_rate", "suspected_change", "next_check"],
        "contract": {"comparison": "same_window_control", "claim_level": "hypothesis", "mitigation": "reversible"},
        "rules": "教学值班规则：先算同时间窗中 error/requests，再比较未变更对照组和变更组。若只变更组显著上升且与单个变更同窗，则将该 change_id 列为 suspected_change，next_check 用 rollback_canary；若两组同时上升则 suspected_change=null，next_check 用 shared_dependency。所有判断仅是假设。记录窗口与数据出处；恢复建议必须可逆，生产操作另需批准。",
        "filename": "incident-window.json", "format": "json",
        "fixtures": [
            '{"window":"09:00-09:10","change_id":"cache-policy-17","control":{"requests":100,"errors":1},"changed":{"requests":100,"errors":25}}',
            '{"window":"10:00-10:10","change_id":"timeout-18","control":{"requests":200,"errors":40},"changed":{"requests":200,"errors":42}}',
            '{"window":"11:00-11:10","change_id":"pool-19","control":{"requests":50,"errors":0},"changed":{"requests":50,"errors":10}}',
        ],
        "expected": [
            {"control_error_rate": 0.01, "changed_error_rate": 0.25, "suspected_change": "cache-policy-17", "next_check": "rollback_canary", "claim_level": "hypothesis"},
            {"control_error_rate": 0.2, "changed_error_rate": 0.21, "suspected_change": None, "next_check": "shared_dependency", "claim_level": "hypothesis"},
            {"control_error_rate": 0.0, "changed_error_rate": 0.2, "suspected_change": "pool-19", "next_check": "rollback_canary", "claim_level": "hypothesis"},
        ],
        "baseline_expected": {"error_rate": 0.01}, "contrast_expected": {"error_rate": 0.25},
        "change": "接班同事补充了第二个时间窗，对照组也出现错误。请修订原假设，避免把所有错误都归咎于最近变更。",
        "hints": ["先固定分母与时间窗，再分别计算两组错误率；不要只看错误数量。", "对照组也恶化时，优先检查共享依赖；单组恶化时只形成待验证的变更假设。"],
        "deliverable": "时间线、对照计算、证据与假设清单、可逆处置及接班记录",
    },
}


def _normal_brief(brief: dict) -> dict:
    if not isinstance(brief, dict):
        raise HTTPException(422, "工作任务必须是结构化对象")
    result = {}
    for key in ("task_title", "task_description", "work_context", "deliverable", "learner_level"):
        value = brief.get(key, "")
        if not isinstance(value, str) or len(value) > 12000:
            raise HTTPException(422, f"{key} 必须是有界文本")
        result[key] = value.strip()
    for key in ("acceptance_criteria", "constraints", "source_refs"):
        values = brief.get(key, [])
        if not isinstance(values, list) or len(values) > 32:
            raise HTTPException(422, f"{key} 必须是最多 32 项的列表")
        if key != "source_refs" and any(not isinstance(v, str) or len(v) > 4000 for v in values):
            raise HTTPException(422, f"{key} 包含无效文本")
        # Sources stay opaque provenance, never get interpreted as instructions or copied into fixtures.
        if len(json.dumps(values, ensure_ascii=False)) > 24000:
            raise HTTPException(422, "来源引用超过设计预算")
        result[key] = deepcopy(values)
    return result


def _parameters(brief: dict, recipe_id: str) -> tuple[dict, list[dict], list[str]]:
    parameters = {"duplicate_policy": "last_valid_row_wins", "sku_normalization": "trim_uppercase"} if recipe_id == "data-import-quality" else {}
    reviews, errors = [], []
    seen = {}
    rules = (
        ("duplicate_policy", "first_valid_row_wins", ("保留首条", "保留第一条", "保留第一行", "first_valid_row_wins")),
        ("duplicate_policy", "last_valid_row_wins", ("保留最后", "保留末条", "last_valid_row_wins")),
        ("sku_normalization", "trim_lowercase", ("sku小写", "sku转小写", "trim_lowercase")),
        ("sku_normalization", "trim_uppercase", ("sku大写", "sku转大写", "trim_uppercase")),
        ("invalid_quantity", "reject", ("拒绝负数", "数量非负", "quantity>=0")),
    )
    # Both user-authored requirement fields constrain the same recipe. The source
    # location survives into review so conflicts cannot be silently prioritized.
    for input_field in ("acceptance_criteria", "constraints"):
        for input_index, text in enumerate(brief[input_field]):
            patch, clauses = {}, []
            for clause in (part.strip() for part in re.split(r"[;；\n]+", text) if part.strip()):
                compact = re.sub(r"\s+", "", clause.lower())
                matches = []
                if recipe_id == "data-import-quality":
                    for key, value, terms in rules:
                        matched = next((term for term in terms if term in compact), None)
                        if matched:
                            prefix = compact[:compact.index(matched)]
                            if re.search(r"(?:不要|不能|不得|禁止|不应|不)(?:采用)?$", prefix):
                                errors.append("尚不能解释否定要求：" + clause)
                                continue
                            matches.append((key, value))
                    if any(term in compact for term in ("允许负数", "负数有效", "保留所有重复", "带引号的逗号", "全量csv语法")):
                        errors.append("该数据规则尚无维护的验收器：" + clause)
                clause_patch = {}
                for key, value in matches:
                    if key in seen and seen[key][0] != value:
                        errors.append(f"要求冲突：{key}（{seen[key][1]} 与 {input_field}[{input_index}]）")
                    seen.setdefault(key, (value, f"{input_field}[{input_index}]"))
                    if key in clause_patch and clause_patch[key] != value:
                        errors.append("同一要求包含冲突参数：" + key)
                    clause_patch[key] = value
                patch.update(clause_patch)
                # Recognizing a supported parameter does not establish coverage
                # of other requirements in a compound sentence.
                fully_recognized = bool(matches) and bool(re.fullmatch(
                    r"(?:(?:重复(?:数据|记录)?(?:时)?(?:的)?(?:处理)?(?:策略)?[：:=]?)?"
                    r"(?:保留首条|保留第一条|保留第一行|保留最后(?:一条|一行)?|保留末条)|"
                    r"sku(?:转)?[大小]写|拒绝负数(?:数量)?|数量非负|quantity>=0|"
                    r"first_valid_row_wins|last_valid_row_wins|trim_lowercase|trim_uppercase)", compact))
                clauses.append({"text": clause, "status": "applied" if fully_recognized else "requires_domain_review", "parameters": clause_patch})
            parameters.update(patch)
            reviews.append({"input_field": input_field, "input_index": input_index, "input_text": text,
                            "status": "applied" if clauses and all(item["status"] == "applied" for item in clauses) else "requires_domain_review",
                            "parameters": patch, "clauses": clauses})
    return parameters, reviews, list(dict.fromkeys(errors))


def _parameterized_recipe(recipe_id: str, parameters: dict) -> dict:
    recipe = deepcopy(_RECIPES[recipe_id])
    if recipe_id != "data-import-quality":
        return recipe
    recipe["contract"].update(parameters)
    first = parameters["duplicate_policy"] == "first_valid_row_wins"
    lower = parameters["sku_normalization"] == "trim_lowercase"
    if first:
        recipe["rules"] = recipe["rules"].replace("保留最后一行", "保留第一行")
        recipe["question"] = recipe["question"].replace("最后一个", "第一个")
        recipe["contrast"] = "first_valid_row_wins"
    if lower:
        recipe["rules"] = recipe["rules"].replace("转大写", "转小写")
    recipe["expected"] = []
    for fixture in recipe["fixtures"]:
        records, rejected = {}, []
        for row in csv.DictReader(io.StringIO(fixture)):
            identifier = int(row["id"])
            try:
                quantity = int(row["quantity"])
                if quantity < 0:
                    raise ValueError()
            except ValueError:
                rejected.append(identifier)
                continue
            sku = row["sku"].strip().lower() if lower else row["sku"].strip().upper()
            if not first or identifier not in records:
                records[identifier] = {"id": identifier, "sku": sku, "quantity": quantity}
        recipe["expected"].append({"records": [records[k] for k in sorted(records)], "rejected": rejected})
    return recipe


def long_tail_draft(brief: dict, project_mode: str) -> dict:
    """A useful bounded authoring proposal, explicitly not a runnable/graded design."""
    brief = _normal_brief(brief)
    if project_mode not in {"experiment", "practice"}:
        raise HTTPException(422, "请选择实验型或实践型")
    acceptance = [{"requirement": text, "status": "needs_authored_validator", "evidence_to_define": "样例输入、观察量、正确边界及反例"} for text in brief["acceptance_criteria"]]
    is_experiment = project_mode == "experiment"
    phases = (["固定工作问题与可测量假设", "准备基线、对照与同一材料", "执行并记录观察", "限定结论并提出变式"] if is_experiment
              else ["接到工作：补齐角色与验收约定", "导师示范周边步骤、学生完成核心产物", "追加条件并修订交付", "隐藏变式的独立验收与工作交接"])
    proposal = {"schema_version": "learnflow.work-task-design-draft.v1", "project_mode": project_mode,
                "readiness": "needs_domain_authoring", "title": brief["task_title"], "input_brief": brief,
                "objective": brief["deliverable"], "proposed_phases": [{"order": i + 1, "title": title,
                    "work_context": brief["work_context"], "target_deliverable": brief["deliverable"],
                    "acceptance_requirements": brief["acceptance_criteria"]} for i, title in enumerate(phases)],
                "acceptance_map": acceptance, "constraint_review": [{"requirement": text, "status": "needs_domain_review"} for text in brief["constraints"]],
                "authoring_questions": ["请提供可脱敏的代表性输入与合格产物样例。", "哪些核心动作必须由学习者完成，哪些周边工作可由导师示范？", "哪些验收项可确定性计算，哪些必须由领域专家评审？", "用于最后独立验收的新材料由谁维护？"],
                "missing_validation": ["维护的领域素材", "基线与对照或阶段变化", "有反例测试的确定性验收器", "答案隔离的独立验收", "环境与适用边界审核"],
                "can_materialize": False, "auto_execute": False, "mastery_inference": False,
                "provenance": {"kind": "bounded_authoring_proposal", "compiler_version": COMPILER_VERSION, "input_hash": digest(brief)},
                "next_action": "在 Tutor 中继续补充并评审专业方案；发布领域材料和验收器后才允许正式导入。"}
    proposal["root_hash"] = digest(proposal)
    return proposal


def design_catalog(brief: dict) -> list[dict]:
    brief = _normal_brief(brief)
    missing = [key for key in ("task_title", "task_description", "work_context", "deliverable", "acceptance_criteria") if not brief[key]]
    out = []
    for recipe_id, recipe in _RECIPES.items():
        relation = []
        for field in ("task_title", "task_description", "work_context", "deliverable"):
            matched = [cue for cue in recipe["cues"] if cue in brief[field].lower()]
            if matched:
                relation.append({"input_field": field, "input_text": brief[field], "matched_terms": matched,
                                 "activity": recipe["activity"], "design_element": recipe["deliverable"]})
        parameters, requirement_review, conflicts = _parameters(brief, recipe_id)
        constraint_review = [item for item in requirement_review if item["input_field"] == "constraints"]
        acceptance_review = [item for item in requirement_review if item["input_field"] == "acceptance_criteria"]
        readiness = "missing_input" if missing else "ready" if relation and not conflicts else "unsupported"
        out.append({"recipe_id": recipe_id, "version": COMPILER_VERSION, "title": recipe["title"],
                    "description": recipe["description"], "activity": recipe["activity"],
                    "project_modes": ["experiment", "practice"], "readiness": readiness,
                    "missing_fields": missing, "parameters": parameters, "constraint_review": constraint_review, "acceptance_review": acceptance_review, "incompatible_constraints": conflicts, "applicability": {"kind": "authored_analogue", "boundary": recipe["boundary"],
                    "matching_method": "transparent_keyword_overlap_requires_user_selection", "requires_user_confirmation": True,
                    "business_acceptance_covered": False}, "relation_map": relation,
                    "drafting_brief": None if readiness == "ready" else {
                        "status": "needs_domain_authoring", "task": brief["task_title"],
                        "required_authoring": ["真实或合成材料", "基线与变式", "维护者审核的验收器", "来源与适用边界"],
                        "message": "可继续补充任务或交给 Tutor 起草专业方案；未经领域材料与验收器维护，不开放自动创建。"}})
    return out


def _field(key: str, label: str) -> dict:
    return {"key": key, "label": label, "kind": "textarea", "placeholder": ""}


def _stage(key, title, objective, body, expected, extra_fields, recipe, *, independent=False):
    return {"key": key, "title": title, "objective": objective,
            "materials": [{"id": key, "title": title, "body": body}],
            "fields": [_field("result", "结构化结果（JSON，按任务契约字段）"), *[_field(k, label) for k, label in extra_fields]],
            "hints": [] if independent else recipe["hints"], "validator": "authored_design_exact_json_v1",
            "assessment": {"expected": expected}, "required_artifacts": False, "independent_validation": independent,
            "student_tasks": [objective, "亲自完成表格或程序计算，保留推导与真实运行依据。"],
            "mentor_support": ["只说明提交方式，不提供解题线索。"] if independent else ["根据选择的帮助档位解释边界，检查学生的推导。"],
            "shared_tasks": ["核对当前材料、提交版本与帮助记录；操作检查不表示掌握。"],
            "related_files": [{"path": recipe["filename"], "role": "input", "reason": "初始教学材料；后续变式只在当前阶段开放。"}]}


def compile_design(brief: dict, project_mode: str, recipe_id: str) -> dict:
    brief = _normal_brief(brief)
    if project_mode not in {"experiment", "practice"}:
        raise HTTPException(422, "专业设计仅接受实验型或实践型")
    if recipe_id not in _RECIPES:
        raise HTTPException(422, "请选择目录中明确维护的专业设计")
    catalog = next(item for item in design_catalog(brief) if item["recipe_id"] == recipe_id)
    if catalog["readiness"] != "ready":
        raise HTTPException(422, {"code": catalog["readiness"], "message": "任务信息不足或超出该设计适用范围", "catalog_entry": catalog})
    recipe = _parameterized_recipe(recipe_id, catalog["parameters"])
    context = (f"工作任务：{brief['task_title']}\n工作场景：{brief['work_context']}\n目标交付：{brief['deliverable']}\n"
               f"用户验收要求：{'；'.join(brief['acceptance_criteria'])}\n限制：{'；'.join(brief['constraints']) or '未补充'}\n"
               "以下为与此活动相关的独立教学材料，业务验收要求仍需另行核对，不代表已自动实现全部真实业务。\n")
    fixture = lambda n: f"\n当前材料（{recipe['format']}）：\n{recipe['fixtures'][n]}\n输出字段以当前任务契约为准。"
    result_contract = "\n结果 JSON 字段：" + ", ".join(recipe["expected"][0]) + "。"
    if project_mode == "practice":
        stages = [
            _stage("clarify", "接到任务：澄清工作契约", "固定业务边界并提出风险预测。", context + recipe["rules"] + "\n请将约定写成 JSON：" + json.dumps(recipe["contract"], ensure_ascii=False), recipe["contract"], [("prediction", "边界预测与需要向同事确认的问题")], recipe),
            _stage("implement", "带教实施：完成第一份交付", "对初始材料完成最小交付，解释观察和修正。", recipe["rules"] + fixture(0) + result_contract, recipe["expected"][0], [("observation", "实际观察与依据"), ("explanation", "为何这样处理，哪些部分获得帮助")], recipe),
            _stage("change", "同事追加：处理变化并交接", "按新材料复核边界，修订风险与交接。", recipe["change"] + recipe["rules"] + fixture(1) + result_contract, recipe["expected"][1], [("handoff", "复现方式、变化影响、剩余风险和交接事项")], recipe),
            _stage("independent", "独立复核：新的工作材料", "独立处理未提前开放的材料，说明证据与下一步。", "本阶段不提供解题提示。请独立推导；提交受助结果仍会如实记录，不能作为独立验证。\n" + recipe["rules"] + fixture(2) + result_contract, recipe["expected"][2], [("reasoning", "独立推导与依据"), ("next_check", "剩余风险与下一项验证")], recipe, independent=True),
        ]
    else:
        plan = {"variable": recipe["variable"], "baseline": recipe["baseline"], "contrast": recipe["contrast"]}
        observations = {"baseline": recipe["baseline_expected"], "contrast": recipe["contrast_expected"]}
        stages = [
            _stage("define", "实验设计：固定问题与预测", "明确变量、同一输入、基线与对照，并在观察前记录预测。", context + recipe["question"] + "\n实验计划字段：" + json.dumps(plan, ensure_ascii=False) + "\n保持同一输入，先按 baseline 策略计算，再按 contrast 策略计算。", plan, [("prediction", "预测差异与理由"), ("controls", "保持不变的条件与测量方式")], recipe),
            _stage("implement", "执行对照：观察而非猜测", "用同一输入完成两组计算，记录输出与不一致。", recipe["rules"] + fixture(0) + "\n基线策略：" + recipe["baseline"] + "；对照策略：" + recipe["contrast"] + "。\n提交 {baseline:{...},contrast:{...}}，两组分别报告字段：" + json.dumps({k: list(v) for k, v in observations.items()}, ensure_ascii=False) + "。可使用本地脚本或手工逐行计算，必须记录执行方式。", observations, [("observation", "实际观察、执行方式与可复核的过程"), ("explanation", "比较预测与结果，解释失败或差异")], recipe),
            _stage("reflect", "变式复核：结论与边界", "独立复核新材料，限定结论并提出下一个控制变量实验。", "本阶段独立复核，不提供解题提示。\n" + recipe["rules"] + fixture(2) + result_contract, recipe["expected"][2], [("conclusion", "结论、复现步骤与适用边界"), ("next_experiment", "下一实验的变量、预测和测量方法")], recipe, independent=True),
        ]
    files = [{"path": "README.md", "content": "# " + brief["task_title"] + "\n\n" + context + recipe["boundary"] + "\n\n" + recipe["rules"] + "\n\n执行：使用文本编辑器与表格手工推导，或自行实现本地脚本。系统不自动执行命令。仅第一批材料在此，后续变式从工作台当前阶段读取。\n"},
             {"path": recipe["filename"], "content": recipe["fixtures"][0] + "\n"},
             {"path": "observations.md", "content": "# 我的实验与交付记录\n\n## 预测\n\n## 执行环境与步骤\n\n## 基线与对照\n\n## 观察与解释\n\n## 帮助记录\n\n## 结论、风险与下一步\n"}]
    for item in files:
        item["sha256"] = hashlib.sha256(item["content"].encode()).hexdigest()
    result = {"schema_version": SCHEMA_VERSION, "id": "work-design:" + recipe_id, "version": COMPILER_VERSION,
              "recipe_id": recipe_id, "project_mode": project_mode, "title": brief["task_title"] + " · " + recipe["title"],
              "objective": brief["deliverable"], "summary": recipe["description"], "estimated_minutes": 90 if project_mode == "experiment" else 150,
              "readiness": "ready", "applicability": catalog["applicability"], "relation_map": catalog["relation_map"],
              "parameters": catalog["parameters"], "constraint_review": catalog["constraint_review"], "acceptance_review": catalog["acceptance_review"],
              "input_brief": brief, "question": recipe["question"], "expected_observables": recipe["observables"],
              "deliverables": [recipe["deliverable"], "与原工作任务的关系、未覆盖要求与后续验证"],
              "acceptance": {"method": "maintained_exact_json_plus_human_review", "scope": "authored_fixture_only", "mastery_inference": False,
                             "checks": ["当前材料的 JSON 输出符合维护契约", "预测、过程与解释字段完整", "末阶段无本阶段提示或协作记录"],
                             "human_review": ["推导与产物是否真实一致", "真实业务约束覆盖", "解释质量与迁移能力"]},
              "environment": {"kind": "offline_manual_or_user_script", "requirements": ["文本编辑器", "可选表格或本地编程运行时"], "network_required": False, "auto_execute": False},
              "provenance": {"kind": "authored_teaching_design", "author": "LearnFlow", "compiler_version": COMPILER_VERSION,
                             "recipe_id": recipe_id, "source_locator": f"bundled://work-task-design/{recipe_id}/{COMPILER_VERSION}",
                             "input_hash": digest(brief), "authenticity": "独立维护的合成教学材料，与用户任务关联；不声称来自企业内部。"},
              "starter_files": files, "stages": stages}
    result["root_hash"] = digest(result)
    return result


def validate_design(design: dict) -> dict:
    """Reject forged/rehashed assessment and executable/path additions, not only bad hashes."""
    errors = []
    if not isinstance(design, dict) or design.get("schema_version") != SCHEMA_VERSION:
        return {"valid": False, "errors": ["unsupported_schema"]}
    if design.get("version") != COMPILER_VERSION:
        errors.append("unsupported_version")
    if digest({k: v for k, v in design.items() if k != "root_hash"}) != design.get("root_hash"):
        errors.append("hash_mismatch")
    try:
        canonical = compile_design(design.get("input_brief", {}), design.get("project_mode"), design.get("recipe_id"))
        if canonical != design:
            errors.append("not_authored_compiler_output")
    except (HTTPException, TypeError, ValueError):
        errors.append("invalid_compiler_inputs")
    files = design.get("starter_files")
    if not isinstance(files, list):
        errors.append("invalid_starter_files")
        files = []
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("content"), str):
            errors.append("invalid_starter_file")
            continue
        path = PurePosixPath(item.get("path", ""))
        if path.is_absolute() or ".." in path.parts or "\\" in str(path) or str(path).startswith("."):
            errors.append("unsafe_starter_path")
        if hashlib.sha256(item.get("content", "").encode()).hexdigest() != item.get("sha256"):
            errors.append("starter_hash_mismatch")
    return {"valid": not errors, "errors": errors, "schema_version": SCHEMA_VERSION, "root_hash": design.get("root_hash"), "mastery_inference": False}


def public_design(design: dict) -> dict:
    """Explicit allowlist: never expose assessment, hints or future fixture bodies."""
    keys = ("schema_version", "id", "version", "root_hash", "recipe_id", "project_mode", "title", "objective", "summary",
            "estimated_minutes", "readiness", "applicability", "relation_map", "question", "expected_observables",
            "deliverables", "acceptance", "environment", "provenance", "starter_files", "parameters", "constraint_review", "acceptance_review")
    public = {key: deepcopy(design[key]) for key in keys}
    public["stages"] = [{key: deepcopy(stage[key]) for key in ("key", "title", "objective", "independent_validation")} for stage in design["stages"]]
    return public


def _same_json_result(actual: object, expected: object) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(expected, (int, float)):
        return isinstance(actual, (int, float)) and actual == expected
    if isinstance(expected, dict):
        return isinstance(actual, dict) and set(actual) == set(expected) and all(
            _same_json_result(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            _same_json_result(a, e) for a, e in zip(actual, expected))
    return type(actual) is type(expected) and actual == expected


def evaluate_design_stage(stage: dict, answers: dict) -> list[dict]:
    try:
        result = json.loads(answers.get("result", ""))
        # JSON booleans are not numbers; numerically equal 0 and 0.0 are valid.
        passed = _same_json_result(result, stage["assessment"]["expected"])
    except (ValueError, TypeError):
        passed = False
    return [{"key": "authored_contract", "label": "当前教学材料的结构化输出", "passed": passed,
             "detail": "与维护契约一致；解释仍需人工评审。" if passed else "输出与当前材料的契约不一致；请检查字段、类型、顺序和处理边界。"}]
