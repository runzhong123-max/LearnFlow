"""Regression traces for current-state memory and bounded consolidation."""
import asyncio
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select

from app.db.database import async_session, init_db
from app.models.learning import EvidenceEvent, KernelMutation, Learner, MemoryClaim, MemoryFact, MemoryNode, MemorySynthesisRun
from app.services.learning_runtime import get_kernel_projection, record_event
from app.services.memory_graph import create_facts_for_mutation, maybe_queue_synthesis, effective_evidence_ids
from app.services.memory_worker import SynthesisDraft, SynthesisClaimDraft, _validate_draft, process_synthesis_run


def test_old_exposure_does_not_block_new_verified_events():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Queue trace")
            db.add(learner)
            await db.flush()
            newest = []
            for i in range(14):
                event = EvidenceEvent(learner_id=learner.id, event_type="exercise_attempt_evaluated" if i >= 12 else "lecture_viewed", source="tool", payload={"passed": True, "memory_subject_key": "concept:test"}, confidence=1, occurred_at=datetime.utcnow() + timedelta(seconds=i))
                db.add(event)
                await db.flush()
                mutation = KernelMutation(event_id=event.id, learner_id=learner.id, kernel_name="knowledge", patch={"short_term": {"concept_understanding": str(i)}}, reason="test")
                db.add(mutation)
                await db.flush()
                nodes = await create_facts_for_mutation(db, event, mutation, queue_synthesis=False)
                if i >= 12:
                    newest.extend(n.id for n in nodes)
            run = await maybe_queue_synthesis(db, learner.id, "knowledge", "concept:test", trigger_event=event)
            assert run and set(newest).issubset(run.candidate_fact_ids)
    asyncio.run(scenario())


def test_typed_capability_requires_the_matching_evidence():
    rows = [(MemoryNode(id=1), MemoryFact(node_id=1, source_event_id=9, evidence_grade="self_reported"), EvidenceEvent(id=9, event_type="profile_updated"))]
    for kind, expected in [("independent_success", "independent"), ("stable_mastery", "mastery"), ("transfer", "transfer")]:
        draft = SynthesisDraft(summary="能力", claims=[SynthesisClaimDraft(claim_type=kind, text="已能独立推导反向传播并迁移到新模型", predicate="knowledge.ability", evidence_fact_ids=[1])])
        assert any(expected in e for e in _validate_draft(MemorySynthesisRun(kernel_name="knowledge"), draft, rows))
    legacy = SynthesisDraft(summary="能力", claims=[SynthesisClaimDraft(text="已能独立推导反向传播并迁移到新模型", predicate="knowledge.ability", evidence_fact_ids=[1])])
    assert "claim_0_untyped_capability_evidence" in _validate_draft(MemorySynthesisRun(kernel_name="knowledge"), legacy, rows)


def test_preference_replacement_and_retraction_are_effective_offline():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Correction trace")
            db.add(learner)
            await db.flush()
            await record_event(db, learner_id=learner.id, event_type="profile_updated", source="profile", payload={"preferred_modes": ["先看理论"]}, provenance={"self_report": True})
            run = (await db.execute(select(MemorySynthesisRun).where(MemorySynthesisRun.learner_id == learner.id))).scalars().first()
            run_id, learner_id = run.id, learner.id
            await db.commit()
        assert (await process_synthesis_run(run_id)).status == "completed"
        async with async_session() as db:
            claim = (await db.execute(select(MemoryNode).where(MemoryNode.learner_id == learner_id, MemoryNode.node_type == "claim", MemoryNode.status == "active"))).scalars().first()
            fact_ids = claim.payload["evidence_fact_ids"]
            await record_event(db, learner_id=learner_id, event_type="memory_correction_retracted", source="user", payload={"kernel_name": "human", "memory_subject_key": claim.subject_key, "claim_id": claim.id, "action": "retract", "affected_fact_ids": fact_ids, "affected_keys": ["learning_preferences"]})
            assert claim.status == "retracted"
            run = (await db.execute(select(MemorySynthesisRun).where(MemorySynthesisRun.learner_id == learner_id, MemorySynthesisRun.status == "queued"))).scalars().first()
            run_id = run.id
            assert not set(fact_ids).intersection(await effective_evidence_ids(db, learner_id, "human", claim.subject_key, []))
            await db.commit()
        assert (await process_synthesis_run(run_id)).status == "completed"
        async with async_session() as db:
            active = (await db.execute(select(MemoryNode).where(MemoryNode.learner_id == learner_id, MemoryNode.node_type == "claim", MemoryNode.status == "active"))).scalars().all()
            assert active and all("先看理论" not in node.text for node in active)
    asyncio.run(scenario())


