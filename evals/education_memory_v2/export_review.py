#!/usr/bin/env python3
"""Export unscored, blinded teacher-review forms from actual local education runs.

No ratings are generated. The coordinator key must be withheld from reviewers.
Review is still pending after export; these are synthetic cases, not students.
"""
import argparse
from collections import defaultdict
import csv
import gzip
import hashlib
import json
from pathlib import Path


def rows(path):
    with (gzip.open if path.suffix == ".gz" else open)(path, "rt", encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def blind(seed, *values):
    return hashlib.sha256(":".join(map(str, (seed, *values))).encode()).hexdigest()[:20]


def csv_write(path, fields, items):
    with path.open("x", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader(); writer.writerows(items)


def export(args):
    cases = {r["case_id"]: r for r in rows(args.dataset / "data/cases.jsonl")}
    rubrics = {r["case_id"]: r for r in rows(args.dataset / "data/rubrics.jsonl")}
    records = []
    for path in args.raw:
        records.extend(r for r in rows(path) if r.get("plan") and r.get("packet") is not None and r.get("repeat", 0) == 0)
    if not records:
        raise ValueError("No saved actual plan/packet records. Run education.py with --save-packets.")
    identifiers = [(r["case_id"], r["budget"], r["variant"]) for r in records]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Duplicate actual conditions; do not silently choose a run")
    groups = defaultdict(set)
    for row in records:
        if row["case_id"] not in cases:
            raise ValueError("Unknown frozen case")
        groups[(row["domain"], row["pattern"])].add(row["case_id"])
    selected = {case for key, values in sorted(groups.items())
                for case in sorted(values, key=lambda x: blind(args.seed, x))[:args.per_stratum]}
    records = [r for r in records if r["case_id"] in selected]
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=False)
    dataset_forms, evidence_packets = [], []
    for case_id in sorted(selected):
        case = cases[case_id]
        identifier = blind(args.seed, "case", case_id)
        dataset_forms.append({"review_case_id": identifier, "reviewer_id": "", "status": "pending",
                              "task_realism_0_2": "", "evidence_sufficiency_0_2": "", "gold_valid_0_2": "",
                              "ambiguous_or_wrong_labels": "", "required_revision": "", "rationale": ""})
        evidence_packets.append({"review_case_id": identifier, "synthetic": True,
                                 "stage": "A_dataset_validity_before_plan_review", "case": case,
                                 "author_rubric_pending_review": rubrics[case_id]})
    (output / "stage_a_evidence.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in evidence_packets))
    csv_write(output / "stage_a_reviews.csv", list(dataset_forms[0]), dataset_forms)
    plans, forms, key = [], [], []
    for row in sorted(records, key=lambda r: blind(args.seed, r["case_id"], r["budget"], r["variant"])):
        identifier = blind(args.seed, row["case_id"], row["budget"], row["variant"])
        # Preserve learner-visible plan behavior; hide ablation names/counters,
        # policy IDs and internal evidence bindings that reveal the condition.
        plan = {k: v for k, v in row["plan"].items() if k in
                ("title", "objective", "estimated_minutes", "session_focus", "phases")}
        plan["phases"] = [{k: v for k, v in phase.items() if k not in ("teaching_preparation_sources",)}
                           for phase in plan.get("phases", [])]
        plans.append({"review_plan_id": identifier, "review_case_id": blind(args.seed, "case", row["case_id"]),
                      "stage": "B_blind_plan_review_after_stage_A_adjudication", "plan": plan})
        forms.append({"review_plan_id": identifier, "reviewer_id": "", "status": "pending",
                      "current_constraint_fit_0_2": "", "evidence_grounding_0_2": "", "next_step_0_2": "",
                      "assistance_distinction_0_2": "", "unsupported_mastery_0_2": "",
                      "critical_error": "", "rationale": ""})
        key.append({"review_plan_id": identifier, "case_id": row["case_id"], "budget": row["budget"], "variant": row["variant"]})
    (output / "stage_b_blind_plans.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in plans))
    csv_write(output / "stage_b_reviews.csv", list(forms[0]), forms)
    csv_write(output / "COORDINATOR_ONLY_key.csv", list(key[0]), key)
    manifest = {"schema": "learnflow.teacher-review-export.v1", "review_status": "pending",
                "ratings_filled": 0, "synthetic_cases": len(selected), "actual_plan_conditions": len(records),
                "selection": "deterministic per domain-pattern stratum from supplied saved actual runs",
                "seed": args.seed, "per_stratum": args.per_stratum,
                "raw_source_hashes": {str(p): sha(p) for p in args.raw},
                "dataset_hashes": {name: sha(args.dataset / "data" / name) for name in ("cases.jsonl", "rubrics.jsonl")},
                "limitations": ["Export does not constitute teacher review or demonstrate learning gain",
                                "Cases and former holdout are author-seen; no blind-test claim",
                                "Do not reveal COORDINATOR_ONLY_key.csv until independent ratings are locked"]}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, nargs="+", required=True)
    parser.add_argument("--dataset", type=Path, default=Path(__file__).resolve().parents[1] / "computing_learner_profile")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--per-stratum", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20260908)
    args = parser.parse_args()
    if args.per_stratum < 1:
        parser.error("per-stratum must be positive")
    print(json.dumps(export(args), ensure_ascii=False))
