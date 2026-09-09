#!/usr/bin/env python3
"""LoCoMo text retrieval on isolated raw MemoryNode projections, never official QA.

Only speaker/text/session timestamp and neutral source provenance enter the DB.
There are no EvidenceEvents, KernelMutations, KernelStates, native MemoryFact
details, summaries, claims, edges, model calls, or learning-formation claims.
QA annotations are read only by the driver-side verifier.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta
import gzip
import hashlib
import json
import os
from pathlib import Path
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

from components import LOCOMO_VARIANTS, activation_metrics, budget_body, packet_tokens, policy_for

VERSION = "learnflow-locomo-retrieval.v2"
SOURCE_COMMIT = "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376"
SOURCE_SHA256 = "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4"
SOURCE_URL = f"https://github.com/snap-research/locomo/blob/{SOURCE_COMMIT}/data/locomo10.json"
LICENSE_URL = f"https://github.com/snap-research/locomo/blob/{SOURCE_COMMIT}/LICENSE.txt"
VARIANTS = (*LOCOMO_VARIANTS, "facts_only", "no_relations", "no_episodes", "no_summary_boost")
METRIC_NAMES = ("source_recall", "full_text_recall", "evidence_precision",
                "source_complete", "full_evidence_complete")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_hash(value) -> str:
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode())


def session_time(raw: str) -> datetime:
    """Preserve the unspecified-zone wall time; do not infer each turn's time."""
    return datetime.strptime(raw, "%I:%M %p on %d %B, %Y")


def extract_conversations(data):
    """A strict allow-list: never traverse QA, summaries, observations or images."""
    if not isinstance(data, list) or not data:
        raise ValueError("Expected a nonempty conversation list")
    conversations = []
    seen_samples = set()
    identifier = 0
    for index, sample in enumerate(data, 1):
        sample_id = sample["sample_id"]
        if not isinstance(sample_id, str) or sample_id in seen_samples:
            raise ValueError("Missing or duplicate sample_id")
        seen_samples.add(sample_id)
        source = sample["conversation"]
        turns, seen_ids, speakers = [], set(), Counter()
        sessions = sorted((int(m.group(1)), key) for key in source
                          if (m := re.fullmatch(r"session_(\d+)", key)))
        for number, key in sessions:
            stamp = source[f"{key}_date_time"]
            parsed = session_time(stamp)
            for turn in source[key]:
                dia_id, speaker, text = turn["dia_id"], turn["speaker"], turn["text"]
                if not all(isinstance(v, str) for v in (dia_id, speaker, text)):
                    raise ValueError(f"Non-text conversation turn in {sample_id}")
                if not re.fullmatch(r"D\d+:\d+", dia_id) or dia_id in seen_ids:
                    raise ValueError(f"Invalid/duplicate turn identity: {sample_id}:{dia_id}")
                seen_ids.add(dia_id)
                identifier += 1
                body = f"[{stamp}] {speaker}: {text}"
                turns.append({"node_id": identifier, "dia_id": dia_id, "speaker": speaker,
                              "text": text, "body": body, "session_number": number,
                              "session_timestamp": stamp, "occurred_at": parsed.isoformat(),
                              "has_image_caption": bool(turn.get("blip_caption")),
                              "has_image_metadata": bool(set(turn) & {"img_url", "blip_caption"})})
                speakers[speaker] += 1
        if not turns:
            raise ValueError(f"Empty conversation: {sample_id}")
        conversations.append({"conversation_id": sample_id, "learner_id": index,
                              "project_id": index, "turns": turns, "session_count": len(sessions),
                              "speaker_observations": dict(speakers),
                              "declared_speakers": [source.get("speaker_a"), source.get("speaker_b")]})
    return conversations


