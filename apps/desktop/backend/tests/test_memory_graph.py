import asyncio
import uuid
from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db.database import async_session, init_db
from app.main import app
from app.models.learning import (
    EvidenceEvent,
    Learner,
    MemoryClaim,
    MemoryEdge,
    MemoryFact,
    MemoryModule,
    MemoryNode,
    MemorySynthesisRun,
)
from app.models.project import Checkpoint, Project, Roadmap
from app.services.learning_runtime import get_kernel_projection, record_event
from app.services.memory_graph import (
    backfill_memory_graph,
    backfill_module_versions,
    input_fingerprint,
    next_learner_sequence,
)
from app.services.memory_worker import (
    SynthesisClaimDraft,
    SynthesisDraft,
    _validate_draft,
    process_synthesis_run,
    reconcile_eligible_synthesis_runs,
)


def _key(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def test_event_dual_write_creates_cross_kernel_facts_and_sparse_edges():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("memory-ledger"), display_name="Memory Ledger")
            db.add(learner)
            await db.flush()
            event = await record_event(
                db,
                learner_id=learner.id,
                event_type="registration_profile_completed",
                source="registration",
                payload={
                    "background": "Python",
                    "weekly_hours": 6,
                    "preferred_modes": ["practice"],
                    "career_goal": "机器学习工程师",
                    "career_goal_status": "confirmed",
                },
                provenance={"self_report": True},
            )
            await db.commit()
            fact_nodes = list((await db.execute(
                select(MemoryNode)
                .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
                .where(MemoryNode.learner_id == learner.id)
            )).scalars().all())
            same_event = list((await db.execute(select(MemoryEdge).where(
                MemoryEdge.learner_id == learner.id,
                MemoryEdge.relation_type == "SAME_EVENT",
            ))).scalars().all())
            await backfill_memory_graph(db)
            after_first = await db.scalar(select(func.count(MemoryNode.id)).where(
                MemoryNode.learner_id == learner.id,
            ))
            await backfill_memory_graph(db)
            await db.commit()
            after_second = await db.scalar(select(func.count(MemoryNode.id)).where(
                MemoryNode.learner_id == learner.id,
            ))
            return event, fact_nodes, same_event, after_first, after_second

    event, fact_nodes, same_event, after_first, after_second = asyncio.run(scenario())
    assert event.learner_seq == 1
    assert event.actor_type == "learner"
    assert event.occurred_at and event.created_at
    assert {node.kernel_name for node in fact_nodes} >= {"knowledge", "human", "value"}
    assert any(
        next(node for node in fact_nodes if node.id == edge.source_node_id).kernel_name
        != next(node for node in fact_nodes if node.id == edge.target_node_id).kernel_name
        for edge in same_event
    )
    assert after_first == after_second


def test_learner_event_sequence_allocation_is_atomic_across_sessions():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("sequence-race"), display_name="Sequence Race")
            db.add(learner)
            await db.flush()
            learner_id = learner.id
            await db.commit()

        async def allocate():
            async with async_session() as db:
                sequence = await next_learner_sequence(db, learner_id)
                await db.commit()
                return sequence

        return await asyncio.gather(*(allocate() for _ in range(6)))

    allocated = asyncio.run(scenario())
    assert sorted(allocated) == [1, 2, 3, 4, 5, 6]


