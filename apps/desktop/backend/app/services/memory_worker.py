"""Persistent single-process worker for validated memory consolidation."""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.database import async_session
from app.models.learning import (
    EvidenceEvent,
    MemoryClaim,
    MemoryEdge,
    MemoryFact,
    MemoryModule,
    MemoryNode,
    MemorySynthesisRun,
)
from app.services.memory_graph import (
    MODULE_VERSION_POLICY,
    MAX_SYNTHESIS_ATTEMPTS,
    effective_evidence_ids,
    _add_edge,
    _bounded_evidence_ids,
    current_memory_module,
    input_fingerprint,
    maybe_queue_synthesis,
    module_evidence_fact_ids,
    rebuild_kernel_long_term_from_modules,
)
from app.services.architecture_registry import KERNELS, REGISTRY_VERSION
from app.services.five_kernel_context import (
    MEMORY_SCHEMA_VERSION,
    memory_salience,
    refresh_kernel_head,
    subject_parts,
)


class SynthesisClaimDraft(BaseModel):
    claim_type: Literal["record", "independent_success", "stable_mastery", "transfer"] | None = None
    text: str = Field(min_length=1, max_length=800)
    predicate: str = Field(min_length=1, max_length=255)
    value: Any = None
    evidence_fact_ids: list[int] = Field(min_length=1)


class SynthesisDraft(BaseModel):
    summary: str = Field(min_length=1, max_length=1200)
    claims: list[SynthesisClaimDraft] = Field(min_length=1, max_length=8)


def _asserts_mastery(text: str, predicate: str) -> bool:
    """Distinguish a mastery assertion from an explicit evidence boundary."""
    remaining = text
    boundary_found = False
    for pattern in (
        r"(?:未|尚未|不|并未|没有|缺乏|不能证明|无法证明|不足以证明)[^，。；]{0,16}掌握(?:证据|结论|程度|状态)?",
        r"(?:不构成|不代表|不可视为|不能视为)[^，。；]{0,16}掌握",
        r"掌握(?:证据|结论)[^，。；]{0,16}(?:不足|缺乏|未验证|待验证|不存在)",
        r"掌握(?:程度|状态)[^，。；]{0,16}(?:未|不|尚未|待验证)",
    ):
        remaining, count = re.subn(pattern, "", remaining)
        boundary_found = boundary_found or count > 0
    if "掌握" in remaining:
        return True
    return "master" in predicate.casefold() and not boundary_found


async def normalize_self_reported_claim_statuses(
    db: AsyncSession,
    *,
    learner_id: int | None = None,
    module_node_id: int | None = None,
) -> int:
    """Repair derived Claim labels from their immutable evidence closure."""
    query = (
        select(MemoryNode, MemoryClaim)
        .join(MemoryClaim, MemoryClaim.node_id == MemoryNode.id)
        .where(MemoryClaim.verification_status != "verified")
    )
    if learner_id is not None:
        query = query.where(MemoryNode.learner_id == learner_id)
    if module_node_id is not None:
        query = query.where(MemoryClaim.module_node_id == module_node_id)
    changed = 0
    for node, claim in (await db.execute(query)).all():
        evidence_ids = [
            int(item) for item in (node.payload or {}).get("evidence_fact_ids", [])
        ]
        if not evidence_ids:
            continue
        grades = list((await db.execute(
            select(MemoryFact.evidence_grade).where(
                MemoryFact.node_id.in_(evidence_ids),
            )
        )).scalars().all())
        if len(grades) == len(evidence_ids) and all(
            grade == "self_reported" for grade in grades
        ) and claim.verification_status != "self_reported":
            claim.verification_status = "self_reported"
            changed += 1
    return changed


