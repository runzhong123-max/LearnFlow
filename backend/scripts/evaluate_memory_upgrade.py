#!/usr/bin/env python3
"""Synthetic retrieval-only comparison. Never opens the configured application DB.

Runs three actual retrieval strategies over the same disposable projection fixture.
This is not an extraction/reducer benchmark, an LLM answer evaluation or evidence
of student learning gains. No model/network calls or production seed initialization.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def token_estimate(value):
    return max(1, int(len(json.dumps(value, ensure_ascii=False)) / 3.2 + 0.999))


def score_case(selected, gold, forbidden):
    ids = {row["id"] for row in selected}
    expected = set(gold)
    return {"hit_ids": sorted(ids & expected), "missed_ids": sorted(expected - ids),
            "recall": len(ids & expected) / len(expected) if expected else None,
            "old_memory_reference_ids": sorted(ids & set(forbidden)),
            "unexpected_ids": sorted(ids - expected),
            "empty_when_uncovered": not ids if not expected else None}


async def _run(db_path: Path, repetitions: int):
    # Imports happen only after run_evaluation sets DATABASE_URL to a new temp path.
    from datetime import datetime, timedelta
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    import app.models  # register model metadata; no app startup or init_db
    from app.db.database import Base
    from app.models.learning import Learner, EvidenceEvent, KernelMutation, MemoryNode, MemoryFact
    from app.models.project import Project
    from app.services.five_kernel_context import build_five_kernel_context, CONTEXT_POLICIES

    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        policy = CONTEXT_POLICIES["project_tutor"]
        now = datetime.utcnow()
        # Ordered synthetic trajectory: old anchor, superseded goal, many
        # same-project and cross-project distractions, then a correction.
        rows = [
            (1, "concept:backprop_anchor", "backprop_anchor: chain rule difficulty", "active"),
            (1, "concept:career_goal", "career_goal: become a researcher", "superseded"),
        ]
        rows += [(1, f"concept:local_{i}", f"local_{i}: observed exercise", "active") for i in range(40)]
        rows += [(2, f"concept:foreign_{i}", f"foreign_{i}: unrelated project", "active") for i in range(320)]
        rows += [(1, "concept:career_goal", "career_goal: focus on application engineering", "active")]
        current_goal = len(rows)
        async with sessions() as db:
            db.add(Learner(id=1, key="synthetic-memory-evaluation", display_name="Synthetic learner"))
            db.add_all([Project(id=i, learner_id=1, name=f"Synthetic project {i}") for i in (1, 2)])
            await db.flush()
            for identifier, (project_id, subject, body, status) in enumerate(rows, 1):
                occurred = now - timedelta(minutes=len(rows) - identifier)
                db.add(EvidenceEvent(id=identifier, learner_id=1, project_id=project_id,
                    event_type="learner_concept_observation_recorded", source="ui",
                    payload={"statement": body, "synthetic_fixture": True},
                    provenance={"fixture": "memory-upgrade-retrieval-v1"}, occurred_at=occurred))
                db.add(KernelMutation(id=identifier, learner_id=1, event_id=identifier,
                    kernel_name="knowledge", patch={"synthetic_fixture": True}))
                db.add(MemoryNode(id=identifier, learner_id=1, project_id=project_id,
                    node_type="fact", kernel_name="knowledge", subject_key=subject,
                    subject_type="concept", subject_id=subject.split(":", 1)[1],
                    text=body, status=status, occurred_at=occurred,
                    payload={"key": "knowledge_gap", "synthetic_fixture": True}))
                db.add(MemoryFact(node_id=identifier, source_event_id=identifier,
                    source_mutation_id=identifier, fact_ordinal=0,
                    predicate="short_term.knowledge_gap", object_value=body,
                    evidence_grade="self_reported", project_id=project_id))
            await db.commit()
        cases = [
            {"id": "old_anchor_after_360_records", "query": "backprop_anchor", "gold": [1], "forbidden": []},
            {"id": "corrected_goal", "query": "career_goal", "gold": [current_goal], "forbidden": [2]},
            {"id": "uncovered_topic", "query": "quantum_uncovered", "gold": [], "forbidden": []},
        ]
        output = []
        for case in cases:
            for strategy in ("recent_window", "compact_facts", "five_kernel"):
                timings, budget = [], {}
                selected = []
                for _ in range(repetitions):
                    async with sessions() as db:
                        started = time.perf_counter()
                        if strategy == "five_kernel":
                            packet = await build_five_kernel_context(db, learner_id=1,
                                policy="project_tutor", project_id=1, query=case["query"],
                                subject_keys=[f"concept:{case['query']}"])
                            selected = [{"id": row["id"], "text": row["text"]} for row in packet["items"]]
                            budget = {"context_tokens_estimate": packet["manifest"]["token_estimate"],
                                      "selected_items": len(selected), "omitted": packet["omitted"],
                                      "missing_facets": packet["missing_facets"]}
                        else:
                            # Identical scope and validity eligibility precede baseline windows.
                            statement = select(MemoryNode).where(
                                MemoryNode.learner_id == 1, MemoryNode.project_id == 1,
                                MemoryNode.status == "active",
                            ).order_by(MemoryNode.occurred_at.desc(), MemoryNode.id.desc())
                            if strategy == "recent_window":
                                statement = statement.limit(policy.max_items)
                            candidates = list((await db.execute(statement)).scalars())
                            if strategy == "compact_facts":
                                latest = {}
                                for row in candidates:
                                    latest.setdefault(row.subject_key, row)
                                candidates = list(latest.values())
                            selected = []
                            for row in candidates:
                                if case["query"] not in f"{row.subject_key} {row.text}":
                                    continue
                                candidate = {"id": row.id, "text": row.text}
                                if token_estimate([*selected, candidate]) <= policy.token_budget:
                                    selected.append(candidate)
                                if len(selected) >= policy.max_items:
                                    break
                            budget = {"candidate_items": len(candidates), "selected_items": len(selected),
                                      "context_tokens_estimate": token_estimate(selected)}
                        timings.append((time.perf_counter() - started) * 1000)
                output.append({"case_id": case["id"], "strategy": strategy,
                    "query": case["query"], "gold_ids": case["gold"], "selected_ids": [r["id"] for r in selected],
                    **score_case(selected, case["gold"], case["forbidden"]),
                    "latency_ms": {"samples": timings, "median": statistics.median(timings),
                                   "max": max(timings)}, "budget": budget})
        return {"schema_version": "memory-upgrade-evaluation.v1",
            "evaluation_kind": "retrieval_only_not_learning_gain", "synthetic": True,
            "isolation": "fresh_temporary_sqlite_deleted_after_run", "network_calls": 0,
            "fixture": {"nodes": len(rows), "projects": 2, "learner_id": 1,
                        "type": "synthetic_projection_fixture_not_event_reducer_replay"},
            "shared_scope": {"learner_id": 1, "project_id": 1, "active_only": True},
            "limits": {"max_items": policy.max_items, "context_tokens_estimate": policy.token_budget},
            "strategies": {
                "recent_window": "scope/status filter, last max_items facts, exact marker matching",
                "compact_facts": "scope/status filter, latest fact per subject, exact marker matching",
                "five_kernel": "production build_five_kernel_context(project_tutor); full ranked packet"},
            "limitations": ["Synthetic English markers do not measure natural-language semantic recall.",
                "No extraction, reducer, generated answers or student learning outcomes are evaluated.",
                "Baseline packets contain facts only; five-kernel budget also includes its contextual metadata.",
                "Unexpected IDs measure irrelevant retrieval, not necessarily false generated answers.",
                "Full five-kernel retrieval is not forced to abstain; uncovered empty results are reported as observed."],
            "results": output}
    finally:
        await engine.dispose()


def run_evaluation(repetitions: int = 3):
    if not 1 <= repetitions <= 20:
        raise ValueError("repetitions must be between 1 and 20")
    with tempfile.TemporaryDirectory(prefix="learnflow-memory-upgrade-") as temporary:
        db_path = Path(temporary) / "synthetic.db"
        previous = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{db_path}"
        try:
            return asyncio.run(_run(db_path, repetitions))
        finally:
            if previous is None:
                os.environ.pop("DATABASE_URL", None)
            else:
                os.environ["DATABASE_URL"] = previous


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--output", type=Path, help="Optional report path; never a database input")
    args = parser.parse_args()
    report = run_evaluation(args.repetitions)
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