def test_project_acceptance_and_completion_have_registered_kernel_reducers():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("project-contract"), display_name="Project Contract")
            db.add(learner)
            await db.flush()
            project = Project(learner_id=learner.id, name="可靠智能体")
            db.add(project)
            await db.flush()

            await record_event(
                db,
                learner_id=learner.id,
                project_id=project.id,
                event_type="project_proposal_accepted",
                source="user",
                payload={
                    "proposal_id": 17,
                    "project_id": project.id,
                    "learning_goal": "完成一个可验证的可靠智能体",
                },
                provenance={"explicit_click": True},
                client_event_id=_key("proposal-accepted"),
            )
            accepted_projection = await get_kernel_projection(db, learner.id)
            accepted_structure = accepted_projection["structure"]
            accepted_value = accepted_projection["value"]

            await record_event(
                db,
                learner_id=learner.id,
                project_id=project.id,
                event_type="project_completed",
                source="runtime",
                payload={
                    "project_id": project.id,
                    "name": project.name,
                    "checkpoint_count": 4,
                },
                provenance={"rule": "all_non_archived_checkpoints_completed"},
                client_event_id=_key("project-completed"),
            )
            completed_projection = await get_kernel_projection(db, learner.id)
            completed_structure = completed_projection["structure"]
            completed_value = completed_projection["value"]
            completed_practice = completed_projection["practice"]
            return (
                project.id,
                accepted_structure,
                accepted_value,
                completed_structure,
                completed_value,
                completed_practice,
            )

    (
        project_id,
        accepted_structure,
        accepted_value,
        completed_structure,
        completed_value,
        completed_practice,
    ) = asyncio.run(scenario())
    assert accepted_structure["short_term"]["proposal_status"] == "accepted"
    assert accepted_structure["short_term"]["active_project_id"] == project_id
    assert accepted_value["short_term"]["goal_status"] == "accepted"
    assert accepted_value["short_term"]["confirmed_goal"].startswith("完成一个")
    assert completed_structure["short_term"]["project_status"] == "completed"
    assert completed_structure["long_term"]["project_graph"][str(project_id)]["status"] == "completed"
    assert completed_value["short_term"]["goal_status"] == "completed"
    assert completed_practice["short_term"]["last_project_checkpoint_count"] == 4
    assert completed_practice["long_term"]["completed_projects"][str(project_id)]["checkpoint_count"] == 4


def test_explicit_concept_self_reports_form_exposure_only_knowledge_claim():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(
                key=_key("knowledge-self-report"),
                display_name="Knowledge Self Report",
            )
            db.add(learner)
            await db.flush()
            for index, statement in enumerate((
                "学习者自述接触过决策树的基本思想",
                "学习者自述接触过支持向量机的基本思想",
            )):
                await record_event(
                    db,
                    learner_id=learner.id,
                    event_type="learner_concept_observation_recorded",
                    source="user",
                    payload={
                        "concept_key": "machine-learning",
                        "concept_name": "机器学习",
                        "observation_type": "example_seen",
                        "statement": statement,
                        "verification": "unverified",
                        "source_tag": "user_self_input",
                        "mastery_inference": False,
                        "memory_subject_key": "concept:machine-learning",
                    },
                    provenance={
                        "self_report": True,
                        "explicit_click": True,
                        "mastery_unchanged": True,
                    },
                    client_event_id=f"{_key('self-report-event')}-{index}",
                )
            run = (await db.execute(select(MemorySynthesisRun).where(
                MemorySynthesisRun.learner_id == learner.id,
                MemorySynthesisRun.kernel_name == "knowledge",
                MemorySynthesisRun.subject_key == "concept:machine-learning",
            ).order_by(MemorySynthesisRun.id.desc()))).scalars().first()
            assert run is not None
            assert run.trigger_reason == "knowledge_self_report"
            run.due_at = datetime.utcnow()
            await db.commit()
            return learner.id, run.id

    learner_id, run_id = asyncio.run(scenario())
    completed = asyncio.run(process_synthesis_run(run_id))
    assert completed and completed.status == "completed"

    async def inspect():
        async with async_session() as db:
            row = (await db.execute(
                select(MemoryNode, MemoryClaim, MemoryModule)
                .join(MemoryClaim, MemoryClaim.node_id == MemoryNode.id)
                .join(MemoryModule, MemoryModule.node_id == MemoryClaim.module_node_id)
                .where(
                    MemoryNode.learner_id == learner_id,
                    MemoryNode.kernel_name == "knowledge",
                    MemoryNode.subject_key == "concept:machine-learning",
                    MemoryNode.status == "active",
                )
            )).first()
            return row

    claim_node, claim, module = asyncio.run(inspect())
    assert module.module_type == "evidence_claims"
    assert claim.verification_status == "self_reported"
    assert "掌握" not in claim_node.text
    assert len(module.evidence_fact_ids) == 2


