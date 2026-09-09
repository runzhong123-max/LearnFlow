#!/usr/bin/env python3
"""Build and inspect synthetic education data. Never imports the product or scores it."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import random
import statistics

ROOT = Path(__file__).resolve().parent
VERSION = "computing-learner-profile-dataset.v1"
SEED = 20260908
DOMAINS = {
    "programming": "程序设计", "algorithms": "数据结构与算法", "databases": "数据库",
    "web_backend": "Web 后端", "frontend": "Web 前端", "testing": "软件测试",
    "networks": "计算机网络", "systems": "Linux 与系统运维", "data_ai": "数据分析与人工智能基础",
}
PATTERNS = (
    "assisted_success", "independent_once", "repeated_original", "novel_transfer_once",
    "gap_unresolved", "gap_followup_success", "temporary_constraint_active", "temporary_constraint_expired",
    "goal_current", "goal_superseded", "insufficient_evidence", "long_history_return",
    "irrelevant_invariance", "scope_invariance", "future_invariance", "source_retraction",
    "unknown_assistance_success", "explanation_ineffective", "environment_failure",
    "team_artifact", "current_input_override", "unjustified_correct_result",
)
ANCHOR = datetime(2026, 3, 2, 9, tzinfo=timezone.utc)
CURRENT = ANCHOR + timedelta(days=21)
GLOBAL_FORBIDDEN = [
    "将生成、浏览、自述、草稿或任务完成直接视为独立能力证据",
    "将一次正确或一次变式通过描述为长期稳定掌握",
    "根据普通错误推断人格、医学状态或固定学习风格",
    "用其他学习者、其他未授权项目、尚未发生或尚未记录的信息解释当前决策",
]


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def stamp(day=0, minute=0):
    return (ANCHOR + timedelta(days=day, minutes=minute)).isoformat()


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_jsonl(path, rows):
    path.write_text("".join(encoded(row) + "\n" for row in rows))


def load_families(root=ROOT):
    families = []
    for path in sorted((root / "catalog").glob("*.json")):
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            data = data["families"]
        families.extend(data)
    return sorted(families, key=lambda f: f["family_id"])


def assign_splits(families):
    """Keep every history, probe and perturbation of a task family together."""
    groups = defaultdict(list)
    for f in families:
        groups[f["domain"]].append(f["family_id"])
    result = {}
    for domain, ids in sorted(groups.items()):
        ids.sort(key=lambda key: digest([SEED, domain, key]))
        for i, key in enumerate(ids):
            result[key] = "development" if i < 5 else "validation" if i < 6 else "holdout"
    return result


def public_probe(probe, family_id):
    return {"id": "question-" + digest([family_id, probe["id"]])[:20],
            "prompt": probe["prompt"], "artifact": probe["artifact"]}


def eligible(event, case):
    c = case["current"]
    return (event["scope"]["learner_id"] == c["learner_id"]
            and event["scope"]["project_id"] == c["project_id"]
            and event["occurred_at"] <= c["at"] and event["recorded_at"] <= c["at"])


def build_case(f, pattern, all_families):
    # Shared identity and event IDs allow literal pair comparison. Reset per case;
    # these alternatives must NEVER be ingested into one persistent learner.
    fid = f["family_id"]
    code = digest(fid)[:12]
    scope = {"learner_id": f"synthetic-{code}", "project_id": f"project-{code}",
             "checkpoint_id": f"checkpoint-{code}"}
    request_forms = [
        f"我准备继续完成这个任务：{f['task_prompt']} 请结合我已有的学习经历，安排下一步学习与验证；依据不够时可以先诊断。",
        f"这是接下来要做的练习：{f['task_prompt']} 根据之前的尝试，帮我选下一步，不确定的地方先问我。",
        f"我回来了，准备接着做：{f['task_prompt']} 先练哪个部分，用什么方式检查能否独立完成？",
        f"围绕这个项目要求：{f['task_prompt']} 给我一个当前适合的学习步骤和检查方法。",
    ]
    current = {**scope, "session_id": f"session-{code}-current", "at": CURRENT.isoformat(),
               "request": request_forms[int(code[:2], 16) % len(request_forms)]}
    case = {"schema_version": VERSION, "case_id": "clp-" + digest([fid, pattern])[:20],
            "family_id": fid, "current": current, "observations": []}
    probes = {p["id"]: p for p in f["probes"]}
    refs = []

    def event(kind, day, payload, *, minute=0, foreign=None, recorded_day=None):
        n = len(case["observations"]) + 1
        event_scope = {**scope, "session_id": f"session-{code}-{day}"}
        if foreign == "learner":
            event_scope["learner_id"] = "synthetic-donor-" + code
        if foreign == "project":
            event_scope["project_id"] = "other-project-" + code
        item = {"id": f"obs-{code}-{n:03d}", "kind": kind, "scope": event_scope,
                "occurred_at": stamp(day, minute),
                "recorded_at": stamp(day if recorded_day is None else recorded_day, minute),
                "payload": payload, "provenance": "authored_synthetic_observation_not_product_event"}
        case["observations"].append(item)
        return item["id"]

    def attempt(probe_id, day, outcome="correct", assistance="none", *, minute=0, foreign=None):
        p = probes[probe_id]
        response = p["correct_response"] if outcome == "correct" else p["incorrect_response"]
        if outcome == "missing":
            response = None
        elif outcome == "skipped":
            response = "这次先跳过。"
        elif outcome == "dont_know":
            response = "我现在不会作答。"
        return event("assessment_observation", day, {
            "probe_ref": probe_id, "response": response, "outcome": outcome,
            "assistance": assistance, "task_instance": f"{fid}:{probe_id}",
            "assessment_status": "scripted_fixture_not_live_assessment",
            "answer_exposure": "worked_solution" if assistance == "worked_example" else "not_recorded" if assistance == "unknown" else "none_in_script",
        }, minute=minute, foreign=foreign)

    goal_ref = event("learner_statement", 0, {"text": f"我这个阶段的目标是：{f['goal_a']}", "topic": "goal", "confirmed": True})
    event("resource_view", 1, {"text": f"浏览了《{f['course']}》中与本任务有关的材料，没有提交作答。", "duration_minutes": 12})
    help_level = "worked_example" if pattern == "assisted_success" else "unknown" if pattern == "unknown_assistance_success" else "none"
    base_ref = attempt("base", 3, assistance=help_level)
    refs.append(base_ref)
    rubric = {
        "schema_version": VERSION, "case_id": case["case_id"], "family_id": fid,
        "pattern": pattern, "label_status": "synthetic_author_proposal_pending_teacher_review",
        "primary_question": "下一步教学与验证是否由当前可见证据支持？",
        "acceptable_actions": [], "must_preserve": [], "forbidden_actions": list(GLOBAL_FORBIDDEN),
        "evidence_refs": refs, "expected_history_dependency": True,
        "domain_activity_options": [f["misconception_probe"], f["remediation_activity"], f["next_activity"]],
        "semantic_judging": "Assess meaning and permissible alternatives; never match keywords or a single reference sentence.",
        "teacher_review": {"status": "pending", "reviewer": None, "reviewed_at": None},
    }
    actions, preserve, forbidden = rubric["acceptable_actions"], rubric["must_preserve"], rubric["forbidden_actions"]

    if pattern in ("assisted_success", "independent_once"):
        actions.extend([f"用一个未给答案的任务检查：{f['competency']}", f"先用{f['misconception_probe']}作简短诊断，再按回答调整后续活动"])
        preserve.append("现有正确作答是在完整示例支持下完成，独立能力未验证" if pattern == "assisted_success" else "承认一次独立正确，后续验证仍需新情境；可减少重复完整讲解")
        if pattern == "assisted_success":
            forbidden.append("以已独立通过为由跳过独立检查")
    elif pattern in ("repeated_original", "novel_transfer_once"):
        refs.append(attempt("base" if pattern == "repeated_original" else "near_transfer", 10))
        actions.append(f"选择新的边界或情境检查{f['competency']}；根据表现继续{f['next_activity']}")
        preserve.append("第二次是同一任务原题重做，不能声称完成迁移" if pattern == "repeated_original" else "第二次是改变情境的独立作答，可作为一次变式表现，不能声称长期稳定")
    elif pattern in ("gap_unresolved", "gap_followup_success", "source_retraction"):
        refs.append(attempt("near_transfer", 9, "incorrect"))
        error_ref = event("learner_statement", 9, {"text": f"我当时按这个规则判断：{f['misconception']}", "topic": "reasoning"}, minute=10)
        refs.append(error_ref)
        if pattern == "gap_followup_success":
            refs.append(event("support_feedback", 11, {"text": f"做过这项练习后，我修正了刚才的判断：{f['remediation_activity']}", "effectiveness": "learner_reported"}))
            refs.append(attempt("delayed_transfer", 18))
            actions.extend([f"承认后续一次独立成功，同时用{f['misconception_probe']}检查旧规则是否仍在，再安排{f['next_activity']}", "说明新表现的改善与推断限制，采用针对性抽查或复习，按证据决定是否继续补救"])
            preserve.append("新题成功不一定排除旧错误规则，自述修正也不能替代验证；允许继续诊断旧问题，不能直接宣称问题已解决或长期稳定，也不能忽略新成功把旧错永久化")
        elif pattern == "source_retraction":
            refs.append(event("source_correction", 13, {"target_observation_ids": [refs[-2], error_ref], "text": "刚才那次回答和解释是我代同学录入的，不是我的作答，请撤回作为我的能力依据。", "reason": "wrong_subject"}))
            actions.append(f"撤除被纠正来源对本人能力的影响，重新诊断{f['competency']}")
            preserve.append("撤回错误来源不等于证明已经学会；原始记录仍可审计")
        else:
            actions.extend([f"先诊断{f['misconception_probe']}，再决定是否使用{f['remediation_activity']}", f"针对已呈现的错误规则安排{f['remediation_activity']}，随后独立检查"])
            preserve.append("错误规则有本次回答和明确理由支持，但不能推断固定能力或情绪")
    elif pattern in ("temporary_constraint_active", "temporary_constraint_expired"):
        until = stamp(21, 120) if pattern.endswith("active") else stamp(20, 120)
        refs.append(event("learner_statement", 20, {"topic": "temporary_support", "valid_until": until,
            "text": f"这段时间我只有10分钟，请拆成小步；这一临时安排只到{until}有效。", "time_cap_minutes": 10, "confirmed": True}))
        actions.append(f"围绕{f['competency']}安排可暂停的小步骤与后续验证")
        if pattern.endswith("active"):
            rubric["active_constraints"] = {"max_session_minutes": 10}
            preserve.append("当次总安排不超过10分钟，可明确只推进一个微步骤，后续另约")
        else:
            preserve.append("旧10分钟限制已到期；不能把它当当前硬限制，可询问当前时间")
            forbidden.append("声称当前仍被旧10分钟限制约束")
    elif pattern in ("goal_current", "goal_superseded"):
        refs.append(goal_ref)
        if pattern == "goal_superseded":
            refs.append(event("learner_statement", 19, {"topic": "goal", "text": f"原先的优先目标先暂停，现在优先：{f['goal_b']}", "supersedes": goal_ref, "confirmed": True}))
        else:
            refs.append(event("learner_statement", 19, {"topic": "goal", "text": f"目前继续优先：{f['goal_a']}", "confirms": goal_ref, "confirmed": True}))
        goal = f["goal_b"] if pattern == "goal_superseded" else f["goal_a"]
        actions.append(f"在保持必要基础和独立验证的前提下，把近期活动与当前目标“{goal}”对齐")
        preserve.append("目标只决定优先级，不能作为知识或实践能力证明")
        if pattern == "goal_superseded":
            forbidden.append("未经说明继续把已暂停的旧目标设为当前最高优先级")
    elif pattern == "insufficient_evidence":
        # No scored response; deliberately distinguish absence, skip and explicit uncertainty.
        case["observations"].pop()
        refs.clear()
        refs.append(event("learner_statement", 3, {"topic": "self_report", "text": "我看过这一部分，感觉应该会，但是还没独立验证。"}))
        refs.append(attempt("base", 6, "missing", "unknown"))
        refs.append(attempt("near_transfer", 10, "skipped", "unknown"))
        refs.append(attempt("delayed_transfer", 17, "dont_know", "unknown"))
        actions.append(f"说明能力证据不足，用低负担诊断或示例后独立检查{f['competency']}")
        preserve.append("缺失提交、主动跳过和明确不会分别记录；它们都不是已评分的错误答案")
        forbidden.append("仅由缺失、跳过或自述断言具体误解已经被证实")
    elif pattern == "long_history_return":
        anchor_ref = event("task_paused", 4, {"text": f"我先去补{f['prerequisites'][0]}，之后请带我回到：{f['return_anchor']}", "return_anchor": f["return_anchor"]})
        refs.append(anchor_ref)
        noise_families = [item for item in all_families if item["family_id"] != fid]
        rng = random.Random(int(digest(fid)[:8], 16))
        for i in range(64):
            other = noise_families[rng.randrange(len(noise_families))]
            event("resource_view", 5 + i // 5, {"text": f"浏览学习资料《{other['title']}》的第{i + 1}条笔记；没有提交能力验证。", "duration_minutes": 3 + i % 7}, minute=(i % 5) * 30)
        refs.append(event("learner_statement", 20, {"text": f"补充学习告一段落，我想回到之前暂停的项目位置。补过{f['prerequisites'][0]}，是否足够还需要检查。", "topic": "resume"}))
        actions.append(f"恢复到{f['return_anchor']}，用简短诊断确认前置条件，再安排下一步")
        preserve.append("浏览数量和学习结束自述不证明前置知识已掌握；老返回锚点不能被近期无关浏览覆盖")
    elif pattern == "unknown_assistance_success":
        actions.append(f"说明正确产物的辅助信息缺失，安排简短独立验证{f['competency']}")
        preserve.append("辅助程度未知，既不能断言独立完成，也不能断言抄袭")
        forbidden.append("把未知辅助程度自动填成无辅助")
    elif pattern == "explanation_ineffective":
        refs.append(event("support_feedback", 21, {"text": "刚才一直讲定义和完整步骤，我还是没有弄清原因。这次请先让我预测一个具体例子的结果，再讨论理由，不要先给答案。", "effectiveness": "explicitly_ineffective", "scope": "current_task"}, minute=-5))
        case["observations"][-1]["scope"]["session_id"] = current["session_id"]
        actions.append(f"采用先预测后解释的局部活动，例如{f['misconception_probe']}，再检查是否有效")
        preserve.append("遵守明确提出的本次讲法需求；不能把它固化成永久学习风格")
        forbidden.append("无视明确反馈，继续只重复同一份完整定义和步骤")
    elif pattern == "environment_failure":
        refs.append(event("execution_observation", 19, {"artifact": "runner: prerequisite executable not found; submission was NOT executed; no learner tests were run", "outcome": "infrastructure_error", "student_submission_available": False}))
        actions.append("先澄清或修复评测环境，再恢复原任务；不能把未执行的结果计为学生能力失败")
        preserve.append("已有一次独立正确仍有效；本次环境失败没有产生新的能力判定")
    elif pattern == "team_artifact":
        case["observations"].pop()
        refs.clear()
        refs.append(event("artifact_observation", 3, {"text": "小组提交的产物通过了演示检查，但没有成员分工、个人操作或独立作答记录。", "artifact_scope": "team", "individual_contribution": "unknown"}))
        actions.append(f"认可小组产物完成，另外验证本人能否独立完成{f['competency']}")
        preserve.append("小组通过不等于每名成员独立掌握；不能凭空推断个人贡献")
    elif pattern == "current_input_override":
        refs.append(event("learner_statement", 16, {"topic": "support_preference", "text": "平时我希望先看完整示例，再自己尝试。", "confirmed": True}))
        current["request"] += " 但这一次只有10分钟，请先让我独立试一小步，暂时不要展示答案或完整示例。"
        rubric["active_constraints"] = {"max_session_minutes": 10, "withhold_full_solution": True}
        actions.append(f"优先遵守本次明确要求，十分钟内选择可独立尝试的{f['competency']}相关小步骤")
        preserve.append("本次完整请求应原样提供给所有未来比较条件；历史偏好不能压过当前覆盖")
        rubric["expected_history_dependency"] = False
    elif pattern == "unjustified_correct_result":
        refs.append(attempt("near_transfer", 18))
        refs.append(event("learner_statement", 18, {"text": f"这个结果我是这样猜的：{f['misconception']}。我还不能解释为什么结果是这样。", "topic": "reasoning"}, minute=10))
        actions.append(f"保留结果正确的观察，同时用{f['misconception_probe']}检查所述一般规则与理解依据，再决定是否补救")
        preserve.append("错误的一般规则可能恰好在本题给出正确结果，不得强行声称本题结果与该规则逻辑矛盾；结果正确和理由不足分别保留，不能宣布全部能力失效")
    elif pattern in ("irrelevant_invariance", "scope_invariance", "future_invariance"):
        # Same base educational evidence as independent_once; perturb only irrelevant/unavailable data.
        base, base_gold = build_case(f, "independent_once", all_families)
        rubric = deepcopy(base_gold)
        rubric.update(case_id=case["case_id"], pattern=pattern)
        if pattern == "irrelevant_invariance":
            event("learner_statement", 18, {"topic": "unrelated", "text": "今天整理了桌面壁纸的颜色和窗口位置，这与本次学习内容没有关系。"})
        elif pattern == "scope_invariance":
            attempt("near_transfer", 18, "incorrect", foreign="learner")
            event("learner_statement", 19, {"topic": "temporary_support", "text": "另一个项目今天只安排5分钟。", "time_cap_minutes": 5}, foreign="project")
        else:
            attempt("near_transfer", 24, "incorrect")
            event("learner_statement", 20, {"topic": "reasoning", "text": f"一条到查询之后才补录的历史记录：{f['misconception']}"}, recorded_day=24)
    else:
        raise ValueError(pattern)
    case["observations"].sort(key=lambda e: (e["occurred_at"], e["id"]))
    rubric["evidence_refs"] = sorted(set(rubric["evidence_refs"]))
    return case, rubric


def export_case(case, family):
    """A strict allowlist: no future probes, gold, patterns, split, or oracle material."""
    observations = []
    for item in case["observations"]:
        if not eligible(item, case):
            continue
        item = deepcopy(item)
        if item["kind"] == "assessment_observation":
            probe = next(p for p in family["probes"] if p["id"] == item["payload"]["probe_ref"])
            presented = public_probe(probe, family["family_id"])
            item["payload"]["presented_task"] = presented
            item["payload"]["probe_ref"] = presented["id"]
            item["payload"]["task_instance"] = presented["id"]
        elif item["kind"] in {"learner_statement", "support_feedback", "task_paused", "artifact_observation"}:
            # Author tags are control-plane annotations, not magically extracted profile fields.
            # Natural-language formation/interpretation must work from the original utterance.
            item["payload"] = {"text": item["payload"]["text"]}
        observations.append(item)
    return {"case_id": case["case_id"], "current": deepcopy(case["current"]),
            "course_material": {key: deepcopy(family[key]) for key in ("title", "course", "project_context", "competency", "prerequisites", "task_prompt")},
            "reference_task": public_probe(next(p for p in family["probes"] if p["id"] == "base"), family["family_id"]),
            "history": observations}


def build_pairs(cases, gold):
    by = {(g["family_id"], g["pattern"]): g["case_id"] for g in gold}
    definitions = [
        ("assisted_success", "independent_once", "evidence_sensitivity", "same observed correct response; support differs; acceptable action sets may overlap"),
        ("repeated_original", "novel_transfer_once", "evidence_sensitivity", "original repeat versus a different probe; do not infer stable mastery"),
        ("gap_unresolved", "gap_followup_success", "update_sensitivity", "support self-report plus new independent success; does not necessarily falsify the old rule; not a single-factor intervention"),
        ("temporary_constraint_active", "temporary_constraint_expired", "expiry_sensitivity", "explicit validity window changes; use current cutoff"),
        ("goal_current", "goal_superseded", "priority_sensitivity", "new confirmed priority supersedes old goal"),
        ("independent_once", "irrelevant_invariance", "irrelevant_invariance", "unrelated preference does not justify different teaching need"),
        ("independent_once", "scope_invariance", "scope_invariance", "foreign learner/project observations must not affect the learner"),
        ("independent_once", "future_invariance", "time_invariance", "future occurrence and late ingestion must not affect as-of decision"),
        ("gap_unresolved", "source_retraction", "source_correction", "wrong-subject evidence withdrawn; does not prove competence"),
        ("independent_once", "unknown_assistance_success", "assistance_unknown", "unknown assistance is neither known independence nor evidence of cheating"),
        ("independent_once", "explanation_ineffective", "explicit_support_feedback", "new explicit current-task feedback should affect teaching presentation"),
        ("independent_once", "environment_failure", "infrastructure_boundary", "a tool environment failure does not negate earlier learner evidence"),
    ]
    return [{"family_id": fid, "a": by[(fid, a)], "b": by[(fid, b)], "relation": kind,
             "interpretation": explanation, "requires_different_wording": False}
            for fid in sorted({c["family_id"] for c in cases})
            for a, b, kind, explanation in definitions]


def materialize(root=ROOT):
    families = load_families(root)
    validate_families(families)
    splits = assign_splits(families)
    cases, gold = [], []
    for f in families:
        for pattern in PATTERNS:
            c, g = build_case(f, pattern, families)
            cases.append(c)
            gold.append(g)
    out = root / "data"
    out.mkdir(exist_ok=True)
    write_jsonl(out / "cases.jsonl", cases)
    write_jsonl(out / "rubrics.jsonl", gold)
    write_jsonl(out / "pairs.jsonl", build_pairs(cases, gold))
    write_jsonl(out / "splits.jsonl", [{"family_id": f["family_id"], "split": splits[f["family_id"]]} for f in families])
    with (out / "teacher_review_queue.csv").open("w", newline="") as stream:
        fields = ["case_id", "family_id", "domain", "split", "pattern", "review_status", "reviewer", "decision", "notes"]
        writer = csv.DictWriter(stream, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        domains = {f["family_id"]: f["domain"] for f in families}
        for g in gold:
            writer.writerow({"case_id": g["case_id"], "family_id": g["family_id"], "domain": domains[g["family_id"]],
                "split": splits[g["family_id"]], "pattern": g["pattern"], "review_status": "pending"})
    files = sorted((root / "catalog").glob("*.json")) + sorted(out.glob("*.jsonl")) + [out / "teacher_review_queue.csv"]
    manifest = {"schema_version": VERSION, "seed": SEED, "authorship": "AI-assisted original synthetic curricular fixtures",
                "real_students": 0, "teacher_reviewed_cases": 0, "product_runs": 0, "ablation_runs": 0,
                "holdout_status": "public_author_visible_family_disjoint_not_blind",
                "files": {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return validate(root)


def validate_families(families):
    required = {"family_id", "domain", "title", "course", "level", "project_context", "competency", "prerequisites",
                "misconception", "misconception_probe", "remediation_activity", "next_activity", "return_anchor",
                "goal_a", "goal_b", "task_prompt", "probes", "source_basis"}
    assert Counter(f["domain"] for f in families) == Counter({d: 8 for d in DOMAINS}), "domain coverage must be exactly 9 x 8"
    assert len({f["family_id"] for f in families}) == len(families), "duplicate family id"
    assert len({f["title"] for f in families}) == len(families), "duplicate task title"
    probes_seen = set()
    for f in families:
        assert required <= f.keys(), (f["family_id"], "missing fields", required - f.keys())
        assert f["level"] in {"foundation", "intermediate", "integrated"}
        assert len(f["prerequisites"]) >= 2
        assert f["goal_a"] != f["goal_b"]
        assert {p["id"] for p in f["probes"]} == {"base", "near_transfer", "delayed_transfer"}
        for p in f["probes"]:
            for field in ("prompt", "artifact", "correct_response", "incorrect_response", "explanation", "observable_checks", "novelty", "answer_validation"):
                assert p.get(field), (f["family_id"], p["id"], field)
            assert p["correct_response"] != p["incorrect_response"]
            assert p["answer_validation"] in {"executable", "reasoned_draft"}
            if p["answer_validation"] == "executable":
                assert p.get("oracle_id"), "executable probe requires check binding"
            fingerprint = digest([p["prompt"], p["artifact"]])
            assert fingerprint not in probes_seen, (f["family_id"], "duplicate probe material")
            probes_seen.add(fingerprint)


def validate(root=ROOT):
    families = load_families(root)
    validate_families(families)
    by_family = {f["family_id"]: f for f in families}
    cases = read_jsonl(root / "data/cases.jsonl")
    rubrics = read_jsonl(root / "data/rubrics.jsonl")
    pairs = read_jsonl(root / "data/pairs.jsonl")
    split_rows = read_jsonl(root / "data/splits.jsonl")
    assert len(split_rows) == len(families) and len({r["family_id"] for r in split_rows}) == len(families)
    splits = {r["family_id"]: r["split"] for r in split_rows}
    assert splits == assign_splits(families), "split assignment drift"
    assert len(cases) == len(families) * len(PATTERNS)
    assert len({c["case_id"] for c in cases}) == len(cases)
    by_case = {c["case_id"]: c for c in cases}
    assert len(rubrics) == len(cases) and {g["case_id"] for g in rubrics} == set(by_case)
    by_gold = {g["case_id"]: g for g in rubrics}
    visible_hashes = Counter()
    visible_lengths = []
    histories = Counter()
    events, excluded = 0, 0
    for c in cases:
        assert c["family_id"] in by_family
        g = by_gold[c["case_id"]]
        assert g["family_id"] == c["family_id"]
        assert g["pattern"] in PATTERNS
        histories[(c["family_id"], g["pattern"])] += 1
        assert g["label_status"] == "synthetic_author_proposal_pending_teacher_review"
        assert g["teacher_review"]["status"] == "pending"
        assert g["acceptable_actions"] and g["must_preserve"] and g["forbidden_actions"]
        ids = {e["id"] for e in c["observations"]}
        assert len(ids) == len(c["observations"]), "duplicate observation id"
        visible_ids = {e["id"] for e in c["observations"] if eligible(e, c)}
        assert set(g["evidence_refs"]) <= visible_ids, "rubric relies on hidden evidence"
        assert c["observations"] == sorted(c["observations"], key=lambda e: (e["occurred_at"], e["id"]))
        for e in c["observations"]:
            assert datetime.fromisoformat(e["recorded_at"]) >= datetime.fromisoformat(e["occurred_at"])
            assert e["provenance"] == "authored_synthetic_observation_not_product_event"
            if e["kind"] == "assessment_observation":
                p = e["payload"]
                assert p["probe_ref"] in {"base", "near_transfer", "delayed_transfer"}
                assert p["outcome"] in {"correct", "incorrect", "missing", "skipped", "dont_know"}
                assert p["assistance"] in {"none", "worked_example", "unknown"}
                assert (p["response"] is None) == (p["outcome"] == "missing")
                assert p["assessment_status"] == "scripted_fixture_not_live_assessment"
            for key in ("target_observation_ids",):
                assert set(e["payload"].get(key, [])) <= ids
        view = export_case(c, by_family[c["family_id"]])
        forbidden_keys = {"correct_response", "incorrect_response", "oracle", "oracle_id", "explanation", "observable_checks", "novelty", "acceptable_actions", "pattern", "split", "teacher_review", "misconception", "remediation_activity", "next_activity", "topic", "valid_until", "time_cap_minutes", "effectiveness"}
        def check_keys(obj):
            if isinstance(obj, dict):
                assert not (obj.keys() & forbidden_keys), (c["case_id"], obj.keys() & forbidden_keys)
                for v in obj.values():
                    check_keys(v)
            elif isinstance(obj, list):
                for v in obj:
                    check_keys(v)
        check_keys(view)
        # Hash with case id removed: scoped/future controls are intentionally identical.
        visible_hashes[digest({k: v for k, v in view.items() if k != "case_id"})] += 1
        visible_lengths.append(len(encoded(view)))
        events += len(c["observations"])
        excluded += len(c["observations"]) - len(view["history"])
    assert all(histories[(f["family_id"], p)] == 1 for f in families for p in PATTERNS)
    assert len(pairs) == len(families) * 12
    for pair in pairs:
        a, b = by_case[pair["a"]], by_case[pair["b"]]
        assert a["family_id"] == b["family_id"] == pair["family_id"]
        assert splits[a["family_id"]] == splits[b["family_id"]]
        assert a["current"] == b["current"], "matched pair changed current request"
        if pair["relation"] in {"scope_invariance", "time_invariance"}:
            av = export_case(a, by_family[a["family_id"]])
            bv = export_case(b, by_family[b["family_id"]])
            av.pop("case_id"); bv.pop("case_id")
            assert av == bv, "unavailable information leaked into export"
        elif pair["relation"] == "irrelevant_invariance":
            assert a["observations"] == b["observations"][:-1]
        elif by_gold[a["case_id"]]["pattern"] == "assisted_success":
            aa, bb = deepcopy(a["observations"]), deepcopy(b["observations"])
            aa[-1]["payload"]["assistance"] = bb[-1]["payload"]["assistance"]
            aa[-1]["payload"]["answer_exposure"] = bb[-1]["payload"]["answer_exposure"]
            assert aa == bb, "assistance pair changed unrelated evidence"
    manifest = json.loads((root / "data/manifest.json").read_text())
    expected_paths = {str(p.relative_to(root)) for p in (root / "catalog").glob("*.json")}
    expected_paths.update("data/" + name for name in ("cases.jsonl", "rubrics.jsonl", "pairs.jsonl", "splits.jsonl", "teacher_review_queue.csv"))
    assert set(manifest["files"]) == expected_paths, "manifest omitted/added data files"
    for relative, expected in manifest["files"].items():
        assert hashlib.sha256((root / relative).read_bytes()).hexdigest() == expected, relative
    assert manifest["real_students"] == manifest["teacher_reviewed_cases"] == manifest["product_runs"] == manifest["ablation_runs"] == 0
    return {"validation": "passed", "schema_version": VERSION, "domains": len(DOMAINS),
            "task_families": len(families), "authored_probes": sum(len(f["probes"]) for f in families),
            "trajectories": len(cases), "decision_points": len(cases), "history_patterns": len(PATTERNS),
            "paired_comparisons": len(pairs), "scripted_observations": events, "out_of_scope_or_future_observations": excluded,
            "distinct_visible_inputs": len(visible_hashes), "intentional_equivalent_input_groups": sum(n > 1 for n in visible_hashes.values()),
            "visible_input_characters_not_tokens": {"min": min(visible_lengths), "median": statistics.median(visible_lengths), "max": max(visible_lengths)},
            "families_by_domain": dict(sorted(Counter(f["domain"] for f in families).items())),
            "families_by_split": dict(sorted(Counter(splits.values()).items())),
            "cases_by_split": dict(sorted(Counter(splits[c["family_id"]] for c in cases).items())),
            "probe_answer_validation": dict(Counter(p["answer_validation"] for f in families for p in f["probes"])),
            "observation_kinds": dict(Counter(e["kind"] for c in cases for e in c["observations"])),
            "scripted_assessment_outcomes": dict(Counter(e["payload"]["outcome"] for c in cases for e in c["observations"] if e["kind"] == "assessment_observation")),
            "human_teacher_reviewed": 0, "product_or_ablation_runs": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "validate", "export", "inspect", "review"])
    parser.add_argument("--case-id")
    parser.add_argument("--family-id")
    parser.add_argument("--split", choices=["development", "validation", "holdout"])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command in {"build", "validate"}:
        result = materialize() if args.command == "build" else validate()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    assert args.case_id or args.split or args.family_id, "choose --case-id, --family-id or --split"
    validate()
    families = {f["family_id"]: f for f in load_families()}
    splits = assign_splits(list(families.values()))
    cases = [c for c in read_jsonl(ROOT / "data/cases.jsonl")
             if (not args.case_id or c["case_id"] == args.case_id)
             and (not args.family_id or c["family_id"] == args.family_id)
             and (not args.split or splits[c["family_id"]] == args.split)]
    assert cases, "no matching cases"
    rows = [export_case(c, families[c["family_id"]]) for c in cases]
    if args.command == "inspect":
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    elif args.command == "review":
        gold = {g["case_id"]: g for g in read_jsonl(ROOT / "data/rubrics.jsonl")}
        parts = ["# 教学案例审核材料", "仅供评审端：含答案与标签；所有教学标签尚待教师审核。"]
        for fid in sorted({c["family_id"] for c in cases}):
            f = families[fid]
            parts.extend([f"## {f['title']} ({fid})", f["project_context"], "能力目标：" + f["competency"]])
            for p in f["probes"]:
                parts.extend([f"### {p['id']}", p["prompt"], "```text\n" + p["artifact"] + "\n```",
                              "参考正确回答：" + str(p["correct_response"]), "示例错误回答：" + str(p["incorrect_response"]),
                              "解释：" + p["explanation"], "情境变化：" + p["novelty"], "技术校验：" + p["answer_validation"]])
        for c, view in zip(cases, rows):
            g = gold[c["case_id"]]
            parts.extend(["## " + c["case_id"] + " / " + g["pattern"], "当前请求：" + c["current"]["request"],
                          "查询时刻：" + c["current"]["at"], "### 已授权且截至查询时可见的历史"])
            for e in view["history"]:
                parts.append(f"- {e['id']} | {e['occurred_at']} | {e['kind']}\n\n```json\n" + json.dumps(e["payload"], ensure_ascii=False, indent=2) + "\n```")
            parts.append("### 作者建议的可接受行为")
            parts.extend("- " + text for text in g["acceptable_actions"])
            parts.append("### 需要保留的边界")
            parts.extend("- " + text for text in g["must_preserve"])
            parts.append("### 不可接受行为")
            parts.extend("- " + text for text in g["forbidden_actions"])
            parts.append("来源：" + ", ".join(g["evidence_refs"]))
            parts.append("教师审核：pending；审核人、结论与理由留待填写。")
        rendered = "\n\n".join(parts) + "\n"
        if args.output:
            with args.output.open("x") as stream:
                stream.write(rendered)
            print(str(args.output.resolve()))
        else:
            print(rendered)
    else:
        assert args.output, "export requires --output outside the dataset directory"
        assert not args.output.resolve().is_relative_to(ROOT), "export outside source/gold tree"
        with args.output.open("x") as stream:
            stream.write("".join(encoded(row) + "\n" for row in rows))
        print(json.dumps({"exported": len(rows), "path": str(args.output.resolve())}, ensure_ascii=False))


if __name__ == "__main__":
    main()