def test_failed_fingerprint_retries_are_bounded(monkeypatch):
    async def invalid_draft(*args):
        return SynthesisDraft(summary="invalid", claims=[SynthesisClaimDraft(claim_type="record", text="invalid", predicate="human.record", evidence_fact_ids=[999999])]), "test", {}
    monkeypatch.setattr("app.services.memory_worker._model_draft", invalid_draft)

    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Retry trace")
            db.add(learner)
            await db.flush()
            event = await record_event(db, learner_id=learner.id, event_type="profile_updated", source="profile", payload={"preferred_modes": ["examples"]})
            run = (await db.execute(select(MemorySynthesisRun).where(MemorySynthesisRun.learner_id == learner.id))).scalars().first()
            run_id = run.id
            await db.commit()
        for attempt in range(1, 4):
            async with async_session() as db:
                run = await db.get(MemorySynthesisRun, run_id)
                run.due_at = datetime.utcnow()
                await db.commit()
            result = await process_synthesis_run(run_id)
            assert result.attempt_count == attempt
            assert result.status == ("queued" if attempt < 3 else "failed")
        async with async_session() as db:
            run = await db.get(MemorySynthesisRun, run_id)
            event = await db.get(EvidenceEvent, event.id)
            again = await maybe_queue_synthesis(db, learner.id, "human", run.subject_key, trigger_event=event)
            assert again.id == run_id and again.status == "failed"
    asyncio.run(scenario())


def test_semantic_candidates_never_become_cross_session_claims():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Candidate trace")
            db.add(learner)
            await db.flush()
            for kernel in ("human", "value"):
                for i in range(3):
                    await record_event(db, learner_id=learner.id,
                        event_type="semantic_observation_proposed", source="semantic_observation",
                        payload={"kernel": kernel, "candidate": {"support_need": "先举例"}},
                        confidence=0.5, provenance={"semantic_observation": True})
            rows = (await db.execute(select(MemoryNode, MemoryFact).join(
                MemoryFact, MemoryFact.node_id == MemoryNode.id,
            ).where(MemoryNode.learner_id == learner.id))).all()
            assert len(rows) == 6
            assert all(n.status == "transient" and n.valid_to and f.consumption_status == "excluded"
                       and f.evidence_grade == "inferred" for n, f in rows)
            runs = (await db.execute(select(MemorySynthesisRun).where(
                MemorySynthesisRun.learner_id == learner.id))).scalars().all()
            assert not runs
    asyncio.run(scenario())


def test_historical_claim_feedback_cannot_erase_newer_preference():
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.api.memory import ClaimFeedbackRequest, submit_claim_feedback

    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Historical feedback")
            db.add(learner)
            await db.flush()
            learner_id = learner.id
            await record_event(db, learner_id=learner_id, event_type="profile_updated", source="profile", payload={"preferred_modes": ["theory"]})
            run = (await db.execute(select(MemorySynthesisRun).where(MemorySynthesisRun.learner_id == learner_id))).scalars().first()
            run_id = run.id
            await db.commit()
        await process_synthesis_run(run_id)
        async with async_session() as db:
            old_claim = (await db.execute(select(MemoryNode).where(MemoryNode.learner_id == learner_id, MemoryNode.node_type == "claim", MemoryNode.status == "active"))).scalars().first()
            await record_event(db, learner_id=learner_id, event_type="profile_updated", source="profile", payload={"preferred_modes": ["practice"]})
            try:
                await submit_claim_feedback(old_claim.id, ClaimFeedbackRequest(action="retract"), current=SimpleNamespace(learner=SimpleNamespace(id=learner_id)), db=db)
            except HTTPException as exc:
                assert exc.status_code == 409
            else:
                raise AssertionError("Historical feedback was applied to newer current state")
    asyncio.run(scenario())


def test_partial_profile_update_preserves_preference_fact_provenance():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Partial provenance")
            db.add(learner)
            await db.flush()
            first = await record_event(db, learner_id=learner.id, event_type="profile_updated", source="profile", payload={"preferred_modes": ["examples"], "weekly_hours": 5})
            await record_event(db, learner_id=learner.id, event_type="profile_updated", source="profile", payload={"weekly_hours": 10})
            rows = (await db.execute(select(MemoryNode, MemoryFact).join(MemoryFact, MemoryFact.node_id == MemoryNode.id).where(
                MemoryNode.learner_id == learner.id, MemoryNode.kernel_name == "human",
                MemoryNode.status == "active",
            ))).all()
            modes = [(n, f) for n, f in rows if n.payload.get("key") == "preferred_modes"]
            assert len(modes) == 1 and modes[0][1].source_event_id == first.id
            assert all(n.payload.get("key") != "learning_preferences" for n, _ in rows)
    asyncio.run(scenario())


def test_unscoped_projection_omits_semantic_candidates():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Unscoped candidates")
            db.add(learner)
            await db.flush()
            await record_event(db, learner_id=learner.id,
                event_type="semantic_observation_proposed", source="semantic_observation",
                payload={"kernel": "knowledge", "candidate": {"knowledge_gap": "尚未核对的模型判断"}},
                confidence=0.5, provenance={"semantic_observation": True})
            projection = await get_kernel_projection(db, learner.id)
            assert "semantic_candidate" not in projection["knowledge"]["short_term"]
            assert "尚未核对的模型判断" not in str(projection)
    asyncio.run(scenario())