def test_same_kernel_synthesis_has_complete_evidence_path_and_consumes_once():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("memory-synthesis"), display_name="Memory Synthesis")
            db.add(learner)
            await db.flush()
            project = Project(learner_id=learner.id, name="知识验证")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(roadmap_id=roadmap.id, title="图模型", order=1)
            db.add(checkpoint)
            await db.flush()
            for item_id in (101, 102):
                await record_event(
                    db,
                    learner_id=learner.id,
                    project_id=project.id,
                    checkpoint_id=checkpoint.id,
                    event_type="concept_attempt_evaluated",
                    source="grader",
                    payload={
                        "item_id": item_id,
                        "concept_id": "graph-memory",
                        "question": f"题目 {item_id}",
                        "correct": True,
                        "independent": True,
                    },
                    confidence=0.95,
                )
            run = (await db.execute(select(MemorySynthesisRun).where(
                MemorySynthesisRun.learner_id == learner.id,
                MemorySynthesisRun.kernel_name == "knowledge",
                MemorySynthesisRun.subject_key == "concept:graph-memory",
            ).order_by(MemorySynthesisRun.id.desc()))).scalars().first()
            assert run is not None
            run.due_at = datetime.utcnow()
            await db.commit()
            run_id = run.id

        completed = await process_synthesis_run(run_id)
        assert completed and completed.status == "completed"
        async with async_session() as db:
            module = (await db.execute(
                select(MemoryModule).where(MemoryModule.synthesis_run_id == run_id)
            )).scalar_one()
            claims = list((await db.execute(select(MemoryClaim).where(
                MemoryClaim.module_node_id == module.node_id,
            ))).scalars().all())
            supports = list((await db.execute(select(MemoryEdge).where(
                MemoryEdge.target_node_id.in_([claim.node_id for claim in claims]),
                MemoryEdge.relation_type == "SUPPORTS",
            ))).scalars().all())
            facts = list((await db.execute(
                select(MemoryNode, MemoryFact)
                .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
                .where(MemoryFact.consumed_by_module_id == module.node_id)
            )).all())
            projection = await get_kernel_projection(db, learner.id)
            module_count_before = await db.scalar(select(func.count(MemoryModule.node_id)).where(
                MemoryModule.synthesis_run_id == run_id,
            ))
        await process_synthesis_run(run_id)
        async with async_session() as db:
            module_count_after = await db.scalar(select(func.count(MemoryModule.node_id)).where(
                MemoryModule.synthesis_run_id == run_id,
            ))
            return module, claims, supports, facts, projection, module_count_before, module_count_after

    module, claims, supports, facts, projection, before, after = asyncio.run(scenario())
    assert module.immutable is True
    assert claims
    assert {edge.target_node_id for edge in supports} == {claim.node_id for claim in claims}
    assert all(node.kernel_name == "knowledge" for node, _ in facts)
    assert all(fact.consumption_status == "consumed" for _, fact in facts)
    assert projection["knowledge"]["long_term"]["memory_graph_claims"]
    assert before == after == 1


def test_worker_startup_rebuilds_missing_historical_synthesis_queue():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("memory-reconcile"), display_name="Memory Reconcile")
            db.add(learner)
            await db.flush()
            project = Project(learner_id=learner.id, name="历史队列修复")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(roadmap_id=roadmap.id, title="历史事实", order=1)
            db.add(checkpoint)
            await db.flush()
            for item_id in (111, 112):
                await record_event(
                    db,
                    learner_id=learner.id,
                    project_id=project.id,
                    checkpoint_id=checkpoint.id,
                    event_type="concept_attempt_evaluated",
                    source="grader",
                    payload={
                        "item_id": item_id,
                        "concept_id": "historical-reconciliation",
                        "question": f"历史题目 {item_id}",
                        "correct": True,
                        "independent": True,
                    },
                    confidence=0.95,
                )
            queued = list((await db.execute(select(MemorySynthesisRun).where(
                MemorySynthesisRun.learner_id == learner.id,
            ))).scalars().all())
            for run in queued:
                await db.delete(run)
            await db.commit()
            learner_id = learner.id

        rebuilt = await reconcile_eligible_synthesis_runs()
        async with async_session() as db:
            run = (await db.execute(select(MemorySynthesisRun).where(
                MemorySynthesisRun.learner_id == learner_id,
                MemorySynthesisRun.kernel_name == "knowledge",
                MemorySynthesisRun.subject_key == "concept:historical-reconciliation",
                MemorySynthesisRun.status == "queued",
            ))).scalar_one()
            run.due_at = datetime.utcnow()
            await db.commit()
            run_id = run.id
        completed = await process_synthesis_run(run_id)
        async with async_session() as db:
            module_count = await db.scalar(select(func.count(MemoryModule.node_id)).where(
                MemoryModule.synthesis_run_id == run_id,
            ))
            claim_count = await db.scalar(
                select(func.count(MemoryClaim.node_id))
                .join(MemoryModule, MemoryModule.node_id == MemoryClaim.module_node_id)
                .where(MemoryModule.synthesis_run_id == run_id)
            )
        return rebuilt, completed, module_count, claim_count

    rebuilt, completed, module_count, claim_count = asyncio.run(scenario())
    assert rebuilt >= 1
    assert completed and completed.status == "completed"
    assert module_count == claim_count == 1


