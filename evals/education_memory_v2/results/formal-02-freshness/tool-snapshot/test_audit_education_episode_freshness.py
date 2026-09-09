"""Pure-data calibration for a post-hoc auditor, never real learner evidence."""
import copy
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("freshness_audit", Path(__file__).with_name("audit_education_episode_freshness.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def fixture():
    scope = {"learner_id": 1, "project_id": 2, "checkpoint_id": 3, "session_id": 4}
    state = {"events": [], "attempts": [], "facts": [], "mutations": [], "source_nodes": {}}
    for identifier, when, help in ((1, "2026-03-02T09:00:00Z", "none"), (2, "2026-03-02T10:00:00Z", "guided")):
        event_scope = {**scope, "session_id": None}
        state["events"].append({"id": identifier, "event_type": "concept_attempt_evaluated", "source": "assessment",
            "client_event_id": f"1:attempt:{identifier}:evaluated", "occurred_at": when, **event_scope,
            "payload": {"attempt_id": identifier, "item_id": 10, "correct": True,
                        "assistance_level": help, "independent": help == "none", "explanation": "ANSWER_SECRET"}})
        state["attempts"].append({"id": identifier, "item_type": "concept", "item_id": 10,
            "status": "evaluated", "result": {"correct": True, "explanation": "ANSWER_SECRET"}, "assistance_level": help,
            "attempt_role": "original" if identifier == 1 else "retry", "submitted_at": when, "evaluated_at": when, **scope})
        state["mutations"].append({"id": identifier, "event_id": identifier, "kernel": "practice", "status": "applied", "learner_id": 1})
        state["facts"].append({"id": identifier, "event_id": identifier, "mutation_id": identifier, "kernel": "practice",
            "project_id": 2, "checkpoint_id": 3, "session_id": None, "text": "ANSWER_SECRET"})
        state["source_nodes"][str(identifier)] = {"node_type": "fact", "kernel": "practice", "status": "active", "text": "ANSWER_SECRET", **event_scope}
    state["events"].append({"id": 3, "event_type": "vnext_teaching_input_received", "source": "vnext",
        "client_event_id": "1:current-case-1", "occurred_at": "2026-03-02T11:00:00Z", "payload": {"text": "QUESTION_SECRET"}, **scope})
    row = {"case_id": "case-1", "family_id": "family-1", "domain": "programming", "pattern": "repeated_original",
           "split": "development", "variant": "full", "budget": 1800, "repeat": 0,
           "packet": {"scope": {"mode": "checkpoint", **scope}, "manifest": {"query_plan": {"temporal": "current"}},
                      "learning_episodes": [{"source_event_ids": [1]}], "retrieval_diagnostics": {"episodes": {"budget_omitted": 1}}},
           "plan": {"teaching_decisions": [{"action": "independent_variant_or_reasoning_check", "source_event_ids": [1]}]}}
    return state, row


def result(state, row):
    return audit.audit_condition(row, audit.state_indexes(state))


class FreshnessTests(unittest.TestCase):
    def test_old_independent_success_cannot_replace_latest_guided_retry(self):
        state, row = fixture(); value = result(state, row)
        self.assertEqual(value["status"], "fail")
        self.assertTrue(value["stale_event_reference"])
        self.assertTrue(value["action_differs_from_latest_assessment"])
        self.assertEqual(value["latest_applicable_assessment"]["event_id"], 2)

    def test_latest_actual_event_passes(self):
        state, row = fixture()
        row["plan"]["teaching_decisions"][0].update(action="fade_support_then_independent_probe", source_event_ids=[2])
        self.assertEqual(result(state, row)["status"], "pass")

    def test_same_timestamp_uses_event_id_not_list_order(self):
        state, row = fixture(); state["events"][0]["occurred_at"] = state["events"][1]["occurred_at"]
        state["events"].reverse()
        self.assertEqual(result(state, row)["latest_applicable_assessment"]["event_id"], 2)
        self.assertEqual(result(state, row)["status"], "fail")

    def test_old_source_is_stale_even_when_action_type_matches(self):
        state, row = fixture()
        state["events"][1]["payload"].update(assistance_level="none", independent=True)
        state["attempts"][1].update(assistance_level="none", attempt_role="original")
        value = result(state, row)
        self.assertTrue(value["stale_event_reference"])
        self.assertFalse(value["action_differs_from_latest_assessment"])

    def test_no_actual_assessment_action_is_na(self):
        state, row = fixture(); row["plan"]["teaching_decisions"] = [{"action": "limit_session", "source_event_ids": [3]}]
        self.assertIsNone(result(state, row)["freshness_passed"])
        self.assertEqual(result(state, row)["reason"], "no_actual_assessment_feedback_action")

    def test_no_applicable_scope_is_na(self):
        state, row = fixture()
        for e in state["events"][:2]:
            e["checkpoint_id"] = 99
        self.assertEqual(result(state, row)["reason"], "no_valid_assessment_applicable_to_query")

    def test_later_foreign_evidence_does_not_replace_scoped_reference(self):
        state, row = fixture(); state["events"][1]["learner_id"] = 99
        value = result(state, row)
        self.assertEqual(value["status"], "pass")
        self.assertEqual(value["latest_applicable_assessment"]["event_id"], 1)
        self.assertEqual(value["excluded_assessments"]["outside_query_scope"], 1)

    def test_historical_or_project_query_is_na(self):
        for patch in ("historical", "project"):
            state, row = fixture()
            if patch == "historical": row["packet"]["manifest"]["query_plan"]["temporal"] = "earliest"
            else: row["packet"]["scope"].update(mode="project", checkpoint_id=None)
            self.assertIsNone(result(state, row)["freshness_passed"])

    def test_future_event_is_not_available_at_query(self):
        state, row = fixture(); state["events"][1]["occurred_at"] = "2026-03-02T12:00:00Z"
        self.assertEqual(result(state, row)["latest_applicable_assessment"]["event_id"], 1)

    def test_query_time_must_come_from_unique_owned_receipt(self):
        for edit in (lambda s: s["events"][-1].update(client_event_id="other"),
                     lambda s: s["events"][-1].update(session_id=99),
                     lambda s: s["events"][-1].update(occurred_at="bad")):
            state, row = fixture(); edit(state)
            self.assertEqual(result(state, row)["reason"], "missing_unique_current_input_time_receipt")

    def test_receipt_attempt_result_and_fact_chain_are_required(self):
        edits = [lambda s: s["events"][1].update(client_event_id="fabricated"),
                 lambda s: s["attempts"][1]["result"].update(correct=False),
                 lambda s: s["attempts"][1].update(evaluated_at="2026-03-02T08:00:00Z"),
                 lambda s: s["facts"][1].update(session_id=99),
                 lambda s: s["mutations"][1].update(status="rejected"),
                 lambda s: s["source_nodes"]["2"].update(status="archived")]
        for edit in edits:
            state, row = fixture(); edit(state)
            self.assertEqual(result(state, row)["latest_applicable_assessment"]["event_id"], 1)

    def test_missing_independence_remains_unknown(self):
        state, row = fixture(); e=state["events"][1]; e["payload"].update(assistance_level=None); e["payload"].pop("independent")
        state["attempts"][1]["attempt_role"] = "original"
        reference = result(state, row)["latest_applicable_assessment"]
        self.assertIsNone(reference["outcome"]["independent"])
        self.assertEqual(reference["reference_action"], "clarify_assistance")

    def test_exercise_result_requires_actual_pass_counts(self):
        state, row = fixture(); e=state["events"][1]
        e["event_type"]="exercise_attempt_evaluated"; e["payload"]["passed"]=e["payload"].pop("correct")
        state["attempts"][1].update(item_type="exercise", result={"passed": 2, "total": 2})
        self.assertEqual(result(state, row)["latest_applicable_assessment"]["event_id"], 2)
        state["attempts"][1]["result"]["passed"] = 1
        self.assertEqual(result(state, row)["latest_applicable_assessment"]["event_id"], 1)

    def test_invalid_selected_receipt_does_not_pass_freshness(self):
        state, row = fixture(); row["plan"]["teaching_decisions"][0]["source_event_ids"] = [99]
        self.assertEqual(result(state, row)["status"], "invalid")

    def test_boolean_ids_cannot_impersonate_integer_ids(self):
        state, row = fixture()
        state["events"][1]["payload"]["attempt_id"] = True
        value = result(state, row)
        self.assertEqual(value["excluded_assessments"]["invalid_attempt_id"], 1)
        state, row = fixture(); state["events"][-1]["learner_id"] = True
        self.assertEqual(result(state, row)["reason"], "missing_unique_current_input_time_receipt")

    def test_duplicate_snapshot_ids_are_rejected(self):
        state, row = fixture(); state["events"].append(copy.deepcopy(state["events"][0]))
        with self.assertRaises(ValueError): result(state, row)

    def test_output_has_hashes_issues_and_no_answer_or_question_text(self):
        state, row = fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); raw=root/"raw.jsonl.gz"
            with gzip.open(raw,"wt") as stream:
                stream.write(json.dumps({"case_id":"case-1","kind":"formation","state":state})+"\n")
                stream.write(json.dumps(row)+"\n")
            summary=audit.run_audit([raw],root/"audit")
            self.assertTrue(summary["post_hoc_audit"])
            self.assertEqual(summary["groups"][0]["freshness_denominator"],1)
            self.assertEqual(summary["groups"][0]["stale_references"],1)
            self.assertEqual(summary["raw_sources"][str(raw)]["sha256"],audit.file_hash(raw))
            for path in (root/"audit").iterdir(): self.assertNotIn("SECRET",path.read_text())
            with self.assertRaises(FileExistsError): audit.run_audit([raw],root/"audit")
            with self.assertRaises(ValueError): audit.run_audit([raw,raw],root/"duplicate")


if __name__ == "__main__":
    unittest.main()
