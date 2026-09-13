"""Adversarial contract fixtures, not empirical learner observations."""
import asyncio
import copy
import hashlib
import json
import uuid
from datetime import datetime, timedelta
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from app.db.database import async_session
from app.main import app
from app.models.learning import (EvidenceEvent, KernelMutation, KernelState, Learner,
    LearningAttempt, MemoryClaim, MemoryEdge, MemoryFact, MemoryModule, MemoryNode)
from app.models.project import Checkpoint, ConceptQuestion, Project, Roadmap
from app.services.learning_runtime import create_attempt, get_kernel_projection, record_event
from app.services.five_kernel_context import build_five_kernel_context
from learnflow_core.memory_evidence import evidence_card, list_evidence_cards

@pytest.fixture(scope="module", autouse=True)
def client():
    with TestClient(app) as client:
        accounts = client.get("/api/dev/accounts").json()
        account = next(row for row in accounts if row["username"] == "legacy-demo")
        assert client.post(f"/api/dev/accounts/{account['id']}/login").status_code == 200
        yield client

async def seed(db, *, learner_id=None):
    if learner_id is None:
        learner = Learner(key=f"evidence-{uuid.uuid4()}", display_name="Evidence fixture")
        db.add(learner)
        await db.flush()
        learner_id = learner.id
    project = Project(learner_id=learner_id, name="计算机学习来源验证")
    db.add(project)
    await db.flush()
    roadmap = Roadmap(project_id=project.id, raw_json={})
    db.add(roadmap)
    await db.flush()
    checkpoint = Checkpoint(roadmap_id=roadmap.id, title="Python 真值", order=1)
    db.add(checkpoint)
    await db.flush()
    question = ConceptQuestion(checkpoint_id=checkpoint.id, question="Which is falsy?",
        options=["[1]", "[]"], answer_indexes=[1], q_type="single", order=1)
    db.add(question)
    await db.flush()
    return learner_id, project.id, checkpoint.id, question.id

async def review(db, context, day, *, passed=True, eligible=True, form="validated_variant"):
    learner, project, checkpoint, item = context
    attempt = await create_attempt(db, learner_id=learner, checkpoint_id=checkpoint,
        item_type="concept", item_id=item, submission={"answer_indexes": [1 if passed else 0]},
        result={"correct": passed}, assistance_level="none", attempt_role="review",
        client_submission_id=str(uuid.uuid4()))
    event = await record_event(db, learner_id=learner, project_id=project, checkpoint_id=checkpoint,
        event_type="review_attempt_evaluated", source="review",
        occurred_at=datetime.utcnow() - timedelta(days=day), client_event_id=str(uuid.uuid4()),
        payload={"attempt_id": attempt.id, "source_item_type": "concept", "item_id": item,
                 "passed": passed, "outcome": "correct" if passed else "incorrect",
                 "independent": True, "assistance_level": "none", "stability_eligible": eligible,
                 "question_form": form})
    await db.flush()
    return event

async def fact_for(db, event, predicate="long_term.mastery"):
    return (await db.execute(select(MemoryNode, MemoryFact).join(MemoryFact,
        MemoryFact.node_id == MemoryNode.id).where(MemoryFact.source_event_id == event.id,
                                                 MemoryFact.predicate == predicate))).one()

async def derived(db, context, source):
    learner, project, checkpoint, _ = context
    now = datetime.utcnow()
    args = dict(learner_id=learner, kernel_name="knowledge", subject_key=f"checkpoint:{checkpoint}",
                project_id=project, checkpoint_id=checkpoint, payload={"evidence_fact_ids": [source]},
                occurred_at=now, text="间隔复习曾达到稳定规则")
    module = MemoryNode(node_type="module", **args)
    db.add(module)
    await db.flush()
    db.add(MemoryModule(node_id=module.id, summary=module.text, time_start=now, time_end=now,
        input_fingerprint=uuid.uuid4().hex, evidence_fact_ids=[source]))
    claim = MemoryNode(node_type="claim", **args)
    db.add(claim)
    await db.flush()
    db.add(MemoryClaim(node_id=claim.id, module_node_id=module.id, claim_ordinal=0,
                       predicate="review.qualification", value="stable"))
    for target in (module.id, claim.id):
        db.add(MemoryEdge(learner_id=learner, source_node_id=source, target_node_id=target,
                          relation_type="SUPPORTS"))
    await db.flush()
    return module, claim

