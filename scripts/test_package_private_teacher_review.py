"""Small synthetic fixtures; no product DB, experiment raw files or ratings."""
from copy import deepcopy
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("private_review", Path(__file__).with_name("package_private_teacher_review.py"))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
VARIANTS = ("full", "facts_only", "recent_facts", "no_relations", "no_guidance", "no_episodes",
            "no_bm25", "no_aliases", "no_fuzzy", "no_temporal", "no_summary_boost", "no_memory")


def old_id(*values):
    return hashlib.sha256(":".join(map(str, (20260908, *values))).encode()).hexdigest()[:20]


def write_csv(path, fields, rows):
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def read_csv(path):
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def write_jsonl(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))


def fixture(path):
    path.mkdir()
    a, b, af, bf, key = [], [], [], [], []
    for case_id in ("original-case-one", "original-case-two"):
        case_review = old_id("case", case_id)
        a.append({"review_case_id": case_review, "synthetic": True,
                  "stage": "A_dataset_validity_before_plan_review",
                  "case": {"case_id": case_id, "current": {"request": "今天只有十分钟"},
                           "observations": [{"text": "在帮助下通过，还未独立验证"}]},
                  "author_rubric_pending_review": {"case_id": case_id, "must_preserve": ["保留帮助等级"],
                       "teacher_review": {"status": "pending", "reviewer": None, "reviewed_at": None}}})
        af.append({name: case_review if name == "review_case_id" else "pending" if name == "status" else ""
                   for name in tool.A_FIELDS})
        for budget in (1800, 3200):
            for variant in VARIANTS:
                identifier = old_id(case_id, budget, variant)
                plan = {"title": "验证理解", "objective": "先撤去支持，再独立验证", "estimated_minutes": 10,
                        "session_focus": {"max_minutes": 10, "instruction": "只完成当前目标"},
                        "phases": [{"id": "verify", "kind": "verify", "required": True, "status": "pending",
                                    "teaching_preparation": "先完成有支持的准备", "purpose": "独立回答并检查限制条件",
                                    "completion_rule": "提交独立回答", "methods": ["independent_probe"]}]}
                if variant == "no_memory":
                    plan["phases"][0]["teaching_preparation"] = "准备一个新问题"
                b.append({"review_plan_id": identifier, "review_case_id": case_review,
                          "stage": "B_blind_plan_review_after_stage_A_adjudication", "plan": plan})
                bf.append({name: identifier if name == "review_plan_id" else "pending" if name == "status" else ""
                           for name in tool.B_FIELDS})
                key.append({"review_plan_id": identifier, "case_id": case_id, "budget": budget, "variant": variant})
    write_jsonl(path / "stage_a_evidence.jsonl", a)
    write_jsonl(path / "stage_b_blind_plans.jsonl", b)
    write_csv(path / "stage_a_reviews.csv", tool.A_FIELDS, af)
    write_csv(path / "stage_b_reviews.csv", tool.B_FIELDS, bf)
    write_csv(path / "COORDINATOR_ONLY_key.csv", tool.KEY_FIELDS, key)
    manifest = {"schema": "learnflow.teacher-review-export.v1", "review_status": "pending", "ratings_filled": 0,
                "synthetic_cases": len(a), "actual_plan_conditions": len(b), "seed": 20260908,
                "raw_source_hashes": {"/does-not-exist/raw.jsonl.gz": "a" * 64},
                "dataset_hashes": {"cases.jsonl": "b" * 64}}
    (path / "manifest.json").write_text(json.dumps(manifest))


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.output = self.root / "packaged"
        fixture(self.source)

    def package(self):
        return tool.package(self.source, self.output)

    def test_behavior_gold_cross_table_ids_and_pending_preserved(self):
        before = {p.name: p.read_bytes() for p in self.source.iterdir()}
        result = self.package()
        self.assertEqual((result["synthetic_cases"], result["actual_plan_conditions"]), (2, 48))
        public, private = self.output / "reviewer", self.output / "coordinator"
        self.assertEqual({p.name for p in public.iterdir()}, {"stage_a_evidence.jsonl", "stage_a_reviews.csv",
            "stage_b_blind_plans.jsonl", "stage_b_reviews.csv", "README.md", "manifest.json"})
        a = {r["review_case_id"]: r for r in read_jsonl(public / "stage_a_evidence.jsonl")}
        b = {r["review_plan_id"]: r for r in read_jsonl(public / "stage_b_blind_plans.jsonl")}
        original_a = {r["review_case_id"]: r for r in read_jsonl(self.source / "stage_a_evidence.jsonl")}
        original_b = {r["review_plan_id"]: r for r in read_jsonl(self.source / "stage_b_blind_plans.jsonl")}
        for row in read_csv(private / "case_key.csv"):
            expected = deepcopy(original_a[row["original_review_case_id"]])
            expected["review_case_id"] = row["review_case_id"]
            expected["case"]["case_id"] = row["review_case_id"]
            expected["author_rubric_pending_review"]["case_id"] = row["review_case_id"]
            self.assertEqual(a[row["review_case_id"]], expected)
        for row in read_csv(private / "plan_key.csv"):
            self.assertIn(row["review_case_id"], a)
            self.assertEqual(b[row["review_plan_id"]]["review_case_id"], row["review_case_id"])
            self.assertEqual(b[row["review_plan_id"]]["plan"], original_b[row["original_review_plan_id"]]["plan"])
            self.assertEqual(row["original_review_plan_id"], old_id(row["case_id"], row["budget"], row["variant"]))
        for name, identity, identifiers in (("stage_a_reviews.csv", "review_case_id", a),
                                             ("stage_b_reviews.csv", "review_plan_id", b)):
            forms = read_csv(public / name)
            self.assertEqual({r[identity] for r in forms}, set(identifiers))
            for form in forms:
                self.assertEqual(form["status"], "pending")
                self.assertTrue(all(v == "" for k, v in form.items() if k not in (identity, "status")))
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.source.iterdir()})

    def test_public_seed_attack_reproduces_old_mapping_but_not_new_ids(self):
        # Stronger attacker than the reviewer: knows original case IDs and all 24 conditions.
        guessed = {old_id(case, budget, variant) for case in ("original-case-one", "original-case-two")
                   for budget in (1800, 3200) for variant in VARIANTS}
        self.assertEqual(guessed, {r["review_plan_id"] for r in read_jsonl(self.source / "stage_b_blind_plans.jsonl")})
        self.package()
        public = self.output / "reviewer"
        fresh = {r["review_plan_id"] for r in read_jsonl(public / "stage_b_blind_plans.jsonl")}
        self.assertFalse(guessed & fresh)
        text = "\n".join(p.read_text() for p in public.iterdir())
        for forbidden in (*guessed, "original-case-one", "original-case-two", '"seed"', '"variant"', '"budget"'):
            self.assertNotIn(forbidden, text)
        for variant in VARIANTS:
            self.assertNotIn(variant, text)

    def test_repackaging_creates_independent_ids_and_order_with_private_trace(self):
        self.package()
        second = self.root / "other"
        tool.package(self.source, second)
        first_ids = [r["review_plan_id"] for r in read_jsonl(self.output / "reviewer/stage_b_blind_plans.jsonl")]
        second_ids = [r["review_plan_id"] for r in read_jsonl(second / "reviewer/stage_b_blind_plans.jsonl")]
        self.assertFalse(set(first_ids) & set(second_ids))
        def source_order(folder):
            mapping = {r["review_plan_id"]: r["original_review_plan_id"]
                       for r in read_csv(folder / "coordinator/plan_key.csv")}
            return [mapping[r["review_plan_id"]] for r in read_jsonl(folder / "reviewer/stage_b_blind_plans.jsonl")]
        self.assertNotEqual(source_order(self.output), source_order(second))
        m = json.loads((self.output / "coordinator/manifest.json").read_text())
        self.assertEqual(m["source_export_sha256"], {name: hashlib.sha256((self.source / name).read_bytes()).hexdigest()
                                                   for name in tool.INPUT_FILES})
        self.assertEqual(m["raw_source_hashes"], {"/does-not-exist/raw.jsonl.gz": "a" * 64})
        self.assertEqual(m["reviewer_file_sha256"], {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                                   for p in (self.output / "reviewer").iterdir()})
        self.assertEqual(json.loads((self.output / "coordinator/original_manifest.json").read_text()),
                         json.loads((self.source / "manifest.json").read_text()))
        self.assertEqual((self.output / "coordinator").stat().st_mode & 0o777, 0o700)

    def test_filled_fields_and_completed_states_rejected_before_output_creation(self):
        for name, fields, changes in (
            ("stage_a_reviews.csv", tool.A_FIELDS, {"task_realism_0_2": "0"}),
            ("stage_b_reviews.csv", tool.B_FIELDS, {"rationale": "已检查"}),
            ("stage_b_reviews.csv", tool.B_FIELDS, {"reviewer_id": "teacher"}),
            ("stage_b_reviews.csv", tool.B_FIELDS, {"rationale": " "}),
            ("stage_b_reviews.csv", tool.B_FIELDS, {"status": "complete"}),
        ):
            with self.subTest(changes=changes):
                path = self.source / name
                original = path.read_bytes()
                rows = read_csv(path)
                rows[0].update(changes)
                write_csv(path, fields, rows)
                with self.assertRaises(ValueError):
                    self.package()
                self.assertFalse(self.output.exists())
                path.write_bytes(original)

    def test_reviewed_manifest_and_adjudicated_rubric_rejected(self):
        p = self.source / "manifest.json"
        original = p.read_bytes()
        m = json.loads(original)
        m["ratings_filled"] = 1
        p.write_text(json.dumps(m))
        with self.assertRaises(ValueError):
            self.package()
        p.write_bytes(original)
        a = read_jsonl(self.source / "stage_a_evidence.jsonl")
        a[0]["author_rubric_pending_review"]["teacher_review"]["reviewer"] = "teacher"
        write_jsonl(self.source / "stage_a_evidence.jsonl", a)
        with self.assertRaises(ValueError):
            self.package()
        self.assertFalse(self.output.exists())

    def test_broken_or_duplicate_table_bindings_rejected(self):
        p = self.source / "COORDINATOR_ONLY_key.csv"
        original = p.read_bytes()
        for kind in ("missing", "wrong_case", "duplicate_condition", "duplicate_id"):
            with self.subTest(kind=kind):
                rows = read_csv(p)
                if kind == "missing":
                    rows.pop()
                elif kind == "wrong_case":
                    rows[0]["case_id"] = "unknown-case"
                elif kind == "duplicate_condition":
                    rows[1]["variant"] = rows[0]["variant"]
                else:
                    rows[1]["review_plan_id"] = rows[0]["review_plan_id"]
                write_csv(p, tool.KEY_FIELDS, rows)
                with self.assertRaises(ValueError):
                    self.package()
                self.assertFalse(self.output.exists())
                p.write_bytes(original)

    def test_internal_phase_binding_not_silently_passed_to_reviewers(self):
        p = self.source / "stage_b_blind_plans.jsonl"
        b = read_jsonl(p)
        b[0]["plan"]["phases"][0]["teaching_preparation_sources"] = [{"source_event_id": 1}]
        write_jsonl(p, b)
        with self.assertRaisesRegex(ValueError, "internal"):
            self.package()
        self.assertFalse(self.output.exists())

    def test_existing_destination_is_never_overwritten(self):
        self.output.mkdir()
        marker = self.output / "keep.txt"
        marker.write_text("do not modify")
        with self.assertRaises(ValueError):
            self.package()
        self.assertEqual(marker.read_text(), "do not modify")
        self.assertEqual(list(self.output.iterdir()), [marker])

    def test_symlink_destination_is_rejected(self):
        self.output.symlink_to(self.root / "missing-target")
        with self.assertRaises(ValueError):
            self.package()
        self.assertFalse((self.root / "missing-target").exists())

    def test_random_collisions_fail_without_publishing_a_partial_package(self):
        with patch.object(tool.secrets, "token_hex", return_value="0" * 32):
            with self.assertRaises(RuntimeError):
                self.package()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