def question_manifest(data, conversations):
    """Keep every question, including invalid annotations and non-recall cases."""
    questions = []
    for sample, conversation in zip(data, conversations, strict=True):
        available = {turn["dia_id"]: turn for turn in conversation["turns"]}
        for index, qa in enumerate(sample["qa"]):
            raw_refs = qa.get("evidence")
            errors = []
            refs = []
            if not isinstance(raw_refs, list):
                errors.append("evidence_is_not_a_list")
            else:
                for ref in raw_refs:
                    if not isinstance(ref, str) or ref not in available:
                        errors.append(f"missing_or_invalid_reference:{ref!r}")
                    elif not available[ref]["text"].strip():
                        errors.append(f"empty_evidence_text:{ref}")
                    else:
                        refs.append(ref)
            refs = list(dict.fromkeys(refs))
            category = qa.get("category")
            if type(category) is not int or category not in range(1, 6):
                errors.append("unknown_category")
            if not isinstance(qa.get("question"), str) or not qa["question"].strip():
                errors.append("missing_question")
            # Category 5 evidence can identify the misleading premise; it is
            # never treated as the answer-supporting gold for ordinary recall.
            if category != 5 and not refs:
                errors.append("no_answer_supporting_evidence")
            group = "adversarial_no_answer" if category == 5 else (
                "external_knowledge" if category == 3 else "conversation_evidence")
            questions.append({"case_id": f"{sample['sample_id']}:q{index:04d}",
                              "conversation_id": sample["sample_id"], "question_index": index,
                              "question": qa.get("question"), "category": category,
                              "scoring_group": group, "evidence": raw_refs,
                              "validated_evidence": refs, "annotation_errors": errors,
                              "annotation_status": "invalid_annotation" if errors else "valid",
                              "image_evidence_count": sum(available[r]["has_image_metadata"] for r in refs),
                              "evidence_has_image_caption": any(available[r]["has_image_caption"] for r in refs)})
    return questions


def packet_body(packet):
    return budget_body(packet)


def no_memory_packet():
    packet = {"version": "no-memory-eval-control.v2", "kernel_heads": {}, "items": [],
              "relation_paths": [], "personal_concept_graph": {}, "adaptation_directives": [],
              "teaching_guidance": [], "learning_episodes": [], "retrieval_diagnostics": {},
              "manifest": {"execution": "no_retrieval_short_circuit", "answer_free": True}}
    packet["manifest"]["token_estimate"] = packet_tokens(packet)
    return packet


def score_packet(packet, question, conversation):
    """Score attributed turns and visible original text separately, never answers."""
    turns = {turn["node_id"]: turn for turn in conversation["turns"]}
    selected, full_text, attribution_errors = set(), set(), 0
    rows = list(packet.get("items") or [])
    for path in packet.get("relation_paths") or []:
        rows.extend(path[side] for side in ("source", "target"))
    for item in rows:
        turn = turns.get(item.get("id"))
        if turn is None:
            attribution_errors += 1
            continue
        source = (item.get("detail") or {}).get("source_text") or item.get("source_text") or {}
        # Full text is checked against actual rendered content. A hash alone,
        # source ID, provenance annotation or clipped substring gets no credit.
        selected.add(turn["dia_id"])
        source_valid = True
        if source:
            ranges = source.get("ranges") or []
            valid_ranges = all(isinstance(pair, list) and len(pair) == 2 and
                all(type(n) is int for n in pair) and 0 <= pair[0] <= pair[1] <= len(turn["body"]) for pair in ranges)
            source_valid = (source.get("sha256") == sha256(turn["body"].encode()) and
                            source.get("chars") == len(turn["body"]) and valid_ranges and
                            " … ".join(turn["body"][a:b] for a, b in ranges) == item.get("text"))
            if not source_valid:
                attribution_errors += 1
        if source_valid and turn["text"] and turn["text"] in str(item.get("text") or ""):
            full_text.add(turn["dia_id"])
    gold = set(question["validated_evidence"])
    eligible = question["annotation_status"] == "valid" and question["category"] != 5
    metrics = {name: None for name in METRIC_NAMES}
    if eligible:
        metrics.update(source_recall=len(selected & gold) / len(gold),
                       full_text_recall=len(full_text & gold) / len(gold),
                       evidence_precision=len(selected & gold) / len(selected) if selected else 0.0,
                       source_complete=gold <= selected, full_evidence_complete=gold <= full_text)
    metrics.update(returned_turn_count=len(selected), full_text_turn_count=len(full_text),
                   attribution_error_count=attribution_errors, actual_empty_memory=not rows,
                   evidence_has_image_caption=question["evidence_has_image_caption"],
                   image_evidence_count=question["image_evidence_count"])
    return metrics, {"selected_dia_ids": sorted(selected), "full_text_dia_ids": sorted(full_text),
                     "hit_evidence": sorted(selected & gold), "full_text_evidence": sorted(full_text & gold),
                     "missing_evidence": sorted(gold - selected), "clipped_evidence": sorted((selected & gold) - full_text)}