def test_failure_invalidates_dependents_preserves_sources_and_recovers_after_new_gap():
    async def scenario():
        async with async_session() as db:
            ctx = await seed(db)
            first = await review(db, ctx, 20)
            second = await review(db, ctx, 16, form="original")
            old_node, old_fact = await fact_for(db, second)
            old_retention, _ = await fact_for(db, second, "short_term.retention_status")
            old_body = copy.deepcopy(old_fact.object_value)
            module, claim = await derived(db, ctx, old_node.id)
            before = await evidence_card(db, ctx[0], old_node.id)
            assert {row["id"] for row in before["links"]} >= {module.id, claim.id}
            failure = await review(db, ctx, 15, passed=False)
            current_node, current_fact = await fact_for(db, failure)
            key = f"review:concept:{ctx[3]}"
            current = current_fact.object_value[key]
            assert current["eligibility"] == "invalidated"
            assert current["historical_evidence_ids"] == [first.id, second.id]
            assert current["invalidated_by_event_id"] == failure.id
            assert old_node.status == module.status == claim.status == old_retention.status == "superseded"
            assert old_fact.object_value == old_body
            assert first.payload["passed"] and second.payload["passed"]
            assert await db.get(LearningAttempt, first.payload["attempt_id"])
            card = await evidence_card(db, ctx[0], current_node.id)
            assert card["availability"] == "invalidated"
            assert any(link["id"] == old_node.id and link["relation"] == "SUPERSEDES" for link in card["links"])
            historical = await evidence_card(db, ctx[0], old_node.id)
            assert historical["availability"] == "historical"
            assert historical["sources"][0]["source_sha256"] == before["sources"][0]["source_sha256"]
            projection = await get_kernel_projection(db, ctx[0])
            assert projection["knowledge"]["long_term"]["mastery"][key]["level"] == "needs_review"
            assert projection["practice"]["long_term"]["proof_chain"][key]["eligibility"] == "invalidated"
            assert claim.id not in [row["id"] for row in projection["knowledge"]["long_term"].get("memory_graph_claims", [])]
            await review(db, ctx, 14, eligible=False, form="original")
            await review(db, ctx, 10)
            mid = await get_kernel_projection(db, ctx[0])
            assert mid["knowledge"]["long_term"]["mastery"][key]["eligibility"] == "invalidated"
            restored = await review(db, ctx, 6, form="original")
            _, restored_fact = await fact_for(db, restored)
            assert restored_fact.object_value[key]["eligibility"] == "current"
            assert restored_fact.object_value[key]["level"] == "stable"
            assert not set(restored_fact.object_value[key]["evidence_ids"]) & {first.id, second.id}
            assert old_node.status == "superseded"
    asyncio.run(scenario())

def test_item_facts_do_not_republish_another_projects_state():
    async def scenario():
        async with async_session() as db:
            left = await seed(db)
            right = await seed(db, learner_id=left[0])
            await review(db, left, 20)
            await review(db, left, 16)
            await review(db, right, 20)
            right_stable = await review(db, right, 16)
            for predicate in ("long_term.mastery", "long_term.proof_chain", "short_term.retention_status", "short_term.review_history"):
                _, fact = await fact_for(db, right_stable, predicate)
                assert len(fact.object_value) == 1
                assert str(left[3]) not in [key.split(":")[-1] for key in fact.object_value]
            await review(db, left, 15, passed=False)
            state = await get_kernel_projection(db, left[0])
            assert state["knowledge"]["long_term"]["mastery"][f"review:concept:{right[3]}"]["level"] == "stable"
    asyncio.run(scenario())

