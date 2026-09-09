"""Pure-data calibration for a post-hoc auditor, never real learner evidence."""
import copy
import gzip
import hashlib
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
                      "learning_episodes": [], "retrieval_diagnostics": {"episodes": {"budget_omitted": 1}}},
           "plan": {"teaching_decisions": [{"action": "independent_variant_or_reasoning_check", "source_event_ids": [1]}]}}
    deliver_episode(state, row, 1)
    return state, row


def deliver_episode(state, row, event_id):
    """A selected episode must carry the actual receipt, observation and closure."""
    event = next(e for e in state["events"] if e["id"] == event_id)
    attempt = next(a for a in state["attempts"] if a["id"] == event["payload"]["attempt_id"])
    facts = [f for f in state["facts"] if f["event_id"] == event_id]
    observations = []
    for fact in facts:
        text = state["source_nodes"][str(fact["id"])]["text"]
        observations.append({"fact_id": fact["id"], "kernel": fact["kernel"], "text": text,
            "source_event_id": event_id, "source_mutation_id": fact["mutation_id"],
            "source_text": {"sha256": hashlib.sha256(text.encode()).hexdigest(), "chars": len(text), "ranges": [[0, len(text)]]}})
    row["packet"]["learning_episodes"] = [{"schema_version": "learnflow.learning-episode.v1",
        "attempt_id": attempt["id"], "occurred_at": event["occurred_at"],
        "scope": {k: event.get(k) for k in ("learner_id", "project_id", "checkpoint_id", "session_id")},
        "task": {"item_type": attempt["item_type"], "item_id": attempt["item_id"],
                 "attempt_kind": attempt["attempt_role"], "canonical_item_id": None},
        "outcome": {"correct": event["payload"].get("correct", event["payload"].get("passed")),
                    "assistance_level": event["payload"].get("assistance_level"),
                    "independent": event["payload"].get("independent")},
        "source_event_ids": [event_id], "source_mutation_ids": [f["mutation_id"] for f in facts],
        "source_fact_ids": [f["id"] for f in facts], "anchor_fact_ids": [facts[0]["id"]], "observations": observations}]