def test_new_facts_create_versioned_module_with_inherited_evidence_and_single_current_head():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("memory-version"), display_name="Memory Version")
            db.add(learner)
            await db.flush()
            project = Project(learner_id=learner.id, name="版本化记忆")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(roadmap_id=roadmap.id, title="版本链", order=1)
            db.add(checkpoint)
            await db.flush()
            for item_id in (201, 202):
                await record_event(
                    db,
                    learner_id=learner.id,
                    project_id=project.id,
                    checkpoint_id=checkpoint.id,
                    event_type="concept_attempt_evaluated",
                    source="grader",
                    payload={
                        "item_id": item_id,
                        "concept_id": "module-versioning",
                        "question": f"题目 {item_id}",
                        "correct": True,
                        "independent": True,
                    },
                    confidence=0.95,
                )
            first_run = (await db.execute(select(MemorySynthesisRun).where(
                MemorySynthesisRun.learner_id == learner.id,
                MemorySynthesisRun.kernel_name == "knowledge",
                MemorySynthesisRun.subject_key == "concept:module-versioning",
            ).order_by(MemorySynthesisRun.id.desc()))).scalars().first()
            assert first_run is not None
            first_run.due_at = datetime.utcnow()
            await db.commit()
            first_run_id = first_run.id

        await process_synthesis_run(first_run_id)

        async with async_session() as db:
            first_module = (await db.execute(select(MemoryModule).where(
                MemoryModule.synthesis_run_id == first_run_id,
            ))).scalar_one()
            first_evidence = list(first_module.evidence_fact_ids or [])
            await record_event(
                db,
                learner_id=learner.id,
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                event_type="concept_attempt_evaluated",
                source="grader",
                payload={
                    "item_id": 203,
                    "concept_id": "module-versioning",
                    "question": "题目 203",
                    "correct": True,
                    "independent": True,
                },
                confidence=0.95,
            )
            second_run = (await db.execute(select(MemorySynthesisRun).where(
                MemorySynthesisRun.learner_id == learner.id,
                MemorySynthesisRun.kernel_name == "knowledge",
                MemorySynthesisRun.subject_key == "concept:module-versioning",
                MemorySynthesisRun.status == "queued",
            ).order_by(MemorySynthesisRun.id.desc()))).scalars().first()
            assert second_run is not None
            second_run.due_at = datetime.utcnow()
            await db.commit()
            second_run_id = second_run.id

        await process_synthesis_run(second_run_id)

        async with async_session() as db:
            await backfill_module_versions(db)
            await backfill_module_versions(db)
            modules = list((await db.execute(
                select(MemoryNode, MemoryModule)
                .join(MemoryModule, MemoryModule.node_id == MemoryNode.id)
                .where(
                    MemoryNode.learner_id == learner.id,
                    MemoryNode.kernel_name == "knowledge",
                    MemoryNode.subject_key == "concept:module-versioning",
                )
                .order_by(MemoryModule.version.asc())
            )).all())
            active_claims = list((await db.execute(
                select(MemoryNode, MemoryClaim)
                .join(MemoryClaim, MemoryClaim.node_id == MemoryNode.id)
                .where(
                    MemoryNode.learner_id == learner.id,
                    MemoryNode.kernel_name == "knowledge",
                    MemoryNode.subject_key == "concept:module-versioning",
                    MemoryNode.status == "active",
                )
            )).all())
            refine_edges = list((await db.execute(select(MemoryEdge).where(
                MemoryEdge.learner_id == learner.id,
                MemoryEdge.relation_type == "REFINES",
            ))).scalars().all())
            return first_evidence, modules, active_claims, refine_edges

    first_evidence, modules, active_claims, refine_edges = asyncio.run(scenario())
    assert len(modules) == 2
    (first_node, first_module), (second_node, second_module) = modules
    assert first_module.version == 1
    assert second_module.version == 2
    assert second_module.parent_module_node_id == first_node.id
    assert first_node.status == "refined"
    assert second_node.status == "active"
    assert second_module.revision_kind == "refinement"
    assert set(first_evidence) <= set(second_module.evidence_fact_ids or [])
    assert set(second_module.delta_fact_ids or []).isdisjoint(set(first_evidence))
    assert active_claims
    assert {claim.module_node_id for _, claim in active_claims} == {second_node.id}
    assert any(
        edge.source_node_id == second_node.id and edge.target_node_id == first_node.id
        for edge in refine_edges
    )