def test_legacy_guard_is_read_only_and_excludes_stale_heads_and_claims():
    async def scenario():
        async with async_session() as db:
            ctx = await seed(db)
            await review(db, ctx, 20)
            stable = await review(db, ctx, 16)
            old_node, old_fact = await fact_for(db, stable)
            saved = copy.deepcopy(old_fact.object_value)
            module, claim = await derived(db, ctx, old_node.id)
            await review(db, ctx, 15, passed=False)
            knowledge = (await db.execute(select(KernelState).where(KernelState.learner_id == ctx[0],
                KernelState.kernel_name == "knowledge"))).scalar_one()
            legacy = {key: {k: v for k, v in value.items() if k in {"level", "evidence_ids"}}
                      for key, value in saved.items()}
            knowledge.long_term = {**knowledge.long_term, "mastery": legacy}
            old_node.status = module.status = claim.status = "active"
            old_fact.consumption_status = "eligible"
            await db.flush()
            version = knowledge.version
            counts = [await db.scalar(select(func.count()).select_from(model)) for model in (EvidenceEvent, KernelMutation)]
            card = await evidence_card(db, ctx[0], old_node.id)
            assert card["availability"] == "invalidated"
            projection = await get_kernel_projection(db, ctx[0])
            assert projection["knowledge"]["long_term"]["mastery"][f"review:concept:{ctx[3]}"]["level"] == "needs_review"
            packet = await build_five_kernel_context(db, learner_id=ctx[0], policy="checkpoint_tutor",
                                                     project_id=ctx[1], checkpoint_id=ctx[2])
            assert {old_node.id, module.id, claim.id}.isdisjoint(row["id"] for row in packet["items"])
            for head in packet["kernel_heads"].values():
                for field in ("stable_refs", "focus_refs", "working_refs", "alert_refs"):
                    assert old_node.id not in head.get(field, [])
            assert knowledge.long_term["mastery"] == legacy and knowledge.version == version
            assert old_node.status == "active"
            assert [await db.scalar(select(func.count()).select_from(model)) for model in (EvidenceEvent, KernelMutation)] == counts
    asyncio.run(scenario())

def test_http_source_chain_hash_readonly_and_ownership(client):
    async def prepare():
        async with async_session() as db:
            learner = await db.scalar(select(Learner.id).where(Learner.key == "local-default"))
            ctx = await seed(db, learner_id=learner)
            event = await review(db, ctx, 1, passed=False)
            node, fact = await fact_for(db, event, "short_term.retention_status")
            foreign = await seed(db)
            other = await review(db, foreign, 1, passed=False)
            foreign_node, _ = await fact_for(db, other, "short_term.retention_status")
            await db.commit()
            return ctx, node.id, copy.deepcopy(fact.object_value), foreign, foreign_node.id
    ctx, node_id, original, foreign, foreign_node = asyncio.run(prepare())
    url = f"/api/memory/evidence/{node_id}?project_id={ctx[1]}&checkpoint_id={ctx[2]}"
    response = client.get(url)
    assert response.status_code == 200, response.text
    card = response.json()
    assert card["coverage"]["complete"]
    source = card["sources"][0]
    text = json.dumps(original, ensure_ascii=False, sort_keys=True)
    assert source["source_sha256"] == hashlib.sha256(text.encode()).hexdigest()
    assert source["text"] == " … ".join(text[a:b] for a, b in source["ranges"])
    assert source["qualifiers"]["assistance_level"] == "none"
    assert "answer_indexes" not in json.dumps(card)
    assert client.get(f"/api/memory/evidence/{foreign_node}").status_code == 404
    assert client.get(f"/api/memory/evidence/{node_id}?project_id={foreign[1]}").status_code == 404
    assert client.get(f"/api/memory/evidence?checkpoint_id={foreign[2]}").status_code == 404
    assert client.get("/api/memory/evidence?review_schedule_id=999999999").status_code == 404
    assert client.get("/api/memory/evidence?limit=21").status_code == 422
    async def tamper():
        async with async_session() as db:
            fact = await db.get(MemoryFact, node_id)
            fact.object_value = {"unexpected": "untrusted text"}
            await db.commit()
    asyncio.run(tamper())
    broken = client.get(url).json()
    assert broken["sources"] == [] and not broken["coverage"]["complete"]