def _deterministic_draft(
    kernel_name: str,
    subject_key: str,
    rows: list[tuple[MemoryNode, MemoryFact, EvidenceEvent]],
) -> SynthesisDraft:
    facts = [node for node, _, _ in rows]
    def render(node, fact, event):
        if event.event_type == "memory_correction_retracted":
            return "[corrected] 学习者已撤回相关认识，不再作为当前背景使用"
        if event.event_type == "memory_correction_added":
            return "[corrected] 学习者更正为：" + str((event.payload or {}).get("correction", ""))
        return f"[{fact.evidence_grade}] {node.text}"
    # New corrections must remain visible even in the bounded text projection.
    ordered = sorted(rows, key=lambda row: (row[1].evidence_grade == "corrected", row[0].id), reverse=True)
    rendered = [render(*row) for row in ordered]
    detail = "；".join(rendered)
    policy = KERNELS[kernel_name]
    prefix = {
        "structure": "可返回的学习位置与依赖记录",
        "knowledge": "当前可证伪的知识证据记录",
        "human": "当前可纠正的教学适配参考",
        "value": "学习者目标、兴趣与相关性记录",
        "practice": "带辅助等级与情境范围的实践记录",
    }[kernel_name]
    summary = f"{subject_key} · {prefix}：{detail}"
    if len(summary) > 1200:
        summary = summary[:1199] + "…"
    return SynthesisDraft(
        summary=summary,
        claims=[SynthesisClaimDraft(
            claim_type="record",
            text=f"{prefix}：{detail}"[:800],
            predicate=f"{kernel_name}.{policy.claim_mode}",
            value={"fact_count": len(facts), "subject": subject_key, "claim_mode": policy.claim_mode},
            evidence_fact_ids=[node.id for node in facts],
        )],
    )


async def _model_draft(
    kernel_name: str,
    subject_key: str,
    rows: list[tuple[MemoryNode, MemoryFact, EvidenceEvent]],
) -> tuple[SynthesisDraft, str, dict]:
    if not settings.llm_api_key:
        return _deterministic_draft(kernel_name, subject_key, rows), "deterministic", {}

    from langchain_openai import ChatOpenAI

    candidates = [{
        "fact_id": node.id,
        "text": node.text,
        "predicate": fact.predicate,
        "evidence_grade": fact.evidence_grade,
        "event_type": event.event_type,
        "occurred_at": node.occurred_at.isoformat(),
    } for node, fact, event in rows]
    llm = ChatOpenAI(
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        model=settings.llm_model,
        temperature=0,
        timeout=120,
        max_retries=1,
    )
    structured = llm.with_structured_output(SynthesisDraft, include_raw=True)
    policy = KERNELS[kernel_name]
    prompt = (
        "你是 LearnFlow 五核记忆合成器。只总结给定的同一维度事实，不补充外部知识。"
        "每条 claim 必须引用至少一个候选 fact_id，且不得引用列表外 ID。"
        "claim_type 必填：普通记录为 record；独立成功为 independent_success；稳定掌握为 stable_mastery；变式迁移为 transfer。"
        "知识维度中，exposure_only 或 self_reported 不能被表述成已掌握。"
        "保持可证伪、简洁，保留冲突，不要强行求一致。"
        f"本核的 Module 角色：{policy.module_role} Claim 角色：{policy.claim_role} "
        f"Claim 模式：{policy.claim_mode} 硬边界：{'；'.join(policy.hard_boundaries)}\n"
        f"维度: {kernel_name}\n主题: {subject_key}\n"
        f"候选事实: {json.dumps(candidates, ensure_ascii=False)}"
    )
    result = await structured.ainvoke(prompt)
    parsed = result.get("parsed") if isinstance(result, dict) else result
    if not isinstance(parsed, SynthesisDraft):
        parsed = SynthesisDraft.model_validate(parsed)
    usage = {}
    raw = result.get("raw") if isinstance(result, dict) else None
    if raw is not None:
        usage = dict(getattr(raw, "usage_metadata", None) or {})
    return parsed, settings.llm_model, usage