def test_synthesis_validator_rejects_out_of_whitelist_and_unproven_mastery():
    run = MemorySynthesisRun(kernel_name="knowledge")
    node = MemoryNode(id=1, kernel_name="knowledge")
    fact = MemoryFact(node_id=1, source_event_id=10, evidence_grade="exposure_only")
    event = EvidenceEvent(id=10, event_type="lecture_viewed")
    draft = SynthesisDraft(
        summary="错误的合成",
        claims=[SynthesisClaimDraft(
            text="学习者已经掌握图记忆",
            predicate="knowledge.mastery",
            value=True,
            evidence_fact_ids=[1, 999],
        )],
    )
    errors = _validate_draft(run, draft, [(node, fact, event)])
    assert "claim_0_references_outside_whitelist" in errors
    assert "claim_0_insufficient_mastery_evidence" in errors

    self_reported_fact = MemoryFact(
        node_id=2, source_event_id=11, evidence_grade="self_reported",
    )
    boundary_errors = _validate_draft(
        MemorySynthesisRun(
            kernel_name="knowledge", trigger_reason="knowledge_self_report",
        ),
        SynthesisDraft(summary="接触边界", claims=[SynthesisClaimDraft(
            text="学习者自述接触过该主题，但缺乏可验证的掌握证据。",
            predicate="knowledge.exposure_boundary",
            value="self_reported",
            evidence_fact_ids=[2],
        )]),
        [(
            MemoryNode(id=2, kernel_name="knowledge"),
            self_reported_fact,
            EvidenceEvent(id=11, event_type="learner_concept_observation_recorded"),
        )],
    )
    assert "claim_0_insufficient_mastery_evidence" not in boundary_errors

    second_boundary_errors = _validate_draft(
        MemorySynthesisRun(
            kernel_name="knowledge", trigger_reason="module_refinement",
        ),
        SynthesisDraft(summary="接触边界", claims=[SynthesisClaimDraft(
            text="学习者的掌握程度明确为未完成，未达到可验证的掌握状态。",
            predicate="knowledge.mastery_level",
            value="not_mastered",
            evidence_fact_ids=[2],
        )]),
        [(
            MemoryNode(id=2, kernel_name="knowledge"),
            self_reported_fact,
            EvidenceEvent(id=11, event_type="learner_concept_observation_recorded"),
        )],
    )
    assert "claim_0_insufficient_mastery_evidence" not in second_boundary_errors


