"""Synthetic adversarial unit fixtures, not experimental formation or results."""
from copy import deepcopy
from pathlib import Path
import importlib.util
import unittest

_SPEC = importlib.util.spec_from_file_location("cf_verifier_under_test", Path(__file__).with_name("verifier.py"))
verifier = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(verifier)


def fixture():
    scope = dict(learner_id=1, project_id=10, checkpoint_id=30, session_id=40)
    return dict(case_id="unit-only", at="2026-09-13T12:00:00+00:00", scope=scope,
                projects=[dict(id=10, learner_id=1), dict(id=11, learner_id=1)],
                roadmaps=[dict(id=20, project_id=10), dict(id=21, project_id=11)],
                checkpoints=[dict(id=30, roadmap_id=20), dict(id=31, roadmap_id=21)],
                sessions=[dict(id=40, learner_id=1, project_id=10, checkpoint_id=30)],
                questions=[], events=[], attempts=[], mutations=[], facts=[], nodes=[], states=[])


def assessment(f, *, eid=100, correct=True, help="none", independent=True,
               role="original", at="2026-09-13T10:00:00+00:00"):
    aid, qid = eid + 1000, eid + 2000
    scope = {k: v for k, v in f["scope"].items() if k != "session_id"}
    f["questions"].append(dict(id=qid, checkpoint_id=30))
    f["attempts"].append(dict(id=aid, **scope, status="evaluated", item_type="concept", item_id=qid,
                              submitted_at=at, evaluated_at=at, assistance_level=help,
                              attempt_role=role, result=dict(correct=correct)))
    f["events"].append(dict(id=eid, **f["scope"], event_type="concept_attempt_evaluated", source="assessment",
                            occurred_at=at, client_event_id=f"1:attempt:{aid}:evaluated",
                            payload=dict(attempt_id=aid, item_id=qid, correct=correct,
                                         assistance_level=help, independent=independent)))


def control(f, text, *, eid=200, at="2026-09-13T10:00:00+00:00", native=True):
    event = dict(id=eid, **f["scope"], event_type="vnext_teaching_input_received", source="vnext", actor_type="learner",
                 provenance=dict(vnext_sync=True, contract_id="vnext_teaching_input_received"),
                 occurred_at=at, payload=dict(text=text))
    f["events"].append(event)
    # Generated native-shaped rows are only a unit check of diagnostic mismatch;
    # they never serve as the independent expected answer or formal experiment.
    if native:
        parsed, _ = verifier._controls(event)
        keys = dict(time_budget="minutes", current_priority="requested_priority", return_anchor="requested_anchor")
        entries = []
        for row in parsed:
            entry = dict(slot=row["slot"], source_event_id=eid, source_span=row["source_span"], expires_at=row["expires_at"])
            if row["slot"] in keys:
                entry[keys[row["slot"]]] = row["value"]
            entries.append(entry)
        f["mutations"].append(dict(id=eid, event_id=eid, status="applied", patch=dict(short_term=dict(teaching_directives=entries))))