def _validate_draft(
    run: MemorySynthesisRun,
    draft: SynthesisDraft,
    rows: list[tuple[MemoryNode, MemoryFact, EvidenceEvent]],
) -> list[str]:
    errors: list[str] = []
    allowed = {node.id for node, _, _ in rows}
    facts = {node.id: fact for node, fact, _ in rows}
    events = {node.id: event for node, _, event in rows}
    if not draft.claims:
        errors.append("module_has_no_claims")
    for index, claim in enumerate(draft.claims):
        refs = set(claim.evidence_fact_ids)
        if not refs:
            errors.append(f"claim_{index}_has_no_evidence")
        if not refs.issubset(allowed):
            errors.append(f"claim_{index}_references_outside_whitelist")
        verified_ids = {events[i].id for i in refs if i in facts and facts[i].evidence_grade == "verified"}
        transfer_ids = {events[i].id for i in refs if i in facts and facts[i].evidence_grade == "verified"
                        and events[i].event_type in {"transfer_attempt_evaluated", "remediation_variant_evaluated"}}
        kind = claim.claim_type
        if kind == "independent_success" and not verified_ids:
            errors.append(f"claim_{index}_insufficient_independent_evidence")
        if kind == "stable_mastery" and len(verified_ids) < 2:
            errors.append(f"claim_{index}_insufficient_mastery_evidence")
        if kind == "transfer" and not transfer_ids:
            errors.append(f"claim_{index}_insufficient_transfer_evidence")
        if kind not in {None, "record"} and run.kernel_name not in {"knowledge", "practice"}:
            errors.append(f"claim_{index}_capability_outside_learning_evidence")
        # Legacy drafts are readable but cannot acquire untyped capability authority.
        # Explicit historical boundary records stay compatible.
        if kind is None and run.kernel_name in {"knowledge", "practice"}:
            boundary = any(marker in claim.text for marker in ("未", "没有", "缺乏", "自述", "接触", "记录"))
            if not boundary and not verified_ids:
                errors.append(f"claim_{index}_untyped_capability_evidence")
        mastery_language = _asserts_mastery(claim.text, claim.predicate)
        if run.kernel_name == "knowledge" and mastery_language:
            verified = {fact.source_event_id for fact_id, fact in facts.items()
                        if fact_id in refs and fact.evidence_grade == "verified"}
            if len(verified) < 2:
                errors.append(f"claim_{index}_insufficient_mastery_evidence")
        if run.kernel_name == "structure" and mastery_language:
            errors.append(f"claim_{index}_structure_cannot_assert_mastery")
        if run.kernel_name == "human":
            forbidden = ("人格", "性格", "天生", "固定学习风格", "抑郁", "焦虑症", "智力")
            if any(marker in claim.text for marker in forbidden):
                errors.append(f"claim_{index}_human_overreach")
        if run.kernel_name == "value":
            goal_language = any(marker in claim.text for marker in ("长期目标", "职业目标", "确定方向", "未来将", "立志"))
            confirmed = any(
                events[fact_id].event_type in {"career_goal_confirmed", "vnext_value_claim_proposal_accepted"}
                or (events[fact_id].payload or {}).get("career_goal_status") == "confirmed"
                for fact_id in refs if fact_id in events
            )
            if goal_language and not confirmed:
                errors.append(f"claim_{index}_value_goal_without_consent")
        if run.kernel_name == "practice":
            capability_language = any(marker in claim.text for marker in ("能够独立", "已经会", "熟练", "可迁移", "掌握"))
            verified = refs and all(
                facts[fact_id].evidence_grade == "verified"
                for fact_id in refs if fact_id in facts
            )
            if capability_language and not verified:
                errors.append(f"claim_{index}_practice_capability_without_verified_evidence")
    return errors


async def recover_interrupted_runs() -> int:
    async with async_session() as db:
        runs = (await db.execute(select(MemorySynthesisRun).where(
            MemorySynthesisRun.status == "running",
        ))).scalars().all()
        for run in runs:
            facts = (await db.execute(select(MemoryFact).where(
                MemoryFact.reservation_run_id == run.id,
            ))).scalars().all()
            for fact in facts:
                fact.consumption_status = "eligible"
                fact.reservation_run_id = None
            run.status = "queued"
            run.started_at = None
            run.due_at = datetime.utcnow()
        await db.commit()
        return len(runs)