def test_kernel_specific_claim_policies_reject_overreach():
    human_rows = [(
        MemoryNode(id=2, kernel_name="human"),
        MemoryFact(node_id=2, source_event_id=20, evidence_grade="inferred"),
        EvidenceEvent(id=20, event_type="semantic_observation"),
    )]
    human_errors = _validate_draft(
        MemorySynthesisRun(kernel_name="human"),
        SynthesisDraft(summary="越界", claims=[SynthesisClaimDraft(
            text="学习者天生属于固定学习风格", predicate="human.personality",
            value=True, evidence_fact_ids=[2],
        )]),
        human_rows,
    )
    assert "claim_0_human_overreach" in human_errors

    value_rows = [(
        MemoryNode(id=3, kernel_name="value"),
        MemoryFact(node_id=3, source_event_id=30, evidence_grade="inferred"),
        EvidenceEvent(id=30, event_type="vnext_value_claim_proposed", payload={}),
    )]
    value_errors = _validate_draft(
        MemorySynthesisRun(kernel_name="value"),
        SynthesisDraft(summary="未确认", claims=[SynthesisClaimDraft(
            text="学习者已经确定方向并形成长期目标", predicate="value.goal",
            value=True, evidence_fact_ids=[3],
        )]),
        value_rows,
    )
    assert "claim_0_value_goal_without_consent" in value_errors

    practice_rows = [(
        MemoryNode(id=4, kernel_name="practice"),
        MemoryFact(node_id=4, source_event_id=40, evidence_grade="observed"),
        EvidenceEvent(id=40, event_type="exercise_attempt_evaluated", payload={}),
    )]
    practice_errors = _validate_draft(
        MemorySynthesisRun(kernel_name="practice"),
        SynthesisDraft(summary="证据不足", claims=[SynthesisClaimDraft(
            text="学习者能够独立迁移该技能", predicate="practice.capability",
            value=True, evidence_fact_ids=[4],
        )]),
        practice_rows,
    )
    assert "claim_0_practice_capability_without_verified_evidence" in practice_errors


def test_cross_kernel_run_is_rejected_without_consuming_facts():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("memory-cross-kernel"), display_name="Cross Kernel")
            db.add(learner)
            await db.flush()
            await record_event(
                db,
                learner_id=learner.id,
                event_type="registration_profile_completed",
                source="registration",
                payload={"background": "零基础", "weekly_hours": 4, "preferred_modes": ["project"]},
                provenance={"self_report": True},
            )
            rows = list((await db.execute(
                select(MemoryNode, MemoryFact)
                .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
                .where(MemoryNode.learner_id == learner.id)
            )).all())
            human = next(row for row in rows if row[0].kernel_name == "human")
            knowledge = next(row for row in rows if row[0].kernel_name == "knowledge")
            ids = [human[0].id, knowledge[0].id]
            run = MemorySynthesisRun(
                learner_id=learner.id,
                kernel_name="human",
                subject_key=human[0].subject_key,
                status="queued",
                trigger_reason="test_cross_kernel",
                candidate_fact_ids=ids,
                input_fingerprint=input_fingerprint("human", human[0].subject_key, ids),
                due_at=datetime.utcnow(),
            )
            db.add(run)
            await db.commit()
            run_id = run.id
        result = await process_synthesis_run(run_id)
        async with async_session() as db:
            facts = list((await db.execute(select(MemoryFact).where(
                MemoryFact.node_id.in_(ids),
            ))).scalars().all())
        return result, facts

    result, facts = asyncio.run(scenario())
    assert result and result.status == "stale"
    assert all(fact.consumption_status == "eligible" for fact in facts)