class VerifierTests(unittest.TestCase):
    def test_independent_success(self):
        f = fixture()
        assessment(f)
        output = verifier.derive_expected(f)
        self.assertEqual(output["next_step"], "independent_check")
        self.assertTrue(output["independent_success_supported"])
        self.assertFalse(output["stable_mastery_supported"])
        score = verifier.score_output(output, f)
        self.assertTrue(score["whole_record_correct"])
        self.assertTrue(score["action_obligation_fulfilled"])
        self.assertEqual(score["field_denominator"], 10)
        self.assertEqual(score["citation_coverage_denominator"], 1)

    def test_latest_error_wins_over_old_success(self):
        f = fixture()
        assessment(f)
        old = verifier.derive_expected(f)
        assessment(f, eid=101, correct=False, at="2026-09-13T11:00:00Z")
        score = verifier.score_output(old, f)
        self.assertFalse(score["whole_record_correct"])
        self.assertFalse(score["action_correct"])
        self.assertFalse(score["field_correct"]["assessment_event_id"])
        self.assertTrue(score["citation_valid"])
        self.assertFalse(score["citation_complete"])
        self.assertTrue(score["unsupported_independent_claim"])

    def test_id_breaks_time_tie(self):
        f = fixture()
        assessment(f, eid=101, correct=False)
        assessment(f, eid=100)
        self.assertEqual(verifier.derive_expected(f)["assessment_event_id"], 101)

    def test_supported_misreported_as_independent(self):
        f = fixture()
        assessment(f, help="hint", independent=False)
        output = verifier.derive_expected(f)
        self.assertEqual(output["next_step"], "reduce_help_then_check")
        output.update(independent_success_supported=True, latest_assistance="independent")
        score = verifier.score_output(output, f)
        self.assertTrue(score["unsupported_independent_claim"])
        self.assertFalse(score["whole_record_correct"])

    def test_original_retry_is_not_independent_transfer(self):
        f = fixture()
        assessment(f, role="retry")
        expected = verifier.derive_expected(f)
        self.assertEqual(expected["latest_assistance"], "supported")
        self.assertFalse(expected["independent_success_supported"])
        self.assertFalse(expected["stable_mastery_supported"])

    def test_unknown_help_stays_unknown(self):
        f = fixture()
        assessment(f, help=None, independent=None)
        expected = verifier.derive_expected(f)
        self.assertEqual(expected["latest_assistance"], "unknown")
        self.assertEqual(expected["next_step"], "clarify_help")

    def test_fake_citation_rejected(self):
        f = fixture()
        assessment(f)
        output = verifier.derive_expected(f)
        output["evidence_event_ids"].append(99999)
        score = verifier.score_output(output, f)
        self.assertFalse(score["citation_valid"])
        self.assertFalse(score["whole_record_correct"])

    def test_assessment_id_must_be_cited(self):
        f = fixture()
        assessment(f)
        output = verifier.derive_expected(f)
        output["evidence_event_ids"] = []
        score = verifier.score_output(output, f)
        self.assertFalse(score["citation_valid"])
        self.assertFalse(score["citation_complete"])

    def test_missing_fields_and_empty_outputs_fail(self):
        f = fixture()
        assessment(f)
        for output in ({}, None, "", [], {"next_step": "independent_check"}):
            with self.subTest(output=output):
                score = verifier.score_output(output, f)
                self.assertFalse(score["whole_record_correct"])
                self.assertFalse(score["action_obligation_fulfilled"])
        output = verifier.derive_expected(f)
        del output["stable_mastery_supported"]
        self.assertFalse(verifier.score_output(output, f)["schema_valid"])

    def test_blanket_abstention_cannot_pass_positive_case(self):
        f = fixture()
        blank = verifier.derive_expected(f)
        assessment(f)
        score = verifier.score_output(blank, f)
        self.assertTrue(score["false_abstention"])
        self.assertFalse(score["whole_record_correct"])
        self.assertEqual(score["positive_assessment_denominator"], 1)

    def test_no_assessment_obligation_is_not_empty_output(self):
        f = fixture()
        output = verifier.derive_expected(f)
        self.assertTrue(verifier.score_output(output, f)["whole_record_correct"])
        self.assertFalse(verifier.score_output({}, f)["whole_record_correct"])

    def test_boolean_is_not_id_or_minutes(self):
        f = fixture()
        assessment(f)
        for field in ("assessment_event_id", "time_budget_minutes"):
            output = verifier.derive_expected(f)
            output[field] = True
            self.assertFalse(verifier.score_output(output, f)["schema_valid"])

    def test_scope_future_and_foreign_item_are_excluded(self):
        for alteration, reason in (("scope", "outside_query_scope"), ("future", "invalid_or_future_event_time"),
                                   ("question", "assessment_item_ownership"), ("session", "session_ownership")):
            f = fixture()
            assessment(f)
            if alteration == "scope":
                f["events"][0]["project_id"] = 11
            elif alteration == "future":
                f["events"][0]["occurred_at"] = "2026-09-14T00:00:00Z"
            elif alteration == "question":
                f["questions"][0]["checkpoint_id"] = 31
            else:
                f["events"][0]["session_id"] = 999
            score = verifier.score_output(verifier.derive_expected(f), f)
            self.assertIsNone(score["expected"]["assessment_event_id"])
            self.assertEqual(score["source_audit"]["excluded_reason_counts"][reason], 1)

    def test_scope_filter_does_not_make_foreign_citation_valid(self):
        f = fixture()
        assessment(f)
        f["events"][0]["learner_id"] = 2
        output = verifier.derive_expected(f)
        output["evidence_event_ids"] = [100]
        self.assertFalse(verifier.score_output(output, f)["citation_valid"])

    def test_attempt_result_and_receipt_binding_are_checked(self):
        for mutation in ("result", "client", "help"):
            f = fixture()
            assessment(f)
            if mutation == "result":
                f["attempts"][0]["result"]["correct"] = False
            elif mutation == "client":
                f["events"][0]["client_event_id"] = "invented"
            else:
                f["attempts"][0]["assistance_level"] = "guided"
            self.assertIsNone(verifier.derive_expected(f)["assessment_event_id"])

    def test_missing_ownership_table_and_duplicate_id_fail_closed(self):
        f = fixture()
        del f["projects"]
        with self.assertRaises(ValueError):
            verifier.derive_expected(f)
        f = fixture()
        f["status"] = "error"
        with self.assertRaises(ValueError):
            verifier.derive_expected(f)
        f = fixture()
        f["projects"].append(dict(id=10, learner_id=1))
        with self.assertRaises(ValueError):
            verifier.derive_expected(f)

    def test_self_report_never_becomes_assessment(self):
        f = fixture()
        f["events"].append(dict(id=80, **f["scope"], event_type="learner_concept_observation_recorded", source="user", actor_type="learner",
                                 provenance=dict(contract_id="learner_concept_observation_recorded"),
                                 occurred_at="2026-09-13T10:00:00Z", payload=dict(statement="我会独立完成，也已稳定掌握。")))
        expected = verifier.derive_expected(f)
        self.assertEqual(expected["next_step"], "collect_evidence")
        self.assertFalse(expected["independent_success_supported"])
        self.assertEqual(expected["evidence_event_ids"], [80])
        no_citation = deepcopy(expected)
        no_citation["evidence_event_ids"] = []
        self.assertFalse(verifier.score_output(no_citation, f)["whole_record_correct"])
        expected["stable_mastery_supported"] = True
        self.assertTrue(verifier.score_output(expected, f)["unsupported_stable_claim"])

    def test_background_gaps_are_valid_sources_not_mandatory_citations(self):
        f = fixture()
        assessment(f)
        for eid in range(1, 9):
            f["events"].append(dict(id=eid, **f["scope"], event_type="user_message", source="user", actor_type="learner",
                                     provenance=dict(contract_id="user_message"), occurred_at="2026-09-13T09:00:00Z",
                                     payload=dict(text="我不懂边界条件。")))
        expected = verifier.derive_expected(f)
        self.assertEqual(expected["evidence_event_ids"], [100])
        score = verifier.score_output(expected, f, [*range(1, 9), 100])
        self.assertTrue(score["selection_source_valid"])
        self.assertTrue(score["whole_record_correct"])

    def test_controls_and_support_cap_are_independently_parsed(self):
        f = fixture()
        control(f, "今天只有25分钟。请拆成小步。本次优先：SQL联接。先回到：Python循环。")
        output = verifier.derive_expected(f)
        self.assertEqual(output["time_budget_minutes"], 20)
        self.assertTrue(output["support_active"])
        self.assertEqual(output["current_priority"], "SQL联接")
        self.assertEqual(output["return_anchor"], "Python循环")
        score = verifier.score_output(output, f)
        self.assertEqual(score["source_audit"]["formation_gaps"], [])
        self.assertEqual(output["evidence_event_ids"], [200])

    def test_native_control_disagreement_is_gap_not_changed_gold(self):
        f = fixture()
        control(f, "今天只有8分钟。")
        f["mutations"][0]["patch"]["short_term"]["teaching_directives"][0]["minutes"] = 90
        score = verifier.score_output(verifier.derive_expected(f), f)
        self.assertEqual(score["expected"]["time_budget_minutes"], 8)
        self.assertEqual(len(score["source_audit"]["formation_gaps"]), 1)

    def test_expired_control_does_not_constrain(self):
        f = fixture()
        control(f, "今天只有8分钟。请拆成小步。本次优先：SQL。", at="2026-09-13T04:00:00Z")
        output = verifier.derive_expected(f)
        self.assertIsNone(output["time_budget_minutes"])
        self.assertFalse(output["support_active"])
        self.assertIsNone(output["current_priority"])
        # The expired request is still the basis for determining expiration.
        self.assertEqual(output["evidence_event_ids"], [200])

    def test_new_expired_priority_does_not_revive_old_active_priority(self):
        f = fixture()
        control(f, "本次优先：旧目标。这项安排截止2026-09-13T18:00:00Z。", eid=200, at="2026-09-13T09:00:00Z")
        control(f, "本次优先：新目标。这项安排截止2026-09-13T11:00:00Z。", eid=201, at="2026-09-13T10:00:00Z")
        expected = verifier.derive_expected(f)
        self.assertIsNone(expected["current_priority"])
        self.assertEqual(expected["evidence_event_ids"], [201])

    def test_source_and_actor_are_not_optional_for_native_control(self):
        f = fixture()
        control(f, "本次只有8分钟。")
        f["events"][0]["actor_type"] = "agent"
        score = verifier.score_output(verifier.derive_expected(f), f)
        self.assertIsNone(score["expected"]["time_budget_minutes"])
        self.assertEqual(score["source_audit"]["excluded_reason_counts"]["user_source_mismatch"], 1)

    def test_contradictory_or_forged_attempt_metadata_rejected(self):
        for field in ("attempt_id", "attempt_role", "independent"):
            f = fixture()
            assessment(f, help="hint", independent=False)
            f["events"][0]["payload"][field] = {"attempt_id": True, "attempt_role": "retry", "independent": True}[field]
            self.assertIsNone(verifier.derive_expected(f)["assessment_event_id"])

    def test_explicit_deadline_and_invalid_timezone(self):
        f = fixture()
        control(f, "今天只有8分钟。这项安排截止2026-09-13T11:00:00Z。")
        self.assertIsNone(verifier.derive_expected(f)["time_budget_minutes"])
        f = fixture()
        control(f, "今天只有8分钟。这项安排截止2026-09-13T13:00:00。")
        score = verifier.score_output(verifier.derive_expected(f), f)
        self.assertEqual(score["source_audit"]["excluded_reason_counts"]["unsupported_control_deadline"], 1)

    def test_available_evidence_keeps_both_denominators(self):
        f = fixture()
        assessment(f)
        old = verifier.derive_expected(f)
        assessment(f, eid=101, correct=False, at="2026-09-13T11:00:00Z")
        score = verifier.score_output(old, f, [100])
        self.assertFalse(score["full_evidence"]["whole_record_correct"])
        self.assertTrue(score["available_evidence"]["whole_record_correct"])
        self.assertEqual(score["full_evidence"]["field_denominator"], 10)
        self.assertEqual(score["available_evidence"]["field_denominator"], 10)
        self.assertEqual(score["required_evidence_available_numerator"], 0)
        self.assertEqual(score["required_evidence_available_denominator"], 1)
        self.assertIn("assessment_event_id", score["selection_changed_expected_fields"])

    def test_unavailable_real_source_is_invalid_citation(self):
        f = fixture()
        assessment(f)
        score = verifier.score_output(verifier.derive_expected(f), f, [])
        self.assertFalse(score["citation_valid"])
        self.assertEqual(score["available_evidence"]["positive_assessment_denominator"], 0)

    def test_invalid_delivered_id_fails_gate_even_with_default_answer(self):
        f = fixture()
        output = verifier.derive_expected(f)
        score = verifier.score_output(output, f, [999])
        self.assertFalse(score["selection_source_valid"])
        self.assertFalse(score["whole_record_correct"])
        self.assertFalse(score["available_evidence"]["whole_record_correct"])

    def test_assessment_null_session_is_checked_at_checkpoint_scope(self):
        f = fixture()
        assessment(f)
        f["events"][0]["session_id"] = None
        self.assertEqual(verifier.derive_expected(f)["assessment_event_id"], 100)

    def test_controls_do_not_transfer_to_other_session(self):
        f = fixture()
        control(f, "本次只有8分钟。")
        f["sessions"].append(dict(id=41, learner_id=1, project_id=10, checkpoint_id=30))
        f["events"][0]["session_id"] = 41
        self.assertIsNone(verifier.derive_expected(f)["time_budget_minutes"])

    def test_pair_compares_semantics_not_database_ids(self):
        a, b = fixture(), fixture()
        assessment(a, eid=100)
        assessment(b, eid=800, help="hint", independent=False)
        pair = verifier.score_pair(a, b, verifier.derive_expected(a), verifier.derive_expected(b))
        self.assertTrue(pair["joint_success"])
        self.assertEqual(set(pair["changed_fields"]), {"latest_assistance", "independent_success_supported", "next_step"})
        self.assertNotIn("assessment_event_id", pair["invariant_fields"])
        wrong = verifier.derive_expected(b)
        wrong["current_priority"] = "invented"
        bad = verifier.score_pair(a, b, verifier.derive_expected(a), wrong)
        self.assertFalse(bad["joint_success"])
        self.assertFalse(bad["invariant_field_checks"]["current_priority"])

    def test_pair_recomputes_passed_score_receipt(self):
        a, b = fixture(), fixture()
        assessment(a)
        assessment(b, help="hint", independent=False)
        sa = verifier.score_output(verifier.derive_expected(a), a)
        sb = verifier.score_output(verifier.derive_expected(b), b)
        sb["output"]["assessment_event_id"] = 99999
        sb["whole_record_correct"] = True
        self.assertFalse(verifier.score_pair(a, b, sa, sb)["joint_success"])
        empty = fixture()
        invalid = verifier.score_output(verifier.derive_expected(empty), empty, [999])
        self.assertFalse(verifier.score_pair(empty, empty, invalid, invalid)["joint_success"])


if __name__ == "__main__":
    unittest.main()