async def reconcile_eligible_synthesis_runs() -> int:
    """Rebuild missing queues for historical eligible Fact groups.

    Facts are the source projection, so this scan is safe to repeat on every
    worker start. ``maybe_queue_synthesis`` re-applies the deterministic
    per-kernel threshold and fingerprint rules; no Module or Claim is created
    here directly.
    """
    async with async_session() as db:
        groups = list((await db.execute(
            select(
                MemoryNode.learner_id,
                MemoryNode.kernel_name,
                MemoryNode.subject_key,
            )
            .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
            .where(
                MemoryNode.node_type == "fact",
                MemoryFact.consumption_status == "eligible",
            )
            .distinct()
            .order_by(
                MemoryNode.learner_id.asc(),
                MemoryNode.kernel_name.asc(),
                MemoryNode.subject_key.asc(),
            )
        )).all())
        actionable: set[int] = set()
        for learner_id, kernel_name, subject_key in groups:
            trigger_event = (await db.execute(
                select(EvidenceEvent)
                .join(MemoryFact, MemoryFact.source_event_id == EvidenceEvent.id)
                .join(MemoryNode, MemoryNode.id == MemoryFact.node_id)
                .where(
                    MemoryNode.learner_id == learner_id,
                    MemoryNode.kernel_name == kernel_name,
                    MemoryNode.subject_key == subject_key,
                    MemoryFact.consumption_status == "eligible",
                )
                .order_by(EvidenceEvent.occurred_at.desc(), EvidenceEvent.id.desc())
                .limit(1)
            )).scalar_one_or_none()
            if trigger_event is None:
                continue
            run = await maybe_queue_synthesis(
                db,
                int(learner_id),
                str(kernel_name),
                str(subject_key),
                trigger_event=trigger_event,
            )
            if run is not None and run.status == "queued":
                actionable.add(int(run.id))
        await db.commit()
        return len(actionable)


async def _release_run(db: AsyncSession, run: MemorySynthesisRun, error: str) -> None:
    facts = (await db.execute(select(MemoryFact).where(
        MemoryFact.reservation_run_id == run.id,
    ))).scalars().all()
    for fact in facts:
        fact.consumption_status = "eligible"
        fact.reservation_run_id = None
    run.status = "queued" if (run.attempt_count or 0) < MAX_SYNTHESIS_ATTEMPTS else "failed"
    if run.status == "queued":
        run.due_at = datetime.utcnow() + timedelta(seconds=2 ** (run.attempt_count or 0))
    run.validation_errors = list(run.validation_errors or []) + [error]
    run.finished_at = datetime.utcnow()
    await db.commit()


