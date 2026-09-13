"""Source projection tests use native events and isolated in-memory stores.

Corrupted rows deliberately test read boundaries; they do not provide evidence
of learner behavior or an alternative production memory writer.
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.db.database import Base
from app.models.learning import AgentSession, EvidenceEvent, KernelMutation, Learner, MemoryFact, MemoryNode
from app.models.project import Checkpoint, Project, Roadmap
from app.services.five_kernel_context import CONTEXT_POLICIES, SENSITIVE_FIELDS, _in_scope, _sensitive_node
from app.services.learning_runtime import record_event
from learnflow_core import memory_source
from learnflow_core.memory_graph import _compact
from learnflow_core.memory_query import plan_query, bm25_scores


NOW = datetime(2026, 9, 1, 12)
LONG_TEXT = "我不懂并发缓存。" + "背景过程仍在核对，" * 32 + "仅单线程通过，并发未验证；不要认定已掌握。"


@asynccontextmanager
async def native_source(*, nested=False):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            learner, other = Learner(key="source-owner"), Learner(key="source-other")
            db.add_all([learner, other])
            await db.flush()
            project = Project(learner_id=learner.id, name="Source Projection")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id)
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(roadmap_id=roadmap.id, title="Concurrency", order=1)
            db.add(checkpoint)
            await db.flush()
            session = AgentSession(learner_id=learner.id, project_id=project.id,
                                   session_type="project", title="Source Test")
            db.add(session)
            await db.flush()
            event = await record_event(db, learner_id=learner.id, project_id=project.id,
                checkpoint_id=checkpoint.id, session_id=session.id,
                event_type="learner_concept_observation_recorded" if nested else "user_message", source="user",
                payload={"concept_key": "concurrency", "statement": LONG_TEXT} if nested else {"text": LONG_TEXT},
                occurred_at=NOW - timedelta(hours=1), client_event_id="source-event")
            predicate = "short_term.concept_observation" if nested else "short_term.knowledge_gap"
            node, fact = (await db.execute(select(MemoryNode, MemoryFact)
                .join(MemoryFact, MemoryFact.node_id == MemoryNode.id).where(
                    MemoryFact.source_event_id == event.id, MemoryFact.predicate == predicate))).one()
            mutation = await db.get(KernelMutation, fact.source_mutation_id)
            await db.flush()
            c = SimpleNamespace(learner=learner, other=other, project=project, checkpoint=checkpoint,
                                session=session, event=event, node=node, fact=fact, mutation=mutation)
            yield db, c
    finally:
        await engine.dispose()


def permitted(c):
    return lambda node, fact: not _sensitive_node(node, fact) and _in_scope(node,
        CONTEXT_POLICIES["project_tutor"], project_id=c.project.id,
        checkpoint_id=c.checkpoint.id, session_id=c.session.id)


async def resolve(db, c, **kwargs):
    return await memory_source.resolve_source_documents(db, learner_id=c.learner.id,
        nodes=kwargs.pop("nodes", [c.node]), node_allowed=kwargs.pop("node_allowed", permitted(c)),
        sensitive_fields=SENSITIVE_FIELDS, now=NOW, **kwargs)


def test_safe_native_source_preserves_tail_and_truthful_offsets_without_writes():
    async def scenario():
        async with native_source() as (db, c):
            tables = (MemoryNode, MemoryFact, EvidenceEvent, KernelMutation)
            before = [await db.scalar(select(func.count()).select_from(t)) for t in tables]
            documents = await resolve(db, c)
            source = documents[c.node.id]
            assert source.node_id == c.node.id and source.text == c.fact.object_value == LONG_TEXT
            assert "并发未验证" not in c.node.text
            assert source.source_kind == "fact_object_value" and source.source_path == "/object_value"
            assert source.source_hash == hashlib.sha256(LONG_TEXT.encode()).hexdigest()
            rendered, metadata = source.excerpt(["并发", "单线程"], limit=160)
            assert "并发未验证" in rendered and "仅单线程通过" in rendered
            assert metadata["sha256"] == source.source_hash and metadata["chars"] == len(LONG_TEXT)
            assert " … ".join(LONG_TEXT[a:b] for a, b in metadata["ranges"]) == rendered
            assert metadata["source_event_id"] == c.event.id
            assert metadata["source_mutation_id"] == c.mutation.id
            assert metadata["source_kind"] == "fact_object_value"
            # The integration can rank a tail term before it exists in compact node_text.
            query = plan_query("单线程")
            full, _ = bm25_scores(query, {c.node.id: source.text})
            compact, _ = bm25_scores(query, {c.node.id: c.node.text})
            assert full.get(c.node.id, 0) > 0 and not compact.get(c.node.id, 0)
            assert [await db.scalar(select(func.count()).select_from(t)) for t in tables] == before
            assert not db.new and not db.dirty and not db.deleted
    asyncio.run(scenario())


def test_reviewed_nested_statement_is_an_exact_field_not_arbitrary_json():
    async def scenario():
        async with native_source(nested=True) as (db, c):
            source = (await resolve(db, c))[c.node.id]
            assert source.text == LONG_TEXT
            assert source.source_kind == "fact_object_field"
            assert source.source_path == "/object_value/statement"
            assert "concept_key" not in source.text
            assert source.source_hash == hashlib.sha256(c.fact.object_value["statement"].encode()).hexdigest()
    asyncio.run(scenario())


@pytest.mark.parametrize("change", [
    "foreign_event", "foreign_mutation", "wrong_event_link", "rejected_mutation", "mutation_kernel",
    "fact_scope", "event_scope", "wrong_ordinal", "wrong_predicate", "different_value", "different_patch",
    "different_compact_text", "different_event_type", "different_node_time", "future_event",
    "excluded_fact", "foreign_project", "foreign_session", "archived_checkpoint", "deleted_project",
    "malformed_patch",
])
def test_invalid_or_inconsistent_native_links_never_expand_source(change):
    async def scenario():
        async with native_source() as (db, c):
            if change == "foreign_event": c.event.learner_id = c.other.id
            elif change == "foreign_mutation": c.mutation.learner_id = c.other.id
            elif change == "wrong_event_link": c.mutation.event_id = 999999
            elif change == "rejected_mutation": c.mutation.status = "rejected"
            elif change == "mutation_kernel": c.mutation.kernel_name = "practice"
            elif change == "fact_scope": c.fact.project_id = None
            elif change == "event_scope": c.event.session_id = None
            elif change == "wrong_ordinal": c.fact.fact_ordinal = 99999
            elif change == "wrong_predicate": c.fact.predicate = "short_term.other_key"
            elif change == "different_value": c.fact.object_value += " hidden tail"
            elif change == "different_patch": c.mutation.patch = {"short_term": {"knowledge_gap": "another value"}}
            elif change == "different_compact_text": c.node.text = "unmatched compact text"
            elif change == "different_event_type": c.event.event_type = "another_event"
            elif change == "different_node_time": c.node.occurred_at -= timedelta(minutes=1)
            elif change == "future_event": c.event.occurred_at = NOW + timedelta(days=1)
            elif change == "excluded_fact": c.fact.consumption_status = "excluded"
            elif change == "foreign_project": c.project.learner_id = c.other.id
            elif change == "foreign_session": c.session.learner_id = c.other.id
            elif change == "archived_checkpoint": c.checkpoint.archived = True
            elif change == "deleted_project": c.project.visibility = "deleted"
            elif change == "malformed_patch": c.mutation.patch = {"short_term": ["bad shape"]}
            await db.flush()
            source = (await resolve(db, c))[c.node.id]
            assert source.source_kind == "node_text" and source.text == c.node.text
            assert source.fallback_reason and source.source_event_id is None
            assert source.source_hash == hashlib.sha256(c.node.text.encode()).hexdigest()
    asyncio.run(scenario())


@pytest.mark.parametrize("placement", ["event", "mutation", "fact", "node"])
def test_sensitive_fields_do_not_enter_expanded_or_fallback_text(placement):
    async def scenario():
        async with native_source() as (db, c):
            secret = {"answer_key": "sealed_source_answer"}
            if placement == "event": c.event.payload = {**c.event.payload, "private_result": secret}
            elif placement == "mutation": c.mutation.patch = {**c.mutation.patch, "hidden_result": secret}
            elif placement == "fact": c.fact.object_value = {"nested": secret}
            else: c.node.payload = {**c.node.payload, "nested": secret}
            await db.flush()
            documents = await resolve(db, c)
            if placement in {"fact", "node"}:
                assert c.node.id not in documents
            else:
                assert documents[c.node.id].source_kind == "node_text"
                assert documents[c.node.id].fallback_reason == "sensitive_source_payload"
            assert "sealed_source_answer" not in json.dumps({i: vars(s) for i, s in documents.items()})
    asyncio.run(scenario())


@pytest.mark.parametrize("denial", ["human", "foreign_learner", "caller_archive"])
def test_caller_visibility_and_human_exclusion_have_no_fallback(denial):
    async def scenario():
        async with native_source() as (db, c):
            if denial == "human": c.node.kernel_name = "human"
            elif denial == "foreign_learner": c.node.learner_id = c.other.id
            await db.flush()
            documents = await resolve(db, c, node_allowed=(lambda *_: False) if denial == "caller_archive" else permitted(c))
            assert documents == {}
    asyncio.run(scenario())


def test_factless_adapter_keeps_full_node_text_and_true_node_offsets():
    async def scenario():
        async with native_source() as (db, c):
            external = MemoryNode(learner_id=c.learner.id, project_id=c.project.id, node_type="fact",
                kernel_name="knowledge", text=LONG_TEXT, subject_key="conversation:external",
                status="active", occurred_at=NOW - timedelta(days=1), payload={"external_dataset": "LoCoMo"})
            db.add(external)
            await db.flush()
            source = (await resolve(db, c, nodes=[external]))[external.id]
            assert source.text == LONG_TEXT and source.source_kind == "node_text"
            rendered, metadata = source.excerpt(["并发未验证"], limit=160)
            assert " … ".join(external.text[a:b] for a, b in metadata["ranges"]) == rendered
            assert metadata["source_path"] == "/text" and metadata["source_kind"] == "node_text"
            assert "source_event_id" not in metadata
    asyncio.run(scenario())


def test_unreviewed_nested_shape_does_not_expand_json():
    async def scenario():
        async with native_source() as (db, c):
            value = {"detail": "filler " * 80 + "unreviewed_nested_tail"}
            c.fact.object_value = value
            c.mutation.patch = {"short_term": {"pending_question": LONG_TEXT, "knowledge_gap": value}, "long_term": {}}
            c.node.text = f"knowledge_gap: {_compact(value)}"
            await db.flush()
            source = (await resolve(db, c))[c.node.id]
            assert source.source_kind == "node_text" and "unreviewed_nested_tail" not in source.text
            assert source.fallback_reason == "unsupported_source_shape"
    asyncio.run(scenario())


def test_shared_source_import_is_from_this_checkout():
    # Both host files must execute the shared module, never a stale installed copy.
    test_path = Path(__file__).resolve()
    repo = next(parent for parent in test_path.parents if (parent / "packages/learning-core").is_dir())
    assert Path(memory_source.__file__).resolve() == repo / "packages/learning-core/src/learnflow_core/memory_source.py"


def test_context_can_import_first_in_a_fresh_host_process():
    test_path = Path(__file__).resolve()
    repo = next(parent for parent in test_path.parents if (parent / "packages/learning-core").is_dir())
    host = test_path.parents[1]
    env = {**os.environ, "PYTHONPATH": os.pathsep.join((str(host), str(repo / "packages/learning-core/src")))}
    result = subprocess.run([sys.executable, "-c",
        "import app.services.five_kernel_context; import learnflow_core.memory_source"],
        cwd=host, env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_context_source_projection_retrieves_native_tail_with_true_offsets():
    from dataclasses import replace
    from app.services.five_kernel_context import build_five_kernel_context

    async def scenario():
        async with native_source() as (db, c):
            kwargs = dict(learner_id=c.learner.id, project_id=c.project.id,
                checkpoint_id=c.checkpoint.id, session_id=c.session.id, query="单线程")
            base = replace(CONTEXT_POLICIES["project_tutor"], token_budget=6500,
                           enable_episodes=False, max_paths=0)
            compact = await build_five_kernel_context(db, policy=base, **kwargs)
            packet = await build_five_kernel_context(db,
                policy=replace(base, enable_source_text=True), **kwargs)
            assert c.node.id not in {item["id"] for item in compact["items"]}
            item = next(item for item in packet["items"] if item["id"] == c.node.id)
            assert "仅单线程通过" in item["text"] and "并发未验证" in item["text"]
            metadata = item["detail"]["source_text"]
            assert metadata["source_kind"] == "fact_object_value"
            assert metadata["sha256"] == hashlib.sha256(LONG_TEXT.encode()).hexdigest()
            assert " … ".join(LONG_TEXT[a:b] for a, b in metadata["ranges"]) == item["text"]
            assert item["detail"]["source_event_id"] == c.event.id
    asyncio.run(scenario())


def test_corpus_bm25_uses_audited_typo_plan_before_admission():
    from dataclasses import replace
    from app.services.five_kernel_context import build_five_kernel_context

    async def scenario():
        async with native_source() as (db, c):
            event = await record_event(db, learner_id=c.learner.id, project_id=c.project.id,
                checkpoint_id=c.checkpoint.id, session_id=c.session.id,
                event_type="user_message", source="user",
                payload={"text": "我不懂 Scheduler queue fairness has not been independently verified."},
                occurred_at=NOW - timedelta(minutes=30), client_event_id="source-typo-event")
            wanted = await db.scalar(select(MemoryFact.node_id).where(
                MemoryFact.source_event_id == event.id, MemoryFact.predicate == "short_term.knowledge_gap"))
            packet = await build_five_kernel_context(db, learner_id=c.learner.id,
                project_id=c.project.id, checkpoint_id=c.checkpoint.id, session_id=c.session.id,
                query="schedulr", policy=replace(CONTEXT_POLICIES["project_tutor"],
                    token_budget=6500, enable_episodes=False, max_paths=0,
                    candidate_mode="corpus_bm25", enable_fuzzy=True))
            assert wanted in {item["id"] for item in packet["items"]}
            assert any(correction["original"] == "schedulr" and correction["corrected"] == "scheduler"
                       for correction in packet["manifest"]["query_plan"]["fuzzy_corrections"])
    asyncio.run(scenario())
