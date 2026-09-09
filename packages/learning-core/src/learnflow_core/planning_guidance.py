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
from .teaching_guidance import SUPPORTED_GUIDANCE_VERSIONS, _time


def _decision(action: str, sources: list[dict], *, unknown: list[str] | None = None) -> dict:
    """Explain an applied deterministic choice; this is never learner evidence."""
    return {"action": action, "policy_version": PLANNING_GUIDANCE_POLICY_VERSION,
            "source_event_ids": sorted({ref for row in sources
                                        for ref in [row.get("source_event_id"), *(row.get("source_event_ids") or [])]
                                        if type(ref) is int and ref > 0}),
            "uncertainties": list(unknown or []), "mastery_inference": False}


def _episode_feedback(context: dict, at: datetime) -> tuple[str | None, dict | None]:
    """Consume only the server's scoped, source-validated read projection.

    No answers or model suggestions are inspected. Missing help/independence
    stays unknown; a retry can never supply independent-transfer evidence.
    """
    episodes = (context.get("practice") or {}).get("learning_episodes") or []
    if not isinstance(episodes, list):
        return None, None
    valid = []
    for row in episodes:
        if not isinstance(row, dict) or row.get("schema_version") != "learnflow.learning-episode.v1":
            continue
        when = _time(row.get("occurred_at"))
        refs = row.get("source_event_ids")
        if (when is None or when > at or type(row.get("attempt_id")) is not int
                or row["attempt_id"] <= 0 or not isinstance(refs, list) or not refs
                or not all(type(ref) is int and ref > 0 for ref in refs)
                or any(not isinstance(row.get(key), list) or not row[key]
                       or not all(type(ref) is int and ref > 0 for ref in row[key])
                       for key in ("source_fact_ids", "source_mutation_ids"))
                or not isinstance(row.get("outcome"), dict) or not isinstance(row.get("task"), dict)):
            continue
        # Attempt allocation order is not assessment event chronology.
        valid.append((when, max(refs), row))
    if not valid:
        return None, None
    when, _, row = max(valid, key=lambda value: value[:2])
    outcome = row.get("outcome") or {}
    correct, assistance, independent = (outcome.get(key) for key in ("correct", "assistance_level", "independent"))
    task = row.get("task") or {}
    if correct is False:
        feedback = "evaluated_error"
    elif correct is not True:
        feedback = "incomplete_attempt"
    elif assistance in {"hint", "guided", "answer", "solution", "full", "partial"} or task.get("attempt_kind") in {"retry", "repeated_original"}:
        feedback = "supported_success"
    elif assistance == "none" and independent is True:
        feedback = "independent_success"
    else:
        feedback = "success_assistance_unspecified"
    return feedback, {"kernel": "practice", "slot": "practice_feedback",
                      "source_event_id": max(row["source_event_ids"]),
                      "source_event_ids": sorted(row["source_event_ids"]),
                      "attempt_id": row["attempt_id"], "scope": deepcopy(row.get("scope") or {}),
                      "occurred_at": when.isoformat(), "policy_version": row["schema_version"],
                      "source_kind": "learning_episode"}