async def process_synthesis_run(run_id: int) -> MemorySynthesisRun | None:
    """Reserve, synthesize and atomically commit one queued run."""
    async with async_session() as db:
        run = await db.get(MemorySynthesisRun, run_id)
        if not run or run.status != "queued" or run.due_at > datetime.utcnow():
            return run
        candidate_ids = [int(item) for item in (run.candidate_fact_ids or [])]
        delta_rows = (await db.execute(
            select(MemoryNode, MemoryFact, EvidenceEvent)
            .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
            .join(EvidenceEvent, EvidenceEvent.id == MemoryFact.source_event_id)
            .where(
                MemoryNode.status.in_(["active", "legacy"]),
                MemoryNode.id.in_(candidate_ids),
                MemoryNode.learner_id == run.learner_id,
                MemoryNode.kernel_name == run.kernel_name,
                MemoryNode.subject_key == run.subject_key,
                MemoryFact.consumption_status == "eligible",
            )
            .order_by(MemoryNode.occurred_at.asc(), MemoryNode.id.asc())
        )).all()
        if len(delta_rows) != len(candidate_ids):
            run.status = "stale"
            run.validation_errors = ["candidate_fact_unavailable"]
            run.finished_at = datetime.utcnow()
            await db.commit()
            return run
        current = await current_memory_module(
            db, run.learner_id, run.kernel_name, run.subject_key, include_inactive=True,
        )
        base_node, base_module = current if current else (None, None)
        base_fact_ids = await module_evidence_fact_ids(db, base_module) if base_module else []
        evidence_ids = await effective_evidence_ids(db, run.learner_id, run.kernel_name, run.subject_key, candidate_ids)
        fingerprint = input_fingerprint(run.kernel_name, run.subject_key, evidence_ids)
        duplicate = (await db.execute(select(MemorySynthesisRun.id).where(
            MemorySynthesisRun.learner_id == run.learner_id,
            MemorySynthesisRun.input_fingerprint == fingerprint,
            MemorySynthesisRun.id != run.id,
        ))).scalar_one_or_none()
        if duplicate:
            run.status = "stale"
            run.validation_errors = ["version_input_already_synthesized"]
            run.finished_at = datetime.utcnow()
            await db.commit()
            return run
        run.base_module_node_id = base_node.id if base_node else None
        run.target_module_version = int(base_module.version or 1) + 1 if base_module else 1
        run.evidence_fact_ids = evidence_ids
        run.input_fingerprint = fingerprint
        run.prompt_version = "memory-synthesis-v2"
        rows = (await db.execute(
            select(MemoryNode, MemoryFact, EvidenceEvent)
            .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
            .join(EvidenceEvent, EvidenceEvent.id == MemoryFact.source_event_id)
            .where(
                MemoryNode.status.in_(["active", "legacy"]),
                MemoryNode.id.in_(evidence_ids),
                MemoryNode.learner_id == run.learner_id,
                MemoryNode.kernel_name == run.kernel_name,
                MemoryNode.subject_key == run.subject_key,
                MemoryFact.consumption_status.in_(["eligible", "consumed"]),
            )
            .order_by(MemoryNode.occurred_at.asc(), MemoryNode.id.asc())
        )).all()
        if len(rows) != len(evidence_ids):
            run.status = "stale"
            run.validation_errors = ["version_evidence_unavailable"]
            run.finished_at = datetime.utcnow()
            await db.commit()
            return run
        for _, fact, _ in delta_rows:
            fact.consumption_status = "reserved"
            fact.reservation_run_id = run.id
        run.status = "running"
        run.started_at = datetime.utcnow()
        run.attempt_count = (run.attempt_count or 0) + 1
        await db.commit()

    try:
        draft, model_name, usage = await _model_draft(run.kernel_name, run.subject_key, rows)
    except Exception as exc:
        # Consolidation must remain available offline and during provider
        # outages. The deterministic draft uses the exact same evidence
        # whitelist and still passes the validator below.
        draft = _deterministic_draft(run.kernel_name, run.subject_key, rows)
        model_name = "deterministic-fallback"
        usage = {"fallback_reason": type(exc).__name__}

    async with async_session() as db:
        run = await db.get(MemorySynthesisRun, run_id)
        if not run or run.status != "running":
            return run
        evidence_ids = [int(item) for item in (run.evidence_fact_ids or [])]
        rows = (await db.execute(
            select(MemoryNode, MemoryFact, EvidenceEvent)
            .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
            .join(EvidenceEvent, EvidenceEvent.id == MemoryFact.source_event_id)
            .where(
                MemoryNode.status.in_(["active", "legacy"]),
                MemoryNode.id.in_(evidence_ids),
                MemoryNode.learner_id == run.learner_id,
                MemoryNode.kernel_name == run.kernel_name,
                MemoryNode.subject_key == run.subject_key,
                MemoryFact.consumption_status.in_(["reserved", "consumed"]),
            )
            .order_by(MemoryNode.occurred_at.asc(), MemoryNode.id.asc())
        )).all()
        if len(rows) != len(evidence_ids):
            await _release_run(db, run, "version_evidence_changed")
            return run
        errors = _validate_draft(run, draft, rows)
        if errors:
            run.raw_output = draft.model_dump(mode="json")
            run.validation_errors = errors
            await _release_run(db, run, "validation_rejected")
            return run

        if run.kernel_name in {"knowledge", "practice"}:
            safe_claims = []
            lookup = {node.id: (node, fact, event) for node, fact, event in rows}
            for claim in draft.claims:
                if claim.claim_type in {None, "record"}:
                    safe_claims.extend(_deterministic_draft(
                        run.kernel_name, run.subject_key,
                        [lookup[i] for i in dict.fromkeys(claim.evidence_fact_ids)],
                    ).claims)
                else:
                    label = {
                        "independent_success": "该主题已有独立成功记录，尚不代表稳定掌握或迁移",
                        "stable_mastery": "该主题已有至少两次独立验证记录，迁移能力须另有变式证据",
                        "transfer": "该主题已有独立变式迁移记录，结论限已验证情境",
                    }[claim.claim_type]
                    safe_claims.append(claim.model_copy(update={
                        "text": label,
                        "predicate": f"{run.kernel_name}.{claim.claim_type}",
                        "value": {"claim_type": claim.claim_type, "subject": run.subject_key},
                    }))
            draft = SynthesisDraft(summary="；".join(c.text for c in safe_claims)[:1200], claims=safe_claims)
        fact_nodes = [node for node, _, _ in rows]
        time_start = min(node.occurred_at for node in fact_nodes)
        time_end = max(node.occurred_at for node in fact_nodes)
        confidence = round(sum(node.confidence or 0 for node in fact_nodes) / len(fact_nodes), 3)
        project_ids = {fact.project_id for _, fact, _ in rows if fact.project_id is not None}
        checkpoint_ids = {fact.checkpoint_id for _, fact, _ in rows if fact.checkpoint_id is not None}
        session_ids = {fact.session_id for _, fact, _ in rows if fact.session_id is not None}
        subject_type, subject_id = subject_parts(run.subject_key)
        project_id = next(iter(project_ids)) if len(project_ids) == 1 else None
        checkpoint_id = next(iter(checkpoint_ids)) if len(checkpoint_ids) == 1 else None
        session_id = next(iter(session_ids)) if len(session_ids) == 1 else None
        relation = "SUPERSEDES" if run.trigger_reason == "correction" else "REFINES"
        previous_modules = (await db.execute(
            select(MemoryNode)
            .join(MemoryModule, MemoryModule.node_id == MemoryNode.id)
            .where(
                MemoryNode.learner_id == run.learner_id,
                MemoryNode.kernel_name == run.kernel_name,
                MemoryNode.subject_key == run.subject_key,
                MemoryNode.id == run.base_module_node_id,
            )
        )).scalars().all()
        for previous in previous_modules:
            if previous.status != "retracted":
                previous.status = "superseded" if relation == "SUPERSEDES" else "refined"
            old_claims = (await db.execute(
                select(MemoryNode)
                .join(MemoryClaim, MemoryClaim.node_id == MemoryNode.id)
                .where(MemoryClaim.module_node_id == previous.id)
            )).scalars().all()
            for old_claim in old_claims:
                old_claim.status = previous.status
        await db.flush()
        module_node = MemoryNode(
            learner_id=run.learner_id,
            node_type="module",
            kernel_name=run.kernel_name,
            memory_kind="topic_summary",
            subject_key=run.subject_key,
            subject_type=subject_type,
            subject_id=subject_id,
            project_id=project_id,
            checkpoint_id=checkpoint_id,
            session_id=session_id,
            text=draft.summary,
            payload={
                "trigger_reason": run.trigger_reason,
                "project_id": project_id,
                "checkpoint_id": checkpoint_id,
                "session_id": session_id,
                "module_version": run.target_module_version,
                "parent_module_node_id": run.base_module_node_id,
                "evidence_fact_ids": evidence_ids,
                "delta_fact_ids": [int(item) for item in (run.candidate_fact_ids or [])],
                "policy_version": MODULE_VERSION_POLICY,
            },
            confidence=confidence,
            salience=memory_salience(
                memory_kind="topic_summary", evidence_grade="observed",
                scope="long_term", confidence=confidence,
            ),
            schema_version=MEMORY_SCHEMA_VERSION,
            status="active",
            valid_from=time_start,
            occurred_at=time_end,
        )
        db.add(module_node)
        await db.flush()
        module_type = (
            "correction" if run.trigger_reason == "correction"
            else "confirmation" if run.trigger_reason == "confirmation"
            else KERNELS[run.kernel_name].claim_mode
        )
        revision_kind = (
            "correction" if run.trigger_reason == "correction"
            else "confirmation" if run.trigger_reason == "confirmation"
            else "initial" if run.base_module_node_id is None
            else "refinement"
        )
        db.add(MemoryModule(
            node_id=module_node.id,
            synthesis_run_id=run.id,
            module_type=module_type,
            summary=draft.summary,
            time_start=time_start,
            time_end=time_end,
            input_fingerprint=run.input_fingerprint,
            immutable=True,
            version=run.target_module_version,
            parent_module_node_id=run.base_module_node_id,
            revision_kind=revision_kind,
            evidence_fact_ids=evidence_ids,
            delta_fact_ids=[int(item) for item in (run.candidate_fact_ids or [])],
            policy_version=f"{MODULE_VERSION_POLICY}@{REGISTRY_VERSION}",
        ))
        await db.flush()

        allowed_rows = {node.id: (node, fact, event) for node, fact, event in rows}
        for ordinal, claim in enumerate(draft.claims):
            claim_rows = [allowed_rows[item] for item in claim.evidence_fact_ids]
            claim_confidence = min(item[0].confidence or 0 for item in claim_rows)
            verified = all(item[1].evidence_grade == "verified" for item in claim_rows)
            self_reported = all(item[1].evidence_grade == "self_reported" for item in claim_rows)
            learner_supported = all(
                item[1].evidence_grade in {"self_reported", "corrected"}
                for item in claim_rows
            )
            verification_status = (
                "verified" if verified
                else "self_reported" if self_reported or (
                    run.kernel_name == "knowledge"
                    and run.trigger_reason == "knowledge_self_report"
                )
                else "self_reported" if run.kernel_name in {"human", "value"} and learner_supported
                else "boundary_recorded" if run.kernel_name == "structure"
                else "supported"
            )
            claim_node = MemoryNode(
                learner_id=run.learner_id,
                node_type="claim",
                kernel_name=run.kernel_name,
                memory_kind="semantic_claim",
                subject_key=run.subject_key,
                subject_type=subject_type,
                subject_id=subject_id,
                project_id=project_id,
                checkpoint_id=checkpoint_id,
                session_id=session_id,
                text=claim.text,
                payload={
                    "project_id": project_id,
                    "checkpoint_id": checkpoint_id,
                    "session_id": session_id,
                    "evidence_fact_ids": claim.evidence_fact_ids,
                    "module_version": run.target_module_version,
                    "claim_type": claim.claim_type or "record",
                },
                confidence=claim_confidence,
                salience=memory_salience(
                    memory_kind="semantic_claim",
                    evidence_grade="verified" if verified else "observed",
                    scope="long_term", confidence=claim_confidence,
                ),
                schema_version=MEMORY_SCHEMA_VERSION,
                status="active",
                valid_from=time_start,
                occurred_at=time_end,
            )
            db.add(claim_node)
            await db.flush()
            db.add(MemoryClaim(
                node_id=claim_node.id,
                module_node_id=module_node.id,
                claim_ordinal=ordinal,
                predicate=claim.predicate,
                value=claim.value,
                verification_status=verification_status,
            ))
            await db.flush()
            for fact_id in claim.evidence_fact_ids:
                await _add_edge(
                    db, learner_id=run.learner_id, source_node_id=fact_id,
                    target_node_id=claim_node.id, relation_type="SUPPORTS",
                    origin="synthesis", confidence=claim_confidence,
                )

        delta_ids = {int(item) for item in (run.candidate_fact_ids or [])}
        for node, fact, _ in rows:
            await _add_edge(
                db, learner_id=run.learner_id, source_node_id=node.id,
                target_node_id=module_node.id, relation_type="CONSOLIDATED_INTO",
                origin="synthesis", confidence=node.confidence or 0,
            )
            if node.id in delta_ids:
                fact.consumption_status = "consumed"
                fact.consumed_by_module_id = module_node.id
                fact.reservation_run_id = None

        for previous in previous_modules:
            await _add_edge(
                db, learner_id=run.learner_id, source_node_id=module_node.id,
                target_node_id=previous.id, relation_type=relation,
                origin="post_synthesis", confidence=confidence,
            )

        run.status = "completed"
        run.model_name = model_name
        run.raw_output = draft.model_dump(mode="json")
        run.validation_errors = []
        run.usage = usage
        run.finished_at = datetime.utcnow()
        await normalize_self_reported_claim_statuses(
            db,
            learner_id=run.learner_id,
            module_node_id=module_node.id,
        )
        await rebuild_kernel_long_term_from_modules(db, run.learner_id)
        await refresh_kernel_head(db, run.learner_id, run.kernel_name)
        await db.commit()
        return run


async def process_due_runs(limit: int = 4) -> int:
    async with async_session() as db:
        run_ids = list((await db.execute(select(MemorySynthesisRun.id).where(
            MemorySynthesisRun.status == "queued",
            MemorySynthesisRun.due_at <= datetime.utcnow(),
        ).order_by(MemorySynthesisRun.due_at.asc(), MemorySynthesisRun.id.asc()).limit(limit))).scalars().all())
    for run_id in run_ids:
        await process_synthesis_run(run_id)
    return len(run_ids)


async def memory_worker_loop(stop_event: asyncio.Event) -> None:
    await recover_interrupted_runs()
    async with async_session() as db:
        await normalize_self_reported_claim_statuses(db)
        await db.commit()
    if not settings.memory_auto_synthesis_enabled:
        await stop_event.wait()
        return
    await reconcile_eligible_synthesis_runs()
    while not stop_event.is_set():
        try:
            processed = await process_due_runs()
            timeout = 0.25 if processed else 1.0
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[memory-worker] {type(exc).__name__}: {exc}")
            timeout = 2.0
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