def test_model_failure_falls_back_to_deterministic_module(monkeypatch):
    async def fail_model(*_args, **_kwargs):
        raise TimeoutError("synthetic timeout")

    monkeypatch.setattr("app.services.memory_worker._model_draft", fail_model)

    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("memory-failure"), display_name="Failure")
            db.add(learner)
            await db.flush()
            await record_event(
                db,
                learner_id=learner.id,
                event_type="user_message",
                source="user",
                payload={"text": "我想学习可解释记忆"},
                provenance={"self_report": True},
            )
            fact_node, fact = (await db.execute(
                select(MemoryNode, MemoryFact)
                .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
                .where(MemoryNode.learner_id == learner.id, MemoryNode.kernel_name == "value")
                .limit(1)
            )).one()
            run = MemorySynthesisRun(
                learner_id=learner.id,
                kernel_name="value",
                subject_key=fact_node.subject_key,
                status="queued",
                trigger_reason="failure_test",
                candidate_fact_ids=[fact_node.id],
                input_fingerprint=input_fingerprint("value", fact_node.subject_key, [fact_node.id]),
                due_at=datetime.utcnow(),
            )
            db.add(run)
            await db.commit()
            run_id, fact_id = run.id, fact.node_id
        result = await process_synthesis_run(run_id)
        async with async_session() as db:
            consumed = await db.get(MemoryFact, fact_id)
            module = (await db.execute(select(MemoryModule).where(
                MemoryModule.synthesis_run_id == run_id,
            ))).scalar_one()
        return result, consumed, module

    result, fact, module = asyncio.run(scenario())
    assert result and result.status == "completed"
    assert result.model_name == "deterministic-fallback"
    assert result.usage == {"fallback_reason": "TimeoutError"}
    assert fact.consumption_status == "consumed"
    assert fact.reservation_run_id is None
    assert module.synthesis_run_id == result.id


def test_memory_api_isolated_and_feedback_appends_history():
    username = _key("memory-api")
    with TestClient(app) as owner, TestClient(app) as outsider:
        registration = {
            "password": "learnflow-pass-123",
            "display_name": "Memory Owner",
            "education_stage": "undergraduate",
            "background": "Python",
            "focus_areas": ["人工智能"],
            "weekly_hours": 6,
            "preferred_modes": ["practice"],
            "career_goal": "学习科学研究者",
            "career_goal_status": "confirmed",
        }
        owner_result = owner.post("/api/auth/register", json={"username": username, **registration})
        outsider_result = outsider.post("/api/auth/register", json={
            "username": _key("memory-outsider"), **registration,
        })
        assert owner_result.status_code == outsider_result.status_code == 200
        learner_id = owner_result.json()["learner_id"]

        async def finish_immediate_runs():
            async with async_session() as db:
                run_ids = list((await db.execute(select(MemorySynthesisRun.id).where(
                    MemorySynthesisRun.learner_id == learner_id,
                    MemorySynthesisRun.status == "queued",
                ))).scalars().all())
            for run_id in run_ids:
                await process_synthesis_run(run_id)

        asyncio.run(finish_immediate_runs())
        claims = owner.get("/api/memory/graph", params={"node_types": "claim"})
        assert claims.status_code == 200
        claim_nodes = claims.json()["nodes"]
        assert claim_nodes
        claim = claim_nodes[0]
        assert outsider.get(f"/api/memory/nodes/{claim['id']}").status_code == 404

        detail_before = owner.get(f"/api/memory/nodes/{claim['id']}").json()
        feedback = owner.post(f"/api/memory/claims/{claim['id']}/feedback", json={
            "action": "correct",
            "correction": "我偏好先动手再阅读解释",
            "reason": "原声明粒度太粗",
        })
        assert feedback.status_code == 200
        assert feedback.json()["event_id"]
        detail_after = owner.get(f"/api/memory/nodes/{claim['id']}").json()
        assert detail_after["text"] == detail_before["text"]
        correction_fact = owner.get(f"/api/memory/nodes/{feedback.json()['fact_id']}").json()
        assert correction_fact["source_event"]["event_type"] == "memory_correction_added"
        assert any(item["relation"] == "CONTRADICTS" for item in correction_fact["relations"])
        queued_id = feedback.json()["queued_consolidation_id"]
        assert queued_id is not None
        completed = asyncio.run(process_synthesis_run(queued_id))
        assert completed and completed.status == "completed"
        modules = owner.get("/api/memory/graph", params={
            "node_types": "module",
            "subject": claim["subject"],
        }).json()["nodes"]
        versions = sorted(modules, key=lambda item: item["module"]["version"])
        assert len(versions) >= 2
        previous, current = versions[-2:]
        assert previous["status"] == "superseded"
        assert current["status"] == "active"
        assert current["module"]["revision_kind"] == "correction"
        assert current["module"]["parent_module_id"] == previous["id"]
