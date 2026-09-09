"""Data integrity tests, not LearnFlow behavior or teaching-effectiveness tests."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import dataset


class DatasetBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.families = dataset.load_families()
        cls.family = cls.families[0]

    def case(self, pattern):
        return dataset.build_case(self.family, pattern, self.families)

    def test_full_corpus_integrity(self):
        report = dataset.validate()
        self.assertEqual(report["task_families"], 72)
        self.assertEqual(report["human_teacher_reviewed"], 0)

    def test_unseen_answers_and_rubric_canaries_never_exported(self):
        f = deepcopy(self.family)
        f["next_activity"] = "HIDDEN_NEXT_ACTIVITY_CANARY"
        f["misconception"] = "HIDDEN_MISCONCEPTION_CANARY"
        for p in f["probes"]:
            p["explanation"] = "HIDDEN_EXPLANATION_CANARY"
            p["oracle"] = {"answer": "HIDDEN_ORACLE_CANARY"}
            if p["id"] != "base":
                p["prompt"] = "UNSEEN_TRANSFER_PROMPT_CANARY"
                p["artifact"] = "UNSEEN_TRANSFER_ARTIFACT_CANARY"
                p["correct_response"] = "UNSEEN_TRANSFER_ANSWER_CANARY"
        c, _ = dataset.build_case(f, "independent_once", self.families)
        visible = json.dumps(dataset.export_case(c, f))
        for canary in ("HIDDEN_NEXT_ACTIVITY_CANARY", "HIDDEN_MISCONCEPTION_CANARY", "HIDDEN_EXPLANATION_CANARY",
                       "HIDDEN_ORACLE_CANARY", "UNSEEN_TRANSFER_PROMPT_CANARY", "UNSEEN_TRANSFER_ARTIFACT_CANARY", "UNSEEN_TRANSFER_ANSWER_CANARY"):
            self.assertNotIn(canary, visible)
        # A learner's own historical response is useful evidence, not a gold leak.
        self.assertEqual(dataset.export_case(c, f)["history"][-1]["payload"]["response"], next(p for p in f["probes"] if p["id"] == "base")["correct_response"])

    def test_author_topic_and_extracted_constraints_not_given_as_perfect_profile(self):
        c, _ = self.case("temporary_constraint_active")
        item = dataset.export_case(c, self.family)["history"][-1]
        self.assertEqual(set(item["payload"]), {"text"})
        self.assertIn("10分钟", item["payload"]["text"])
        self.assertNotIn("time_cap_minutes", item["payload"])

    def test_probe_role_hidden_but_original_repeat_identity_preserved(self):
        repeated, _ = self.case("repeated_original")
        novel, _ = self.case("novel_transfer_once")
        def tasks(c):
            return [e["payload"]["presented_task"]["id"] for e in dataset.export_case(c, self.family)["history"] if e["kind"] == "assessment_observation"]
        self.assertEqual(tasks(repeated)[0], tasks(repeated)[1])
        self.assertNotEqual(tasks(novel)[0], tasks(novel)[1])
        for c in (repeated, novel):
            visible = dataset.encoded(dataset.export_case(c, self.family))
            self.assertNotIn("near_transfer", visible)
            self.assertNotIn("delayed_transfer", visible)
            self.assertNotIn('"probe_ref":"base"', visible)

    def test_future_occurrence_and_late_ingestion_both_excluded(self):
        c, _ = self.case("future_invariance")
        invisible = [e for e in c["observations"] if not dataset.eligible(e, c)]
        self.assertEqual(len(invisible), 2)
        self.assertTrue(any(e["occurred_at"] <= c["current"]["at"] < e["recorded_at"] for e in invisible))
        view = dataset.export_case(c, self.family)
        self.assertTrue({e["id"] for e in invisible}.isdisjoint(e["id"] for e in view["history"]))

    def test_foreign_learner_and_project_rejected(self):
        c, _ = self.case("scope_invariance")
        excluded = [e for e in c["observations"] if not dataset.eligible(e, c)]
        self.assertEqual(len(excluded), 2)
        self.assertTrue(any(e["scope"]["learner_id"] != c["current"]["learner_id"] for e in excluded))
        self.assertTrue(any(e["scope"]["project_id"] != c["current"]["project_id"] for e in excluded))

    def test_source_correction_points_to_error_not_initial_success(self):
        c, g = self.case("source_retraction")
        correction = next(e for e in c["observations"] if e["kind"] == "source_correction")
        targets = [e for e in c["observations"] if e["id"] in correction["payload"]["target_observation_ids"]]
        self.assertEqual(len(targets), 2)
        self.assertEqual(targets[0]["payload"]["outcome"], "incorrect")
        self.assertEqual(targets[1]["payload"]["topic"], "reasoning")
        self.assertIn(correction["id"], g["evidence_refs"])

    def test_missing_skip_unknown_not_conflated_with_incorrect(self):
        c, _ = self.case("insufficient_evidence")
        attempts = [e["payload"] for e in c["observations"] if e["kind"] == "assessment_observation"]
        self.assertEqual([a["outcome"] for a in attempts], ["missing", "skipped", "dont_know"])
        self.assertIsNone(attempts[0]["response"])
        self.assertTrue(attempts[1]["response"] and attempts[2]["response"])
        self.assertNotEqual(attempts[1]["response"], attempts[2]["response"])

    def test_current_override_is_available_without_any_history(self):
        c, g = self.case("current_input_override")
        c["observations"] = []
        view = dataset.export_case(c, self.family)
        self.assertIn("10分钟", view["current"]["request"])
        self.assertIn("不要展示答案", view["current"]["request"])
        self.assertFalse(g["expected_history_dependency"])

    def test_provenance_never_claims_real_student_or_product_assessment(self):
        for pattern in dataset.PATTERNS:
            c, g = self.case(pattern)
            self.assertEqual(g["teacher_review"]["status"], "pending")
            for e in c["observations"]:
                self.assertEqual(e["provenance"], "authored_synthetic_observation_not_product_event")
                if e["kind"] == "assessment_observation":
                    self.assertEqual(e["payload"]["assessment_status"], "scripted_fixture_not_live_assessment")

    def test_temporal_pair_changes_validity_and_preserves_current_request(self):
        a, ag = self.case("temporary_constraint_active")
        b, bg = self.case("temporary_constraint_expired")
        self.assertEqual(a["current"], b["current"])
        self.assertGreater(a["observations"][-1]["payload"]["valid_until"], a["current"]["at"])
        self.assertLess(b["observations"][-1]["payload"]["valid_until"], b["current"]["at"])
        self.assertIn("active_constraints", ag)
        self.assertNotIn("active_constraints", bg)

    def test_long_history_really_separates_old_anchor_from_current_request(self):
        c, g = self.case("long_history_return")
        anchor = next(e for e in c["observations"] if e["kind"] == "task_paused")
        self.assertIn(anchor["id"], g["evidence_refs"])
        self.assertNotIn(self.family["return_anchor"], c["current"]["request"])
        self.assertGreaterEqual(sum(e["kind"] == "resource_view" and e["occurred_at"] > anchor["occurred_at"] for e in c["observations"]), 64)

    def test_family_split_contains_every_probe_and_history(self):
        splits = dataset.assign_splits(self.families)
        self.assertEqual(len(splits), 72)
        for domain in dataset.DOMAINS:
            counts = dataset.Counter(splits[f["family_id"]] for f in self.families if f["domain"] == domain)
            self.assertEqual(counts, {"development": 5, "validation": 1, "holdout": 2})

    def test_build_is_byte_reproducible(self):
        import shutil
        with tempfile.TemporaryDirectory(prefix="learnflow-dataset-test-") as d:
            root = Path(d)
            shutil.copytree(dataset.ROOT / "catalog", root / "catalog")
            dataset.materialize(root)
            first = {p.name: p.read_bytes() for p in (root / "data").iterdir()}
            dataset.materialize(root)
            self.assertEqual(first, {p.name: p.read_bytes() for p in (root / "data").iterdir()})


if __name__ == "__main__":
    unittest.main()
