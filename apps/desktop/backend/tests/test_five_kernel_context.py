import asyncio
import uuid

from sqlalchemy import func, select

from app.db.database import async_session, init_db
from app.models.learning import AgentSession, KernelHead, Learner, MemoryNode
from app.models.project import Checkpoint, Project, Roadmap
from app.services.five_kernel_context import (
    CONTEXT_PACKET_VERSION,
    build_five_kernel_context,
    compact_projection_from_packet,
    resolve_context_policy,
)
from app.services.learning_runtime import record_event
from app.services.memory_graph import _add_edge


def _key(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


async def _scoped_learning_place(db, learner_id: int, name: str):
    project = Project(learner_id=learner_id, name=name)
    db.add(project)
    await db.flush()
    roadmap = Roadmap(project_id=project.id, raw_json={})
    db.add(roadmap)
    await db.flush()
    checkpoint = Checkpoint(roadmap_id=roadmap.id, title=f"{name}关卡", order=1)
    db.add(checkpoint)
    await db.flush()
    return project, checkpoint


def test_context_packet_is_bounded_scoped_deterministic_and_answer_free():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("packet"), display_name="Packet Learner")
            other = Learner(key=_key("packet-other"), display_name="Other Learner")
            db.add_all([learner, other])
            await db.flush()
            project, checkpoint = await _scoped_learning_place(db, learner.id, "数组项目")
            other_project, other_checkpoint = await _scoped_learning_place(db, other.id, "隔离项目")
            stale_project, stale_checkpoint = await _scoped_learning_place(db, learner.id, "其他项目")

            for item_id in range(18):
                await record_event(
                    db,
                    learner_id=learner.id,
                    project_id=project.id,
                    checkpoint_id=checkpoint.id,
                    event_type="concept_attempt_evaluated",
                    source="grader",
                    payload={
                        "item_id": item_id,
                        "concept_id": "arrays",
                        "memory_subject_key": "concept:arrays",
                        "question": f"数组边界题 {item_id}",
                        "correct": item_id % 3 != 0,
                        "independent": True,
                    },
                )
            await record_event(
                db,
                learner_id=other.id,
                project_id=other_project.id,
                checkpoint_id=other_checkpoint.id,
                event_type="concept_attempt_evaluated",
                source="grader",
                payload={
                    "item_id": 900,
                    "concept_id": "arrays",
                    "memory_subject_key": "concept:arrays",
                    "question": "OTHER_LEARNER_SECRET",
                    "correct": False,
                    "independent": True,
                },
            )
            await record_event(
                db,
                learner_id=learner.id,
                project_id=stale_project.id,
                checkpoint_id=stale_checkpoint.id,
                event_type="concept_attempt_evaluated",
                source="grader",
                payload={
                    "item_id": 901,
                    "concept_id": "arrays",
                    "memory_subject_key": "concept:arrays",
                    "question": "OTHER_PROJECT_SECRET",
                    "correct": False,
                    "independent": True,
                },
            )
            sensitive = MemoryNode(
                learner_id=learner.id,
                node_type="fact",
                kernel_name="knowledge",
                memory_kind="observation",
                subject_key="concept:arrays",
                subject_type="concept",
                subject_id="arrays",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                text="PRIVATE_ANSWER_SECRET",
                payload={"key": "answer", "answer": "PRIVATE_ANSWER_SECRET"},
                confidence=1.0,
                salience=1.0,
                status="active",
            )
            active = MemoryNode(
                learner_id=learner.id,
                node_type="claim",
                kernel_name="knowledge",
                memory_kind="semantic_claim",
                subject_key="concept:arrays",
                subject_type="concept",
                subject_id="arrays",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                text="数组边界仍需复查",
                payload={},
                confidence=0.8,
                salience=0.95,
                status="active",
            )
            superseded = MemoryNode(
                learner_id=learner.id,
                node_type="claim",
                kernel_name="knowledge",
                memory_kind="semantic_claim",
                subject_key="concept:arrays",
                subject_type="concept",
                subject_id="arrays",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                text="已废弃的数组判断",
                payload={},
                confidence=0.7,
                salience=0.8,
                status="superseded",
            )
            db.add_all([sensitive, active, superseded])
            await db.flush()
            await _add_edge(
                db,
                learner_id=learner.id,
                source_node_id=active.id,
                target_node_id=superseded.id,
                relation_type="SUPERSEDES",
            )
            await db.commit()

            packet = await build_five_kernel_context(
                db,
                learner_id=learner.id,
                policy="checkpoint_tutor",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                subject_keys=["concept:arrays"],
                query="数组边界为什么答错",
            )
            repeated = await build_five_kernel_context(
                db,
                learner_id=learner.id,
                policy="checkpoint_tutor",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                subject_keys=["concept:arrays"],
                query="数组边界为什么答错",
            )
            heads = list((await db.execute(select(KernelHead).where(
                KernelHead.learner_id == learner.id,
            ))).scalars().all())
            return packet, repeated, heads, active.id, superseded.id

    packet, repeated, heads, active_id, superseded_id = asyncio.run(scenario())
    rendered = str(packet)
    assert packet["version"] == CONTEXT_PACKET_VERSION
    assert packet["snapshot_id"] == repeated["snapshot_id"]
    assert len(packet["items"]) <= 12
    assert len(packet["relation_paths"]) <= 6
    assert packet["manifest"]["answer_free"] is True
    assert packet["omitted"]["sensitive_filtered"] >= 1
    assert "PRIVATE_ANSWER_SECRET" not in rendered
    assert "OTHER_LEARNER_SECRET" not in rendered
    assert "OTHER_PROJECT_SECRET" not in rendered
    assert superseded_id not in {item["id"] for item in packet["items"]}
    assert active_id in {item["id"] for item in packet["items"]}
    assert any(path["relation"] == "SUPERSEDES" for path in packet["resolved_updates"])
    assert all(path["relation"] == "CONTRADICTS" for path in packet["conflicts"])
    assert len(heads) == 5
    assert all(len(head.focus_refs or []) <= 3 for head in heads)
    assert all(len(head.alert_refs or []) <= 5 for head in heads)
    assert all(len(head.working_refs or []) <= 8 for head in heads)
    assert all(len(head.stable_refs or []) <= 5 for head in heads)