def test_backlinks_bound_cycles_and_foreign_sources_do_not_leak():
    async def scenario():
        async with async_session() as db:
            ctx = await seed(db)
            event = await review(db, ctx, 1, passed=False)
            node, _ = await fact_for(db, event, "short_term.retention_status")
            foreign = await seed(db)
            foreign_event = await review(db, foreign, 1, passed=False)
            foreign_node, _ = await fact_for(db, foreign_event, "short_term.retention_status")
            module, claim = await derived(db, ctx, node.id)
            claim.payload = {"evidence_fact_ids": [node.id, foreign_node.id]}
            db.add(MemoryEdge(learner_id=ctx[0], source_node_id=foreign_node.id,
                              target_node_id=claim.id, relation_type="SUPPORTS"))
            db.add(MemoryEdge(learner_id=ctx[0], source_node_id=claim.id,
                              target_node_id=node.id, relation_type="REFINES"))
            for _ in range(45):
                other = MemoryNode(learner_id=ctx[0], kernel_name="knowledge", node_type="claim",
                                   project_id=ctx[1], checkpoint_id=ctx[2], text="bounded fixture")
                db.add(other)
                await db.flush()
                db.add(MemoryEdge(learner_id=ctx[0], source_node_id=other.id,
                                  target_node_id=node.id, relation_type="REFINES"))
            await db.flush()
            card = await evidence_card(db, ctx[0], claim.id)
            assert [row["node_id"] for row in card["sources"]] == [node.id]
            assert foreign_node.id not in [row["id"] for row in card["links"]]
            assert not card["coverage"]["complete"]
            bounded = await evidence_card(db, ctx[0], node.id)
            assert len(bounded["links"]) <= 40 and bounded["coverage"]["links_truncated"]
            project = await db.get(Project, ctx[1])
            project.visibility = "deleted"
            await db.flush()
            listing = await list_evidence_cards(db, ctx[0])
            assert listing["cards"] == []
            with pytest.raises(HTTPException):
                await evidence_card(db, ctx[0], node.id)
    asyncio.run(scenario())


def test_initial_assessment_is_visible_before_first_review(client):
    async def prepare():
        async with async_session() as db:
            learner = await db.scalar(select(Learner.id).where(Learner.key == "local-default"))
            ctx = await seed(db, learner_id=learner)
            await db.commit()
            return ctx
    ctx = asyncio.run(prepare())
    submitted = client.post(f"/api/checkpoints/{ctx[2]}/concepts/{ctx[3]}/submit", json={
        "answer_indexes": [1], "assistance_level": "none", "client_submission_id": str(uuid.uuid4())})
    assert submitted.status_code == 200, submitted.text
    schedule_id = submitted.json()["review_schedule_id"]
    listed = client.get(f"/api/memory/evidence?review_schedule_id={schedule_id}")
    assert listed.status_code == 200
    assert listed.json()["cards"]
    for card in listed.json()["cards"]:
        assert card["scope"]["checkpoint_id"] == ctx[2]
        assert card["qualification"] is None
        assert card["sources"][0]["event_type"] == "concept_attempt_evaluated"
        assert card["sources"][0]["qualifiers"]["outcome"] == "correct"


def test_legacy_aggregate_is_not_exposed_as_a_single_projects_source():
    async def scenario():
        async with async_session() as db:
            ctx = await seed(db)
            event = await review(db, ctx, 1, passed=False)
            node, fact = await fact_for(db, event, "short_term.retention_status")
            mutation = await db.get(KernelMutation, fact.source_mutation_id)
            own = {k: {field: value for field, value in entry.items() if field != "projection_version"}
                   for k, entry in fact.object_value.items()}
            aggregate = {**own, "concept:999999": {"status": "spaced_stable", "evidence_id": 999999,
                                                  "checkpoint_id": 999999, "private_note": "another project"}}
            mutation.patch = {**mutation.patch, "short_term": {**mutation.patch["short_term"], "retention_status": aggregate}}
            fact.object_value = aggregate
            await db.flush()
            card = await evidence_card(db, ctx[0], node.id, project_id=ctx[1])
            assert card["sources"] == [] and not card["coverage"]["complete"]
            assert "another project" not in json.dumps(card)
    asyncio.run(scenario())