def compile_planning_guidance(context: dict | None, *, now=None) -> dict:
    at = _time(now) if now is not None else datetime.now(timezone.utc)
    controls: dict[str, Any] = {"policy_version": PLANNING_GUIDANCE_POLICY_VERSION, "sources": []}
    if at is None:
        return {**controls, "decisions": []}
    for kernel in ("human", "knowledge", "practice", "value", "structure"):
        values = (context or {}).get(kernel) or {}
        # Apply older sources first: list/priority order must not determine the
        # newest learning result or current goal. The selector owns scope.
        entries = [row for row in values.get("teaching_guidance") or [] if isinstance(row, dict)]
        for entry in sorted(entries, key=lambda row: (_time(row.get("occurred_at")) or datetime.min.replace(tzinfo=timezone.utc),
                                                     row.get("source_event_id") if type(row.get("source_event_id")) is int else -1)):
            if not isinstance(entry, dict) or entry.get("kernel") != kernel:
                continue
            if entry.get("policy_version") not in SUPPORTED_GUIDANCE_VERSIONS or entry.get("status") != "active":
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
            elif kernel == "structure" and slot == "return_anchor" and entry.get("requested_anchor"):
                controls["return_anchor"] = str(entry["requested_anchor"])[:220]
                applied = True
            if applied:
                if slot in {"practice_feedback", "current_blocker", "current_priority", "return_anchor"}:
                    controls["sources"] = [row for row in controls["sources"]
                                           if (row["kernel"], row["slot"]) != (kernel, slot)]
                controls["sources"].append({key: deepcopy(entry.get(key)) for key in
                    ("kernel", "slot", "source_event_id", "scope", "source_scope", "application_scope",
                     "source_span", "occurred_at", "expires_at", "policy_version")})
    feedback, source = _episode_feedback(context or {}, at)
    prior = [row for row in controls["sources"] if row.get("slot") == "practice_feedback"]
    if source is not None and (not prior or
        (_time(source["occurred_at"]), source["source_event_id"]) >
        max((_time(row["occurred_at"]), row["source_event_id"]) for row in prior)):
        controls["practice_feedback"] = feedback
        controls["sources"] = [row for row in controls["sources"] if row.get("slot") != "practice_feedback"] + [source]
    decisions = []
    actions = {"time_budget": "limit_session", "support": "small_steps", "current_priority": "prioritize_current_goal",
               "return_anchor": "restore_learning_anchor"}
    for slot, action in actions.items():
        sources = [row for row in controls["sources"] if row["slot"] == slot]
        if sources:
            decisions.append(_decision(action, sources))
    if controls.get("blocker"):
        decisions.append(_decision("verify_reported_resolution" if controls["blocker"] == "resolved" else "check_current_gap",
                                   [row for row in controls["sources"] if row["slot"] == "current_blocker"],
                                   unknown=["self_report_is_not_mastery"]))
    feedback = controls.get("practice_feedback")
    if feedback:
        action = {"supported_success": "fade_support_then_independent_probe", "independent_success": "independent_variant_or_reasoning_check",
                  "success_assistance_unspecified": "clarify_assistance", "evaluated_error": "diagnose_first_error",
                  "incomplete_attempt": "clarify_nonresponse"}[feedback]
        decisions.append(_decision(action, [row for row in controls["sources"] if row["slot"] == "practice_feedback"],
                                   unknown=["stable_mastery_not_established"]))
    controls["decisions"] = decisions
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
    previous = result.get("teaching_constraints") or {}
    basis = result.get("planning_basis_minutes")
    if type(previous.get("max_minutes")) is int and type(basis) is int and basis > 0:
        # Recompute from the original estimate: changing/expiring a temporary
        # constraint must not preserve a previous clipped estimate indefinitely.
        result["estimated_minutes"] = basis
    result.pop("session_focus", None)
    result["teaching_constraints"] = controls
    applied_actions: set[str] = set()
    maximum = controls.get("max_minutes")
    if type(maximum) is int:
        applied_actions.add("limit_session")
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
            applied_actions.add("verify_reported_resolution")
            prepare(learn, "当前卡点已由学生自述解决，停止重复旧讲解；先做一个小检查。")
        elif blocker == "current_gap":
            applied_actions.add("check_current_gap")
            detail = f"“{controls['blocker_detail']}”" if controls.get("blocker_detail") else ""
            prepare(learn, f"先处理当前卡点{detail}：拆解尚未理解的一小步，用小例子解释，再做简短检查。")
        if controls.get("small_steps"):
            applied_actions.add("small_steps")
            if learn.get("kind") == "learn":
                learn["title"] = "分小步推进当前目标"
            prepare(learn, "每次只推进一个小步骤，完成后确认是否继续。")
        if type(maximum) is int:
            prepare(learn, result["session_focus"]["instruction"])
        if controls.get("return_anchor"):
            applied_actions.add("restore_learning_anchor")
            prepare(learn, f"沿已有学习路径回到：{controls['return_anchor']}。先核对上次暂停位置，不据此改变掌握状态。")
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
            applied_actions.add({
                "supported_success": "fade_support_then_independent_probe",
                "independent_success": "independent_variant_or_reasoning_check",
                "success_assistance_unspecified": "clarify_assistance",
                "evaluated_error": "diagnose_first_error", "incomplete_attempt": "clarify_nonresponse",
            }[feedback])
            practice["required"] = True
            if practice.get("kind") == "practice":
                practice["purpose"] = "记录正式尝试与真实帮助等级，再按原验收条件继续。"
            prepare(practice, {
                "supported_success": "记录显示这次尝试在支持下完成；先逐步撤除提示，再尝试一个无提示小变式，并保留真实帮助等级。",
                "independent_success": "记录中有一次明确的独立成功，接下来做无提示小变式或解释理由的检查；这仍不等于稳定掌握。",
                "success_assistance_unspecified": "记录显示通过但帮助情况未知，先确认辅助程度，再安排无提示小检查；不声称独立完成。",
                "evaluated_error": "先定位第一个错误步骤，给一个针对性提示后重试，并通过正式纠错闭环验证。",
                "incomplete_attempt": "先确认是不会、跳过还是未提交，再提供起步支持；不把缺失回答当作答错。",
            }[feedback])
    for phase in phases:
        if instructions := preparations.get(phase["id"]):
            phase["teaching_preparation"] = instructions
            phase["teaching_preparation_sources"] = deepcopy(controls.get("sources") or [])
            phase["purpose"] = "".join(instructions) + str(phase.get("purpose") or "")
    old_priority = result.pop("teaching_priority_prefix", None)
    if old_priority and str(result.get("summary") or "").startswith(old_priority):
        result["summary"] = result["summary"][len(old_priority):]
    if controls.get("current_priority"):
        applied_actions.add("prioritize_current_goal")
        prefix = f"本次优先推进：{controls['current_priority']}。"
        summary = str(result.get("summary") or "")
        result["summary"] = summary if summary.startswith(prefix) else prefix + summary
        result["teaching_priority_prefix"] = prefix
    result["teaching_decisions"] = [deepcopy(row) for row in controls.get("decisions") or []
                                    if row.get("action") in applied_actions]
    result["phases"] = phases
    return result
