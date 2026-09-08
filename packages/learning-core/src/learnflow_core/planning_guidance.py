"""Read-only planning constraints compiled from scoped teaching guidance.

The caller must first use ContextPacket's scope/archive/turn selector. This
module does not read or write learner state, infer mastery, or interpret model
text as a control. A final deterministic pass also constrains model proposals.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from .registry_core import PLANNING_GUIDANCE_POLICY_VERSION
from .teaching_guidance import GUIDANCE_VERSION, _time


def compile_planning_guidance(context: dict | None, *, now=None) -> dict:
    at = _time(now) if now is not None else datetime.now(timezone.utc)
    controls: dict[str, Any] = {"policy_version": PLANNING_GUIDANCE_POLICY_VERSION, "sources": []}
    for kernel in ("human", "knowledge", "practice", "value"):
        values = (context or {}).get(kernel) or {}
        for entry in values.get("teaching_guidance") or []:
            if not isinstance(entry, dict) or entry.get("kernel") != kernel:
                continue
            if entry.get("policy_version") != GUIDANCE_VERSION or entry.get("status") != "active":
                continue
            if entry.get("cancelled") or entry.get("evidence_kind") == "explicit_cancellation":
                continue
            occurred = _time(entry.get("occurred_at"))
            expiration = _time(entry.get("expires_at"))
            if occurred is None or occurred > at or type(entry.get("source_event_id")) is not int:
                continue
            if entry["source_event_id"] <= 0 or (entry.get("lifetime") != "persistent" and
                                                (expiration is None or expiration <= at)):
                continue
            slot, kind = entry.get("slot"), entry.get("evidence_kind")
            applied = False
            if kernel == "human" and slot == "time_budget":
                minutes = entry.get("minutes")
                if type(minutes) is int and 1 <= minutes <= 480:
                    controls["max_minutes"] = min(controls.get("max_minutes", 480), minutes)
                    applied = True
            elif kernel == "human" and slot == "support" and kind == "explicit_request":
                # All current support controls request a smaller step. This is a
                # teaching response, not an inferred emotional or medical state.
                controls["small_steps"] = True
                controls["max_minutes"] = min(controls.get("max_minutes", 480), 20)
                applied = True
            elif kernel == "knowledge" and slot == "current_blocker":
                if kind in {"self_reported_gap", "self_reported_resolution"}:
                    controls["blocker"] = "resolved" if kind == "self_reported_resolution" else "current_gap"
                    controls.pop("blocker_detail", None)
                    controls.pop("blocker_evidence", None)
                    if kind == "self_reported_gap":
                        # Preserve the actual gap only when its selected Fact
                        # belongs to this very guidance event, not a stale scalar.
                        for row in values.get("relevant_evidence") or []:
                            detail = row.get("detail") or {}
                            predicate = detail.get("predicate")
                            if detail.get("source_event_id") != entry["source_event_id"] or predicate not in {
                                "short_term.knowledge_gap", "short_term.pending_question",
                            }:
                                continue
                            prefix = predicate.rsplit(".", 1)[-1] + ":"
                            text = str(row.get("text") or "")
                            if text.startswith(prefix) and (body := text[len(prefix):].strip()):
                                controls["blocker_detail"] = body[:400]
                                controls["blocker_evidence"] = {key: deepcopy(row.get(key)) for key in
                                    ("id", "detail", "scope", "evidence_refs")}
                                break
                    applied = True
            elif kernel == "practice" and slot == "practice_feedback":
                if kind in {"supported_success", "independent_success", "success_assistance_unspecified",
                            "evaluated_error", "incomplete_attempt"}:
                    controls["practice_feedback"] = kind
                    applied = True
            elif kernel == "value" and slot == "current_priority" and entry.get("requested_priority"):
                controls["current_priority"] = str(entry["requested_priority"])[:220]
                applied = True
            if applied:
                controls["sources"].append({key: deepcopy(entry.get(key)) for key in
                    ("kernel", "slot", "source_event_id", "scope", "occurred_at", "expires_at", "policy_version")})
    return controls


def enforce_planning_guidance(plan: dict, controls: dict | None) -> dict:
    """Apply trusted compiled controls, preserving phase IDs and acceptance rules.

    Controls come from the scoped input, never the model-returned plan. They
    constrain the next session; they do not make the complete task fit a tiny
    budget or mark any phase complete.
    """
    result = deepcopy(plan)
    controls = deepcopy(controls or {})
    if controls.get("policy_version") != PLANNING_GUIDANCE_POLICY_VERSION:
        return result
    result["teaching_constraints"] = controls
    maximum = controls.get("max_minutes")
    if type(maximum) is int:
        result["estimated_minutes"] = min(maximum, max(1, int(result.get("estimated_minutes") or maximum)))
        result["session_focus"] = {
            "max_minutes": result["estimated_minutes"], "max_new_objectives": 1,
            "completion_scope": "one_small_step",
            "instruction": "本次只推进一个可完成的小目标，预留收尾；未完成阶段留待后续，不承诺本次完成整个任务。",
        }
    result.setdefault("planning_basis_minutes", int(plan.get("estimated_minutes") or 1))
    phases = result.get("phases") or []
    # Remove our previous preparation prefix before applying the same controls
    # again (model validation and post-replan status restoration both do this).
    for phase in phases:
        if phase.get("status") == "completed":
            continue
        old = "".join(phase.get("teaching_preparation") or [])
        purpose = str(phase.get("purpose") or "")
        if old and purpose.startswith(old):
            phase["purpose"] = purpose[len(old):]
        phase.pop("teaching_preparation", None)
        phase.pop("teaching_preparation_sources", None)
    by_kind = {phase.get("kind"): phase for phase in phases}
    verify = by_kind.get("verify")
    if verify is not None and verify.get("status") != "completed":
        verify["required"] = True
        verify["purpose"] = "用无提示独立作答或可检查产物验证当前目标；准备过程中的帮助不能计为独立通过。"
    active = [phase for phase in phases if phase.get("status") != "completed"]
    active_by_kind = {phase.get("kind"): phase for phase in active}
    learn = active_by_kind.get("learn") or (active[0] if active else None)
    preparations: dict[str, list[str]] = {}

    def prepare(phase, instruction):
        if phase is not None:
            preparations.setdefault(phase["id"], []).append(instruction)

    if learn is not None:
        blocker = controls.get("blocker")
        if blocker in {"resolved", "current_gap"} and learn.get("kind") == "learn":
            # Current evidence overrides a stale scalar gap; keep the topic in
            # the task objective, not a contradictory old teaching instruction.
            learn["purpose"] = "完成小检查后衔接下一步，不据此认定稳定掌握。"
        if blocker == "resolved":
            prepare(learn, "当前卡点已由学生自述解决，停止重复旧讲解；先做一个小检查。")
        elif blocker == "current_gap":
            detail = f"“{controls['blocker_detail']}”" if controls.get("blocker_detail") else ""
            prepare(learn, f"先处理当前卡点{detail}：拆解尚未理解的一小步，用小例子解释，再做简短检查。")
        if controls.get("small_steps"):
            if learn.get("kind") == "learn":
                learn["title"] = "分小步推进当前目标"
            prepare(learn, "每次只推进一个小步骤，完成后确认是否继续。")
        if type(maximum) is int:
            prepare(learn, result["session_focus"]["instruction"])
    feedback = controls.get("practice_feedback")
    if feedback:
        practice = active_by_kind.get("practice")
        if practice is None and "practice" not in by_kind:
            # A model may omit practice; insert the existing kind at most once.
            practice = {"id": "practice", "kind": "practice", "title": "练习与支持调整",
                        "methods": ["practice_verification", "remediation_loop"], "required": True,
                        "status": "pending", "completion_rule": "提交正式练习，保留帮助等级与判题结果。",
                        "artifact_outputs": ["exercise"]}
            index = next((i for i, p in enumerate(phases) if p.get("kind") == "verify"), len(phases))
            phases.insert(index, practice)
        elif practice is None:
            # New evidence must reach a runnable phase, without reopening or
            # relabelling a historical completed phase as newly performed work.
            practice = active[0] if active else None
        if practice is not None:
            practice["required"] = True
            if practice.get("kind") == "practice":
                practice["purpose"] = "记录正式尝试与真实帮助等级，再按原验收条件继续。"
            prepare(practice, {
                "supported_success": "本次在支持下完成；先逐步撤除提示，再尝试一个无提示小变式，并保留真实帮助等级。",
                "independent_success": "本次已有独立成功，接下来做无提示小变式或解释理由的检查；不把旧受助记录当成本次状态。",
                "success_assistance_unspecified": "本次通过但帮助情况未知，先确认辅助程度，再安排无提示小检查；不声称独立完成。",
                "evaluated_error": "先定位第一个错误步骤，给一个针对性提示后重试，并通过正式纠错闭环验证。",
                "incomplete_attempt": "先确认是不会、跳过还是未提交，再提供起步支持；不把缺失回答当作答错。",
            }[feedback])
    for phase in phases:
        if instructions := preparations.get(phase["id"]):
            phase["teaching_preparation"] = instructions
            phase["teaching_preparation_sources"] = deepcopy(controls.get("sources") or [])
            phase["purpose"] = "".join(instructions) + str(phase.get("purpose") or "")
    if controls.get("current_priority"):
        prefix = f"本次优先推进：{controls['current_priority']}。"
        summary = str(result.get("summary") or "")
        result["summary"] = summary if summary.startswith(prefix) else prefix + summary
    result["phases"] = phases
    return result
