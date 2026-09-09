#!/usr/bin/env python3
"""Package an unscored teacher export with private, independently random IDs.

This is a presentation-only step. It never reads the large experiment raw files,
changes an experiment, scores a response, or modifies the supplied export.
Distribute only reviewer/. Keep coordinator/ local until ratings are locked.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import secrets


INPUT_FILES = (
    "manifest.json", "stage_a_evidence.jsonl", "stage_a_reviews.csv",
    "stage_b_blind_plans.jsonl", "stage_b_reviews.csv", "COORDINATOR_ONLY_key.csv",
)
A_FIELDS = ("review_case_id", "reviewer_id", "status", "task_realism_0_2",
            "evidence_sufficiency_0_2", "gold_valid_0_2", "ambiguous_or_wrong_labels",
            "required_revision", "rationale")
B_FIELDS = ("review_plan_id", "reviewer_id", "status", "current_constraint_fit_0_2",
            "evidence_grounding_0_2", "next_step_0_2", "assistance_distinction_0_2",
            "unsupported_mastery_0_2", "critical_error", "rationale")
KEY_FIELDS = ("review_plan_id", "case_id", "budget", "variant")
PLAN_FIELDS = {"title", "objective", "estimated_minutes", "session_focus", "phases"}
INTERNAL_FIELDS = {"variant", "budget", "policy_version", "schema_version", "source_kind",
                   "source_event_id", "source_event_ids", "source_fact_ids", "source_mutation_ids",
                   "evidence_refs", "evidence_event_ids", "attempt_id", "kernel", "scope",
                   "teaching_preparation_sources", "teaching_constraints", "teaching_decisions",
                   "retrieval_diagnostics", "personalization_basis", "provenance"}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _jsonl(data):
    return [json.loads(line) for line in data.decode("utf-8").splitlines() if line.strip()]


def _csv(data, fields):
    reader = csv.DictReader(io.StringIO(data.decode("utf-8"), newline=""))
    _require(tuple(reader.fieldnames or ()) == fields, "Unexpected CSV columns")
    result = list(reader)
    _require(all(set(row) == set(fields) and all(v is not None for v in row.values())
                 for row in result), "Malformed CSV row")
    return result


def _index(rows, key, label):
    _require(bool(rows), f"Empty {label}")
    result = {}
    for row in rows:
        value = row.get(key)
        _require(isinstance(value, str) and bool(value), f"Missing {label} identity")
        _require(value not in result, f"Duplicate {label} identity")
        result[value] = row
    return result


def _unscored(rows, identity):
    for row in rows:
        _require(row["status"] == "pending", "Only pending review forms may be packaged")
        _require(all(value == "" for key, value in row.items() if key not in (identity, "status")),
                 "Refusing a filled review form; packaging must not discard ratings or reviewer data")


def _check_plan(value):
    if isinstance(value, dict):
        _require(not INTERNAL_FIELDS.intersection(value), "Plan contains internal condition/evidence metadata")
        for child in value.values():
            _check_plan(child)
    elif isinstance(value, list):
        for child in value:
            _check_plan(child)


def _load(source):
    data = {name: (source / name).read_bytes() for name in INPUT_FILES}
    manifest = json.loads(data["manifest.json"])
    _require(manifest.get("review_status") == "pending" and
             type(manifest.get("ratings_filled")) is int and manifest["ratings_filled"] == 0,
             "Source manifest must declare pending review with zero filled ratings")
    a = _jsonl(data["stage_a_evidence.jsonl"])
    b = _jsonl(data["stage_b_blind_plans.jsonl"])
    af = _csv(data["stage_a_reviews.csv"], A_FIELDS)
    bf = _csv(data["stage_b_reviews.csv"], B_FIELDS)
    key = _csv(data["COORDINATOR_ONLY_key.csv"], KEY_FIELDS)
    ai, bi = _index(a, "review_case_id", "case"), _index(b, "review_plan_id", "plan")
    afi = _index(af, "review_case_id", "case form")
    bfi = _index(bf, "review_plan_id", "plan form")
    ki = _index(key, "review_plan_id", "coordinator key")
    _unscored(af, "review_case_id")
    _unscored(bf, "review_plan_id")
    _require(set(ai) == set(afi) and set(bi) == set(bfi) == set(ki), "Cross-table ID mismatch")
    _require(manifest.get("synthetic_cases") == len(a) and
             manifest.get("actual_plan_conditions") == len(b), "Manifest counts mismatch")
    original_cases = set()
    for row in a:
        _require(set(row) == {"review_case_id", "synthetic", "stage", "case", "author_rubric_pending_review"},
                 "Unexpected Stage A fields")
        _require(row["synthetic"] is True and row["stage"] == "A_dataset_validity_before_plan_review",
                 "Unexpected Stage A identity")
        case_id = row["case"].get("case_id")
        rubric = row["author_rubric_pending_review"]
        _require(isinstance(case_id, str) and case_id and case_id == rubric.get("case_id") and
                 case_id not in original_cases, "Case/rubric identity mismatch or duplicate")
        review = rubric.get("teacher_review")
        _require(isinstance(review, dict) and review.get("status") == "pending" and
                 all(v in (None, "") for k, v in review.items() if k != "status"),
                 "Refusing an adjudicated author rubric")
        original_cases.add(case_id)
    used_cases, conditions = set(), set()
    for row in b:
        _require(set(row) == {"review_plan_id", "review_case_id", "stage", "plan"} and
                 row["stage"] == "B_blind_plan_review_after_stage_A_adjudication", "Unexpected Stage B fields")
        _require(row["review_case_id"] in ai, "Plan references an unknown case")
        binding = ki[row["review_plan_id"]]
        _require(binding["case_id"] == ai[row["review_case_id"]]["case"]["case_id"], "Wrong condition/case binding")
        _require(binding["budget"].isdigit() and int(binding["budget"]) > 0 and bool(binding["variant"]),
                 "Invalid condition identity")
        condition = (binding["case_id"], int(binding["budget"]), binding["variant"])
        _require(condition not in conditions, "Duplicate actual condition")
        conditions.add(condition)
        used_cases.add(row["review_case_id"])
        _require(isinstance(row["plan"], dict) and set(row["plan"]) <= PLAN_FIELDS and
                 isinstance(row["plan"].get("phases"), list), "Unexpected plan projection")
        _check_plan(row["plan"])
    _require(used_cases == set(ai), "Case has no actual plan")
    return manifest, a, b, afi, bfi, ki, {name: hashlib.sha256(value).hexdigest() for name, value in data.items()}


def _new_id(prefix, allocated):
    for _ in range(100):
        value = prefix + secrets.token_hex(16)
        if value not in allocated:
            allocated.add(value)
            return value
    raise RuntimeError("Random identifier allocation repeatedly collided")


def _write(path, content):
    with path.open("x", encoding="utf-8", newline="") as stream:
        stream.write(content)
    path.chmod(0o600)


def _write_json(path, value):
    _write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _write_jsonl(path, rows):
    _write(path, "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))


def _write_csv(path, fields, rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    _write(path, stream.getvalue())


def package(source: Path, output: Path):
    source, output = Path(source).resolve(), Path(output).absolute()
    _require(not output.exists() and not output.is_symlink(), "Output must be a new directory")
    manifest, a, b, afi, bfi, ki, hashes = _load(source)
    allocated = {row["review_case_id"] for row in a} | {row["review_plan_id"] for row in b}
    case_ids = {row["review_case_id"]: _new_id("case_", allocated) for row in a}
    plan_ids = {row["review_plan_id"]: _new_id("plan_", allocated) for row in b}
    ca, cb, case_key, plan_key = [], [], [], []
    for original in a:
        row = deepcopy(original)
        identifier = case_ids[original["review_case_id"]]
        row["review_case_id"] = identifier
        row["case"]["case_id"] = identifier
        row["author_rubric_pending_review"]["case_id"] = identifier
        ca.append(row)
        case_key.append({"review_case_id": identifier, "original_review_case_id": original["review_case_id"],
                         "case_id": original["case"]["case_id"]})
    for original in b:
        row = deepcopy(original)
        row["review_plan_id"] = plan_ids[original["review_plan_id"]]
        row["review_case_id"] = case_ids[original["review_case_id"]]
        cb.append(row)
        plan_key.append({"review_plan_id": row["review_plan_id"], "review_case_id": row["review_case_id"],
                         "original_review_plan_id": original["review_plan_id"],
                         "original_review_case_id": original["review_case_id"],
                         **{k: v for k, v in ki[original["review_plan_id"]].items() if k != "review_plan_id"}})
    secrets.SystemRandom().shuffle(ca)
    secrets.SystemRandom().shuffle(cb)
    # Validation finishes before creating anything; mkdir refuses an existing destination.
    output.mkdir(mode=0o700)
    reviewer, coordinator = output / "reviewer", output / "coordinator"
    reviewer.mkdir(mode=0o700)
    coordinator.mkdir(mode=0o700)
    _write_jsonl(reviewer / "stage_a_evidence.jsonl", ca)
    _write_jsonl(reviewer / "stage_b_blind_plans.jsonl", cb)
    reverse_a = {v: k for k, v in case_ids.items()}
    reverse_b = {v: k for k, v in plan_ids.items()}
    _write_csv(reviewer / "stage_a_reviews.csv", A_FIELDS,
               [{**afi[reverse_a[r["review_case_id"]]], "review_case_id": r["review_case_id"]} for r in ca])
    _write_csv(reviewer / "stage_b_reviews.csv", B_FIELDS,
               [{**bfi[reverse_b[r["review_plan_id"]]], "review_plan_id": r["review_plan_id"]} for r in cb])
    _write(reviewer / "README.md", "# 教师评审材料\n\n"
           "只分发本 reviewer 目录；coordinator 目录由协调者本地私有保存，评分锁定前不得公开。\n\n"
           "先完成 Stage A 的题目、经历和作者标签审核；裁决完成后再进行 Stage B 方案评审。"
           "在 CSV 中填写审核者与评分。所有初始评分为空、状态为 pending；导出不代表教师审核已经完成。\n\n"
           "案例为合成材料。方案是实际生成方案的展示投影，内容保持原导出不变；"
           "内部条件和来源绑定不随包分发。请依据阶段、教学准备与时间安排评审。"
           "不同方案的行为本身可能让评审者猜测实验组，因此随机编号不保证完全盲化。"
           "本评审不测量真实学生学习收益。\n")
    public_manifest = {"schema": "learnflow.private-teacher-review-package.v1", "review_status": "pending",
                       "ratings_filled": 0, "synthetic_cases": len(ca), "actual_plan_conditions": len(cb),
                       "identity_method": "independent random identifiers; no public derivation seed",
                       "limitations": ["Distribute reviewer directory only", "Behavior may reveal or suggest conditions",
                                       "Author-seen synthetic cases; teacher review and learning benefits not established"]}
    _write_json(reviewer / "manifest.json", public_manifest)
    _write_csv(coordinator / "case_key.csv", tuple(case_key[0]), case_key)
    _write_csv(coordinator / "plan_key.csv", tuple(plan_key[0]), plan_key)
    _write_json(coordinator / "original_manifest.json", manifest)
    _write_json(coordinator / "manifest.json", {
        **public_manifest, "created_at": datetime.now(timezone.utc).isoformat(), "source_directory": str(source),
        "source_export_sha256": hashes, "raw_source_hashes": manifest.get("raw_source_hashes", {}),
        "raw_hash_verification": "Preserved declarations from source export; raw experiment files not reopened",
        "dataset_hashes": manifest.get("dataset_hashes", {}),
        "reviewer_file_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(reviewer.iterdir())},
        "case_identity_changes": "Only outer review_case_id and the two Stage A case_id fields replaced",
        "plan_behavior_changes": "None; plan objects copied exactly from the supplied Stage B export",
        "mapping_policy": "Keep both key files private until independent ratings are locked", "status": "complete",
    })
    return public_manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = package(args.source, args.output)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        parser.exit(2, f"Refused teacher-review packaging: {exc}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