def test_transient_human_memory_does_not_cross_session_scope():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=_key("human-scope"), display_name="Human Scope")
            db.add(learner)
            await db.flush()
            project, checkpoint = await _scoped_learning_place(db, learner.id, "人因项目")
            first = AgentSession(
                learner_id=learner.id, session_type="checkpoint",
                project_id=project.id, checkpoint_id=checkpoint.id, title="first",
            )
            second = AgentSession(
                learner_id=learner.id, session_type="project",
                project_id=project.id, title="second",
            )
            db.add_all([first, second])
            await db.flush()
            await record_event(
                db,
                learner_id=learner.id,
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                session_id=first.id,
                event_type="vnext_human_adaptation_requested",
                source="user",
                payload={
                    "signal_kind": "frustration",
                    "value": "acknowledge_and_reduce_scope",
                    "strength": 0.9,
                    "explicit": True,
                    "evidence_quote": "这题太难了，我有点跟不上",
                },
            )
            await db.commit()
            first_packet = await build_five_kernel_context(
                db,
                learner_id=learner.id,
                policy="checkpoint_tutor",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                session_id=first.id,
                query="太难",
            )
            second_packet = await build_five_kernel_context(
                db,
                learner_id=learner.id,
                policy="project_tutor",
                project_id=project.id,
                session_id=second.id,
                query="太难",
            )
            return first_packet, second_packet

    first_packet, second_packet = asyncio.run(scenario())
    assert first_packet["adaptation_directives"]
    assert any(
        "缩小" in item["instruction"] or "挫败" in item["instruction"]
        for item in first_packet["adaptation_directives"]
    )
    assert second_packet["adaptation_directives"] == []
    assert all(item["kernel"] != "human" for item in first_packet["items"])
    assert all(item["kernel"] != "human" for item in second_packet["items"])
    second_human = second_packet["kernel_heads"]["human"]
    assert "frustrated" not in str(second_human)
    assert "cognitive_load" not in str(second_human)


def test_capability_policy_and_legacy_projection_adapter_are_explicit():
    policy = resolve_context_policy(capability="evaluate_review_attempt")
    assert policy.id == "review_tutor"
    assert policy.deep_kernels == ("knowledge", "practice")
    packet = {
        "kernel_heads": {
            "structure": {
                "summary": "在第一关",
                "focus_refs": [1],
                "alert_refs": [],
                "working_refs": [1],
                "stable_refs": [2],
                "facets": {"confidence": 0.8},
            },
        },
    }
    projection = compact_projection_from_packet(packet, project_id=3, checkpoint_id=7)
    assert projection["structure"]["short_term"]["session_scope"] == {
        "project_id": 3,
        "checkpoint_id": 7,
    }
    assert projection["structure"]["long_term"]["stable_refs"] == [2]
    assert set(projection) == {"structure", "knowledge", "human", "value", "practice"}