@contextmanager
def isolated_environment(root):
    keys = ("DATABASE_URL", "LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
            "GOOGLE_API_KEY", "GEMINI_API_KEY", "MEMORY_AUTO_SYNTHESIS_ENABLED")
    previous = {key: os.environ.get(key) for key in keys}
    os.environ.update({key: "" for key in keys})
    os.environ.update(DATABASE_URL=f"sqlite+aiosqlite:///{root}/configured.db",
                      MEMORY_AUTO_SYNTHESIS_ENABLED="false")
    active, attempts, opened = [True], [], set()
    def audit(event, args):
        if not active[0]:
            return
        if event in {"socket.connect", "socket.getaddrinfo"}:
            attempts.append(event)
            raise RuntimeError("Network disabled for isolated retrieval experiment")
        if event == "sqlite3.connect":
            name = str(args[0])
            if name != ":memory:":
                candidate = Path(name).resolve()
                if not candidate.is_relative_to(root):
                    raise RuntimeError("Database access outside disposable experiment directory")
                opened.add(candidate.name)
    sys.addaudithook(audit)
    try:
        yield {"network_attempts": attempts, "sqlite_files": opened}
    finally:
        active[0] = False
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def source_hashes(repo, host):
    paths = set((repo / "packages/learning-core/src/learnflow_core").rglob("*.py"))
    paths.update((host / "app").rglob("*.py"))
    result = {str(path.relative_to(repo)): sha256(path.read_bytes()) for path in sorted(paths)}
    for driver in sorted(Path(__file__).parent.glob("*.py")):
        result["driver:" + driver.name] = sha256(driver.read_bytes())
    tests = Path(__file__).with_name("locomo_test.py")
    if tests.exists():
        result["driver_test:" + tests.name] = sha256(tests.read_bytes())
    return result