def test_background_snapshot_replacement_preserves_verified_evidence():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Background snapshot")
            db.add(learner)
            await db.flush()
            first = await record_event(db, learner_id=learner.id, event_type="profile_updated", source="profile", payload={"background": "旧背景"})
            verified_event = EvidenceEvent(learner_id=learner.id, event_type="exercise_attempt_evaluated", source="tool", payload={"passed": True, "memory_subject_key": "global"}, confidence=1, occurred_at=datetime.utcnow())
            db.add(verified_event)
            await db.flush()
            mutation = KernelMutation(event_id=verified_event.id, learner_id=learner.id, kernel_name="knowledge", patch={"short_term": {"concept_understanding": "独立完成的验证"}}, reason="verified test")
            db.add(mutation)
            await db.flush()
            verified_nodes = await create_facts_for_mutation(db, verified_event, mutation, queue_synthesis=False)
            second = await record_event(db, learner_id=learner.id, event_type="profile_updated", source="profile", payload={"background": "更正背景"})
            rows = (await db.execute(select(MemoryNode, MemoryFact).join(MemoryFact, MemoryFact.node_id == MemoryNode.id).where(MemoryNode.learner_id == learner.id))).all()
            backgrounds = [(n, f) for n, f in rows if n.payload.get("key") == "declared_background"]
            assert len(backgrounds) == 2
            assert next(n for n, f in backgrounds if f.source_event_id == first.id).status == "superseded"
            assert next(n for n, f in backgrounds if f.source_event_id == second.id).status == "active"
            verified_node, verified_fact = next((n, f) for n, f in rows if n.id == verified_nodes[0].id)
            assert verified_node.status == "active" and verified_fact.evidence_grade == "verified"
    asyncio.run(scenario())


def test_compatibility_projection_respects_aggregate_and_individual_archives():
    from app.models.learning import MemoryArchive

    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Archive projections")
            db.add(learner)
            await db.flush()
            learner_id = learner.id
            await record_event(db, learner_id=learner_id, event_type="profile_updated", source="profile", payload={"preferred_modes": ["unique-example-preference"], "weekly_hours": 7})
            run = (await db.execute(select(MemorySynthesisRun).where(MemorySynthesisRun.learner_id == learner_id))).scalars().first()
            run_id = run.id
            await db.commit()
        await process_synthesis_run(run_id)
        async with async_session() as db:
            # Include an eligible recent fact as well as an already consolidated claim.
            await record_event(db, learner_id=learner_id, event_type="profile_updated", source="profile", payload={"weekly_hours": 9})
            single = MemoryArchive(learner_id=learner_id, kernel_name="human", memory_scope="short_term", memory_key="preferred_modes", status="archived")
            db.add(single)
            await db.flush()
            projection = await get_kernel_projection(db, learner_id)
            human = projection["human"]
            assert "preferred_modes" not in human["short_term"]
            assert "preferred_modes" not in human["long_term"].get("learning_preferences", {})
            assert "unique-example-preference" not in str(human)
            single.status = "restored"
            db.add(MemoryArchive(learner_id=learner_id, kernel_name="human", memory_scope="long_term", memory_key="learning_preferences", status="archived"))
            await db.flush()
            projection = await get_kernel_projection(db, learner_id)
            human = projection["human"]
            assert "preferred_modes" not in human["short_term"]
            assert "weekly_hours" not in human["short_term"]
            assert "learning_preferences" not in human["long_term"]
            assert not human["short_term"].get("memory_graph_recent_facts")
            assert not human["long_term"].get("memory_graph_claims")
    asyncio.run(scenario())


def test_single_preference_archive_hides_legacy_aggregate_descendants():
    from app.models.learning import MemoryArchive, MemoryEdge
    from app.services.five_kernel_context import _archived_projection_ids

    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name="Legacy archive")
            db.add(learner)
            await db.flush()
            aggregate = MemoryNode(learner_id=learner.id, kernel_name="human", node_type="fact", subject_key="preference:learning", text="旧聚合偏好", payload={"key": "learning_preferences", "scope": "long_term"})
            claim = MemoryNode(learner_id=learner.id, kernel_name="human", node_type="claim", subject_key="preference:learning", text="旧偏好摘要")
            db.add_all([aggregate, claim])
            await db.flush()
            db.add(MemoryEdge(learner_id=learner.id, source_node_id=aggregate.id, target_node_id=claim.id, relation_type="SUPPORTS"))
            archive = MemoryArchive(learner_id=learner.id, kernel_name="human", memory_scope="short_term", memory_key="preferred_modes", status="archived")
            db.add(archive)
            await db.flush()
            excluded = await _archived_projection_ids(db, learner.id, [archive])
            assert {aggregate.id, claim.id}.issubset(excluded)
    asyncio.run(scenario())