def deliver_guidance(state, row, event_id, version="teaching-guidance.v2"):
    event = next(e for e in state["events"] if e["id"] == event_id)
    scope = {k: event.get(k) for k in ("project_id", "checkpoint_id", "session_id")}
    guidance = {"kernel": "practice", "slot": "practice_feedback", "source_event_id": event_id,
                "policy_version": version, "status": "active", "lifetime": "task",
                "evidence_kind": "supported_success", "instruction": "先撤提示再独立验证",
                "scope": scope, "occurred_at": event["occurred_at"], "expires_at": "2026-03-02T18:00:00Z",
                "item_key": "concept:10"}
    if version == "teaching-guidance.v2":
        guidance.update(source_scope=scope.copy(), application_scope=scope.copy())
    row["packet"].update(learning_episodes=[], teaching_guidance=[guidance])


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
        deliver_episode(state, row, 2)
        self.assertEqual(result(state, row)["status"], "pass")

    def test_same_timestamp_uses_event_id_not_list_order(self):
        state, row = fixture(); state["events"][0]["occurred_at"] = state["events"][1]["occurred_at"]
        deliver_episode(state, row, 1)
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

    def test_latest_formation_only_source_is_invalid_even_when_action_exists(self):
        for packet in ([], None):
            state, row = fixture()
            row["plan"]["teaching_decisions"][0].update(action="fade_support_then_independent_probe", source_event_ids=[2])
            # The old pass fixture delivered only Event 1 while the decision cited Event 2.
            if packet is not None:
                row["packet"]["learning_episodes"] = packet
            value = result(state, row)
            self.assertEqual(value["status"], "invalid")
            self.assertIsNone(value["freshness_passed"])
            self.assertEqual(value["reason"], "decision_source_not_delivered_by_valid_packet_projection")
            group = audit.summarize([value])[0]
            self.assertEqual(group["freshness_denominator"], 0)
            self.assertIsNone(group["freshness_pass_rate"])

    def test_transient_facts_require_current_session_but_active_facts_can_cross(self):
        for status, event_session, expected in (("transient", 99, "fail"), ("transient", None, "fail"),
                                                ("transient", 4, "pass"), ("active", 99, "pass")):
            with self.subTest(status=status, session=event_session):
                state, row = fixture()
                state["events"][1]["session_id"] = event_session
                state["facts"][1]["session_id"] = event_session
                state["source_nodes"]["2"].update(status=status, session_id=event_session)
                reference, error = audit.valid_assessment(state["events"][1], audit.state_indexes(state),
                    row["packet"]["scope"], audit.timestamp(state["events"][-1]["occurred_at"]))
                self.assertEqual(reference is not None, expected == "pass")
                if expected == "pass":
                    deliver_episode(state, row, 2)
                    row["plan"]["teaching_decisions"][0].update(action="fade_support_then_independent_probe", source_event_ids=[2])
                    self.assertEqual(result(state, row)["status"], "pass")
                else:
                    self.assertEqual(error, "no_current_valid_fact_chain")
                    value = result(state, row)
                    self.assertEqual(value["latest_applicable_assessment"]["event_id"], 1)
                    self.assertEqual(value["status"], "pass")

    def test_forged_selected_closure_or_outcome_never_supplies_delivery(self):
        edits = [lambda e: e["observations"][0].update(source_event_id=1),
                 lambda e: e["observations"][0].update(source_mutation_id=1),
                 lambda e: e["observations"][0].update(text="fabricated visible content"),
                 lambda e: e["observations"][0]["source_text"].update(sha256="wrong"),
                 lambda e: e.update(source_fact_ids=[1]), lambda e: e.update(observations=[]),
                 lambda e: e["outcome"].update(correct=False),
                 lambda e: e["scope"].update(checkpoint_id=99),
                 lambda e: e.update(occurred_at="2026-03-02T12:00:00Z"),
                 lambda e: e["task"].update(item_id=99)]
        for edit in edits:
            state, row = fixture(); deliver_episode(state, row, 2)
            row["plan"]["teaching_decisions"][0]["source_event_ids"] = [2]
            edit(row["packet"]["learning_episodes"][0])
            value = result(state, row)
            self.assertEqual(value["status"], "invalid")
            self.assertTrue(value["delivery_projection_errors"])

    def test_guidance_can_supply_valid_delivery_without_episode(self):
        for version in ("teaching-guidance.v1", "teaching-guidance.v2"):
            state, row = fixture(); deliver_guidance(state, row, 2, version)
            row["plan"]["teaching_decisions"][0].update(action="fade_support_then_independent_probe", source_event_ids=[2])
            value = result(state, row)
            self.assertEqual(value["status"], "pass")
            self.assertEqual(value["delivered_assessment_event_ids"], [2])
            self.assertEqual(value["packet_episode_count"], 0)

    def test_valid_clipped_excerpt_and_omitted_candidate_anchor_keep_delivery(self):
        state, row = fixture()
        fact = copy.deepcopy(state["facts"][1]); fact.update(id=4, mutation_id=4)
        state["facts"].append(fact)
        mutation = copy.deepcopy(state["mutations"][1]); mutation["id"] = 4
        state["mutations"].append(mutation)
        state["source_nodes"]["4"] = copy.deepcopy(state["source_nodes"]["2"])
        deliver_episode(state, row, 2)
        episode = row["packet"]["learning_episodes"][0]
        episode.update(anchor_fact_ids=[2, 4], source_fact_ids=[2], source_mutation_ids=[2])
        episode["observations"] = episode["observations"][:1]
        observation = episode["observations"][0]
        observation["text"] = observation["text"][:6]
        observation["source_text"]["ranges"] = [[0, 6]]
        row["plan"]["teaching_decisions"][0]["source_event_ids"] = [2]
        self.assertEqual(result(state, row)["status"], "pass")
        episode["anchor_fact_ids"].append(1)
        self.assertEqual(result(state, row)["status"], "invalid")

    def test_cancelled_expired_foreign_or_wrong_slot_guidance_is_not_delivery(self):
        edits = [lambda g: g.update(cancelled=True), lambda g: g.update(status="superseded"),
                 lambda g: g.update(expires_at="2026-03-02T10:30:00Z"),
                 lambda g: g.update(lifetime="persistent", expires_at=None),
                 lambda g: g.update(slot="current_blocker"), lambda g: g.update(item_key="concept:99"),
                 lambda g: g["application_scope"].update(session_id=99),
                 lambda g: g["source_scope"].update(project_id=99)]
        for edit in edits:
            state, row = fixture(); deliver_guidance(state, row, 2)
            row["plan"]["teaching_decisions"][0]["source_event_ids"] = [2]
            edit(row["packet"]["teaching_guidance"][0])
            self.assertEqual(result(state, row)["status"], "invalid")

    def test_unrelated_current_control_does_not_count_as_assessment_delivery(self):
        state, row = fixture(); deliver_guidance(state, row, 2)
        row["packet"]["teaching_guidance"][0].update(kernel="human", slot="time_budget", source_event_id=3)
        row["plan"]["teaching_decisions"][0]["source_event_ids"] = [2]
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