async def execute(args, root, conversations, questions, output):
    from sqlalchemy import func, select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    import app.models  # noqa: F401: schema only, no app startup
    from app.db.database import Base
    from app.models.learning import Learner, MemoryNode
    from app.models.project import Project
    from app.services import five_kernel_context as runtime
    expected = args.repo.resolve() / "packages/learning-core/src/learnflow_core/five_kernel_context.py"
    if Path(runtime.__file__).resolve() != expected:
        raise RuntimeError("Production runtime import resolved to the wrong checkout")
    engines, sessions, db_counts = {}, {}, {}
    frozen_at = args.read_time
    frozen = type("FrozenDatetime", (datetime,), {"utcnow": classmethod(lambda cls: frozen_at)})
    by_conversation = {c["conversation_id"]: c for c in conversations}
    calls, rows = 0, []
    try:
        for variant in args.variants:
            if variant == "no_memory":
                continue
            engine = create_async_engine(f"sqlite+aiosqlite:///{root}/{variant}.db")
            engines[variant] = engine
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            sessions[variant] = async_sessionmaker(engine, expire_on_commit=False)
            async with sessions[variant]() as db:
                for c in conversations:
                    db.add(Learner(id=c["learner_id"], key=f"locomo-{c['conversation_id']}"))
                    db.add(Project(id=c["project_id"], learner_id=c["learner_id"], name=c["conversation_id"]))
                await db.flush()
                for c in conversations:
                    ordered = sorted(c["turns"], key=lambda t: (t["occurred_at"], t["node_id"]))
                    kept = ordered[-args.recent_turns:] if variant == "recent_facts" else ordered
                    for turn in kept:
                        stamp = datetime.fromisoformat(turn["occurred_at"])
                        db.add(MemoryNode(id=turn["node_id"], learner_id=c["learner_id"], project_id=c["project_id"],
                            node_type="fact", kernel_name="knowledge", memory_kind="observation",
                            subject_key=f"conversation:{c['conversation_id']}", subject_type="conversation",
                            subject_id=c["conversation_id"], text=turn["body"], status="active", salience=.5,
                            confidence=0.0, occurred_at=stamp, created_at=stamp, updated_at=stamp,
                            payload={"external_dataset": "LoCoMo", "source_dialogue_id": turn["dia_id"],
                                     "speaker": turn["speaker"], "source_session_timestamp": turn["session_timestamp"],
                                     "projection_fixture": "raw_conversation_node_not_native_evidence"}))
                await db.commit()
                db_counts[variant] = {"memory_nodes": await db.scalar(select(func.count()).select_from(MemoryNode))}
                # Reject accidental authority writes; no fake links to satisfy MemoryFact.
                for name in ("evidence_events", "kernel_mutations", "kernel_states", "kernel_heads",
                             "memory_facts", "memory_modules", "memory_claims", "memory_edges"):
                    count = await db.scalar(select(func.count()).select_from(Base.metadata.tables[name]))
                    if count:
                        raise RuntimeError(f"Unexpected authority/summary rows in {name}")
                    db_counts[variant][name] = count
        jobs = [(q, variant, budget) for q in questions for variant in args.variants for budget in args.budgets]
        random.Random(args.seed).shuffle(jobs)
        with (output / "trials.jsonl").open("w", encoding="utf-8") as trials, gzip.open(
                output / "packets.jsonl.gz", "wt", encoding="utf-8") as packets, patch.object(runtime, "datetime", frozen):
            for number, (question, variant, budget) in enumerate(jobs, 1):
                c = by_conversation[question["conversation_id"]]
                policy = policy_for(runtime.CONTEXT_POLICIES["project_tutor"], variant, budget)
                timings, fingerprints, packet, error = [], [], None, None
                for repetition in range(args.repetitions):
                    try:
                        if variant == "no_memory":
                            packet = no_memory_packet()
                        else:
                            async with sessions[variant]() as db:
                                start = time.perf_counter()
                                calls += 1
                                packet = await runtime.build_five_kernel_context(db, learner_id=c["learner_id"],
                                    project_id=c["project_id"], policy=policy, query=question["question"], subject_keys=())
                                timings.append((time.perf_counter() - start) * 1000)
                                await db.rollback()
                        fingerprints.append(stable_hash(packet_body(packet)))
                        packets.write(json.dumps({"case_id": question["case_id"], "conversation_id": c["conversation_id"],
                            "variant": variant, "budget": budget, "repetition": repetition,
                            "packet": packet}, ensure_ascii=False) + "\n")
                    except Exception as exc:
                        error = f"{type(exc).__name__}: {exc}"
                        break
                if error:
                    metrics, diagnostics = {name: None for name in METRIC_NAMES}, {"error": error}
                    status = "execution_error_not_scored"
                else:
                    metrics, diagnostics = score_packet(packet, question, c)
                    status = question["annotation_status"] if question["category"] != 5 else "adversarial_no_qa_score"
                    if question["annotation_status"] == "invalid_annotation":
                        status = "invalid_annotation"
                    tokens = packet["manifest"]["token_estimate"]
                    metrics.update(activation_metrics(packet))
                    metrics.update(tokens_estimate=tokens, budget_ok=tokens == packet_tokens(packet) and tokens <= budget,
                                   latency_ms=statistics.median(timings) if timings else None,
                                   repeat_stable=(len(set(fingerprints)) == 1) if args.repetitions > 1 else None)
                row = {"case_id": question["case_id"], "conversation_id": c["conversation_id"],
                       "category": question["category"], "variant": variant, "budget": budget,
                       "scoring_group": question["scoring_group"], "scoring_status": status,
                       "metrics": metrics, "diagnostics": diagnostics,
                       "component_diagnostics": packet.get("retrieval_diagnostics") if packet else None,
                       "question": question["question"],
                       "evidence": question["evidence"], "annotation_errors": question["annotation_errors"],
                       "repetition_latency_ms": timings, "repetitions": args.repetitions,
                       "content_sha256": fingerprints[-1] if fingerprints and not error else None,
                       "execution": "no_retrieval_short_circuit" if variant == "no_memory" else "production_retrieval"}
                rows.append(row)
                trials.write(json.dumps(row, ensure_ascii=False) + "\n")
                if number % 100 == 0:
                    print(json.dumps({"completed_conditions": number, "total_conditions": len(jobs), "retrieval_calls": calls}), flush=True)
        return rows, {"actual_retrieval_calls": calls, "db_counts": db_counts,
                      "runtime_path": str(runtime.__file__), "frozen_read_time": frozen_at.isoformat(),
                      "time_assumption": "Dataset session wall times interpreted consistently as UTC; no timezone was supplied"}
    finally:
        for engine in engines.values():
            await engine.dispose()


def aggregate(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["variant"], row["budget"], row["category"], row["scoring_group"])].append(row)
    result = []
    for (variant, budget, category, group), values in sorted(groups.items()):
        item = {"variant": variant, "budget": budget, "category": category, "scoring_group": group,
                "conditions": len(values), "invalid_annotations": sum(r["scoring_status"] == "invalid_annotation" for r in values),
                "execution_errors": sum(r["scoring_status"] == "execution_error_not_scored" for r in values)}
        for name in (*METRIC_NAMES, "tokens_estimate", "latency_ms"):
            valid = [r["metrics"].get(name) for r in values if r["metrics"].get(name) is not None]
            item[name] = statistics.mean(valid) if valid else None
            item[name + "_denominator"] = len(valid)
        result.append(item)
    return result


def run(args):
    wall_started = time.perf_counter()
    args.repo, args.host = args.repo.resolve(), args.host.resolve()
    raw = args.dataset.read_bytes()
    if args.dataset_sha256 != SOURCE_SHA256 or sha256(raw) != args.dataset_sha256:
        raise ValueError("Dataset checksum mismatch: refuse partial, modified or unpinned input")
    data = json.loads(raw)
    conversations = extract_conversations(data)
    # Prefix pilots and the full run must use the same clock, not a clock that
    # changes with the selected conversation subset.
    args.read_time = max(datetime.fromisoformat(t["occurred_at"]) for c in conversations for t in c["turns"]) + timedelta(days=1)
    all_questions = question_manifest(data, conversations)
    requested = set(args.conversation_id or [])
    unknown = requested - {c["conversation_id"] for c in conversations}
    if unknown:
        raise ValueError(f"Unknown conversation IDs: {sorted(unknown)}")
    included_conversations = [c for c in conversations if not requested or c["conversation_id"] in requested]
    if args.max_conversations:
        included_conversations = included_conversations[:args.max_conversations]
    included_ids = {c["conversation_id"] for c in included_conversations}
    questions = [q for q in all_questions if q["conversation_id"] in included_ids]
    if args.max_questions:
        questions = questions[:args.max_questions]
    selected_ids = {q["case_id"] for q in questions}
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    # Preserve the exact adapter used for each immutable evidence bundle.
    (output / "driver-source.py").write_bytes(Path(__file__).read_bytes())
    test_source = Path(__file__).with_name("locomo_test.py")
    if test_source.exists():
        (output / "driver-tests-source.py").write_bytes(test_source.read_bytes())
    (output / "questions.jsonl").write_text("".join(json.dumps({**q, "selected_for_run": q["case_id"] in selected_ids},
            ensure_ascii=False) + "\n" for q in all_questions), encoding="utf-8")
    before = source_hashes(args.repo, args.host)
    sys.path[:0] = [str(args.host), str(args.repo / "packages/learning-core/src")]
    started = datetime.utcnow().isoformat()
    try:
        with tempfile.TemporaryDirectory(prefix="learnflow-locomo-") as tmp:
            with isolated_environment(Path(tmp).resolve()) as guard:
                rows, details = asyncio.run(execute(args, Path(tmp), included_conversations, questions, output))
                isolation = {"network_attempts": list(guard["network_attempts"]), "sqlite_files": sorted(guard["sqlite_files"])}
        after = source_hashes(args.repo, args.host)
        if before != after:
            raise RuntimeError("Production or driver source changed during run; results invalid")
        lookup = {(r["case_id"], r["budget"], r["variant"]): r for r in rows}
        controls = {}
        for variant in ("facts_only", "no_relations"):
            pairs = [(r, lookup.get((r["case_id"], r["budget"], "full"))) for r in rows if r["variant"] == variant]
            valid = [(a, b) for a, b in pairs if b and a.get("content_sha256") and b.get("content_sha256")]
            controls[variant] = {"mechanism_activated": None, "activation_basis": "inspect actual component counters; equality alone is not inactivity", "paired_conditions": len(valid),
                                "content_equal": sum(a["content_sha256"] == b["content_sha256"] for a, b in valid)}
        manifest = {"version": VERSION, "kind": "raw_conversation_projection_retrieval_ablation_not_official_qa",
            "source": {"dataset": "LoCoMo10", "commit": SOURCE_COMMIT, "url": SOURCE_URL,
                       "sha256": sha256(raw), "bytes": len(raw), "license": "CC-BY-NC-4.0", "license_url": LICENSE_URL,
                       "attribution": "Maharana, Lee, Tulyakov, Bansal, Barbieri and Fang (2024), Evaluating Very Long-Term Conversational Memory of LLM Agents"},
            "code_commit": subprocess.check_output(["git", "-C", str(args.repo), "rev-parse", "HEAD"], text=True).strip(),
            "source_hashes": before, "source_unchanged": True, "python": sys.version,
            "command": sys.argv, "started_at": started, "ended_at": datetime.utcnow().isoformat(),
            "all_conversations": len(conversations), "all_questions": len(all_questions),
            "all_turns": sum(len(c["turns"]) for c in conversations),
            "all_category_counts": dict(Counter(q["category"] for q in all_questions)),
            "all_annotation_status_counts": dict(Counter(q["annotation_status"] for q in all_questions)),
            "selected_conversations": len(included_conversations), "selected_questions": len(questions),
            "selection": "all" if len(questions) == len(all_questions) else (
                "explicit_conversation_subset" if requested else "ordered_prefix_pilot_not_representative"),
            "selected_conversation_ids": [c["conversation_id"] for c in included_conversations],
            "question_limit": args.max_questions, "wall_seconds": time.perf_counter() - wall_started,
            "conditions": len(rows), "variants": args.variants, "budgets": args.budgets,
            "recent_turns": args.recent_turns, "repetitions": args.repetitions, "job_shuffle_seed": args.seed,
            "negative_controls": controls, "isolation": isolation, **details,
            "conversations": [{k: v for k, v in c.items() if k != "turns"} | {
                "turn_count": len(c["turns"]), "image_metadata_turn_count": sum(t["has_image_metadata"] for t in c["turns"])} for c in conversations],
            "summary_by_category": aggregate(rows),
            "limitations": ["No LLM generation, official QA accuracy, teacher review or learning outcome measurement",
                "MemoryNode fact projections only: no native MemoryFact/Event/Mutation/KernelState formation",
                "All raw history is loaded without gold-based selection; no public generated summaries or annotations enter DB",
                "Images, captions and image search queries are omitted; image-related questions remain in the manifest",
                "Dialogue-ID recall and complete original turn text coverage are different from answer correctness",
                "Precision uses annotated evidence IDs, so legitimate unannotated supporting context can be penalized",
                "Category 5 is never ordinary recall; category 3 external-knowledge reference coverage is separate",
                "Budget uses independently recomputed public character estimate including retrieval diagnostics/episodes/component policy, not model tokens",
                "Conversation-level paired inference required; queries and repeated calls are not independent learners",
                "facts_only/no_relations are inactive negative controls, not evidence that summaries or graphs are useless"]}
        (output / "summary.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"completed": str(output), "conditions": len(rows), **{k: details[k] for k in ("actual_retrieval_calls",)}}, ensure_ascii=False))
    except Exception as exc:
        (output / "failure.json").write_text(json.dumps({"status": "run_failed_not_scored", "error": f"{type(exc).__name__}: {exc}",
            "source_hashes_before": before, "source_hashes_after": source_hashes(args.repo, args.host)}, ensure_ascii=False, indent=2))
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--dataset-sha256", default=SOURCE_SHA256)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--variants", nargs="+", choices=VARIANTS, default=list(LOCOMO_VARIANTS))
    parser.add_argument("--budgets", type=int, nargs="+", default=[1800, 3200])
    parser.add_argument("--recent-turns", type=int, default=24)
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--max-conversations", type=int)
    parser.add_argument("--conversation-id", action="append", help="Repeat to select explicit conversation shards; global clock stays fixed")
    parser.add_argument("--max-questions", type=int)
    args = parser.parse_args()
    if min(args.budgets) < 1000 or not 1 <= args.repetitions <= 10 or args.recent_turns < 1:
        parser.error("Require budgets >= 1000, repetitions 1..10 and recent-turns >= 1")
    if len(args.variants) != len(set(args.variants)) or len(args.budgets) != len(set(args.budgets)):
        parser.error("Variants and budgets must be unique")
    if any(value is not None and value < 1 for value in (args.max_conversations, args.max_questions)):
        parser.error("Pilot limits must be positive")
    run(args)
