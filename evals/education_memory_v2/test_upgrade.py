"""Adversarial calibration: independently fabricated fixtures are NOT learners."""
import copy
from dataclasses import dataclass, asdict
import hashlib
import unittest

from components import COMPONENT_VARIANTS, activation_metrics, packet_tokens, policy_for
from education_verifier import verify_trial
from projection_checks import verify_read_projections, verify_component_intervention
from test_education import trial, checks, restamp


def episode_fixture():
    packet, plan, case, rubric, evidence = trial()
    case.update(current={"at": "2026-03-02T10:00:00Z"})
    scope = {**case["_scope"], "session_id": 11}
    case["_scope"] = scope
    text = packet["items"][0]["text"]
    packet["items"] = []
    packet["_source_events"][1] = {"id": 1, "event_type": "concept_attempt_evaluated", "source": "assessment", "client_event_id": "8:attempt:2:evaluated",
        "payload": {"attempt_id": 2, "item_id": 7, "correct": True, "assistance_level": "hint", "independent": False},
        "occurred_at": "2026-03-02T09:00:00Z", **scope}
    packet["_source_nodes"][5].update(scope)
    packet["_source_nodes"][5].update(kernel="knowledge", node_type="fact")
    packet["_source_attempts"] = {2: {"id": 2, "item_type": "concept", "item_id": 7,
        "result": {"correct": True}, "assistance_level": "hint", "status": "evaluated", "attempt_role": "original",
        "submitted_at": "2026-03-02T08:59:00Z", "evaluated_at": "2026-03-02T09:00:00Z", **scope}}
    packet["_source_mutations"] = {3: {"id": 3, "event_id": 1, "kernel": "knowledge", "status": "applied", "learner_id": 8}}
    packet["_source_facts"] = {5: {"id": 5, "event_id": 1, "mutation_id": 3, "kernel": "knowledge", "project_id": 9, "checkpoint_id": 10, "session_id": 11}}
    packet["learning_episodes"] = [{"schema_version": "learnflow.learning-episode.v1", "attempt_id": 2,
        "task": {"item_type": "concept", "item_id": 7, "canonical_item_id": None, "attempt_kind": "original"},
        "outcome": {"correct": True, "assistance_level": "hint", "independent": False}, "scope": scope,
        "occurred_at": "2026-03-02T09:00:00Z", "source_event_ids": [1], "source_mutation_ids": [3], "source_fact_ids": [5],
        "observations": [{"fact_id": 5, "kernel": "knowledge", "text": text, "source_event_id": 1,
                          "source_mutation_id": 3, "source_text": {"sha256": hashlib.sha256(text.encode()).hexdigest(),
                                                                    "chars": len(text), "ranges": [[0, len(text)]]}}],
        "limitations": ["read_only_assessment_episode_not_mastery"]}]
    plan["teaching_decisions"] = [{"action": "fade_support_then_independent_probe", "policy_version": "learning-plan-guidance.v2",
                                  "source_event_ids": [1], "uncertainties": ["stable_mastery_not_established"], "mastery_inference": False}]
    restamp(packet)
    return packet, plan, case, rubric, evidence


def guidance_fixture():
    packet, plan, case, rubric, evidence = trial()
    case.update(current={"at": "2026-03-03T10:00:00Z"})
    source = {"project_id": 9, "checkpoint_id": 10, "session_id": 11}
    application = {**source, "session_id": None}
    case["_scope"]["session_id"] = 12
    text = "在本项目内到2026-03-04T09:00:00Z为止，我只有10分钟。"
    packet["_source_events"][9] = {"id": 9, "event_type": "vnext_teaching_input_received", "payload": {"text": text},
                                  "occurred_at": "2026-03-02T09:00:00Z", "learner_id": 8, **source}
    packet["teaching_guidance"] = [{"kernel": "human", "slot": "time_budget", "minutes": 10,
        "instruction": "限制本次会话时间。", "source_event_id": 9, "policy_version": "teaching-guidance.v2",
        "parser_version": "teaching-guidance-parser.v2", "source_scope": source, "application_scope": application,
        "scope": application, "source_span": [0, len(text)], "occurred_at": "2026-03-02T09:00:00Z",
        "expires_at": "2026-03-04T09:00:00Z", "lifetime": "project_window", "status": "active", "expiry_basis": "explicit_timezone_iso"}]
    plan["teaching_decisions"] = [{"action": "limit_session", "policy_version": "learning-plan-guidance.v2",
                                   "source_event_ids": [9], "uncertainties": [], "mastery_inference": False}]
    restamp(packet)
    return packet, plan, case, rubric, evidence


class UpgradeVerifierTests(unittest.TestCase):
    def test_episode_body_counts_as_actual_evidence_delivery(self):
        result = checks(verify_trial(*episode_fixture()))
        for name in ("episode_source_chain", "source_excerpts", "source_fact_evidence_delivered", "teaching_decision_source_trace", "budget"):
            self.assertTrue(result[name]["passed"], result[name])

    def test_missing_or_forged_chain_fails(self):
        edits = [lambda p: p["_source_attempts"].clear(),
                 lambda p: p["_source_mutations"][3].update(event_id=99),
                 lambda p: p["_source_mutations"][3].update(status="rejected"),
                 lambda p: p["_source_facts"][5].update(mutation_id=99),
                 lambda p: p["_source_events"][1]["payload"].update(attempt_id=99),
                 lambda p: p["_source_events"][1].update(source="llm"),
                 lambda p: p["_source_attempts"][2].update(item_id=999),
                 lambda p: p["learning_episodes"][0].update(source_fact_ids=[5, 99]),
                 lambda p: p["learning_episodes"][0].update(occurred_at="2026-03-02T10:01:00Z")]
        for edit in edits:
            args = episode_fixture(); edit(args[0]); restamp(args[0])
            self.assertFalse(checks(verify_trial(*args))["episode_source_chain"]["passed"])

    def test_forged_receipt_and_backward_attempt_time_fail(self):
        for edit in (lambda p: p["_source_events"][1].update(client_event_id="unbound"),
                     lambda p: p["_source_attempts"][2].update(submitted_at="2026-03-02T09:30:00Z")):
            args = episode_fixture(); edit(args[0])
            self.assertFalse(checks(verify_trial(*args))["episode_source_chain"]["passed"])

    def test_scope_cannot_be_forged(self):
        for field in ("learner_id", "project_id", "checkpoint_id", "session_id"):
            args = episode_fixture(); args[0]["_source_nodes"][5][field] = 999
            self.assertFalse(checks(verify_trial(*args))["episode_source_chain"]["passed"])

    def test_assistance_and_independence_cannot_be_upgraded(self):
        for patch in ({"assistance_level": "none"}, {"independent": True}, {"correct": False}):
            args = episode_fixture(); args[0]["learning_episodes"][0]["outcome"].update(patch)
            self.assertFalse(checks(verify_trial(*args))["episode_source_chain"]["passed"])

    def test_unknown_independence_remains_unknown(self):
        args = episode_fixture()
        args[0]["_source_events"][1]["payload"].pop("independent")
        args[0]["learning_episodes"][0]["outcome"]["independent"] = None
        self.assertTrue(checks(verify_trial(*args))["episode_source_chain"]["passed"])

    def test_answer_fields_rejected(self):
        args = episode_fixture(); args[0]["learning_episodes"][0]["observations"][0]["correct_answer"] = "secret"
        self.assertFalse(checks(verify_trial(*args))["episode_source_chain"]["passed"])

    def test_forged_decision_cannot_use_existing_but_undelivered_event(self):
        args = episode_fixture()
        args[0]["_source_events"][99] = {"id": 99}
        args[1]["teaching_decisions"][0]["source_event_ids"] = [99]
        self.assertFalse(checks(verify_trial(*args))["teaching_decision_source_trace"]["passed"])

    def test_mastery_claim_in_decision_fails(self):
        args = episode_fixture(); args[1]["teaching_decisions"][0]["mastery_inference"] = True
        self.assertFalse(checks(verify_trial(*args))["teaching_decision_source_trace"]["passed"])

    def test_no_projection_is_not_a_pass(self):
        result = checks(verify_trial(*trial()))
        for name in ("episode_source_chain", "teaching_guidance_scope_source_expiry", "teaching_decision_source_trace"):
            self.assertIsNone(result[name]["passed"])
            self.assertEqual(result[name]["denominator"], 0)

    def test_valid_cross_session_window_is_traceable(self):
        result = checks(verify_trial(*guidance_fixture()))
        self.assertTrue(result["teaching_guidance_scope_source_expiry"]["passed"], result)
        self.assertTrue(result["teaching_decision_source_trace"]["passed"], result)

    def test_expired_far_future_cancelled_wrong_origin_fail(self):
        edits = [lambda g: g.update(expires_at="2026-03-03T10:00:00Z"),
                 lambda g: g.update(expires_at="2026-04-04T09:00:00Z"),
                 lambda g: g["source_scope"].update(session_id=999),
                 lambda g: g.update(source_span=[0, 99999]),
                 lambda g: g.update(policy_version="invented")]
        for edit in edits:
            args = guidance_fixture(); edit(args[0]["teaching_guidance"][0])
            self.assertFalse(checks(verify_trial(*args))["teaching_guidance_scope_source_expiry"]["passed"])

    def test_guidance_owner_is_checked_on_source_event_not_three_key_scope(self):
        args = guidance_fixture()
        self.assertEqual(set(args[0]["teaching_guidance"][0]["scope"]), {"project_id", "checkpoint_id", "session_id"})
        args[0]["_source_events"][9]["learner_id"] = 999
        self.assertFalse(checks(verify_trial(*args))["teaching_guidance_scope_source_expiry"]["passed"])

    def test_project_window_cannot_treat_missing_checkpoint_as_wildcard(self):
        args = guidance_fixture()
        for key in ("source_scope", "application_scope", "scope"):
            args[0]["teaching_guidance"][0][key]["checkpoint_id"] = None
        args[0]["_source_events"][9]["checkpoint_id"] = None
        self.assertFalse(checks(verify_trial(*args))["teaching_guidance_scope_source_expiry"]["passed"])

    def test_explicit_window_requires_timezone_and_expiry_basis(self):
        for patch in ({"occurred_at": "2026-03-02T09:00:00"}, {"expiry_basis": "default_eight_hours"}):
            args = guidance_fixture(); args[0]["teaching_guidance"][0].update(patch)
            self.assertFalse(checks(verify_trial(*args))["teaching_guidance_scope_source_expiry"]["passed"])

    def test_cancelled_tombstone_is_legal_but_not_active_decision_source(self):
        args = guidance_fixture()
        args[0]["teaching_guidance"][0].update(cancelled=True, evidence_kind="explicit_cancellation")
        result = checks(verify_trial(*args))
        self.assertTrue(result["teaching_guidance_scope_source_expiry"]["passed"])
        self.assertFalse(result["teaching_decision_source_trace"]["passed"])

    def test_inherited_cancellation_window_requires_real_earlier_event(self):
        args = guidance_fixture(); row = args[0]["teaching_guidance"][0]
        original = copy.deepcopy(args[0]["_source_events"][9]); original["id"] = 8
        args[0]["_source_events"][8] = original
        args[0]["_source_events"][9].update(occurred_at="2026-03-03T09:00:00Z", payload={"text": "取消本项目的临时时间预算安排"})
        row.update(cancelled=True, evidence_kind="explicit_cancellation", expiry_basis="inherited_cancelled_window",
                   cancelled_window_source_event_id=8, cancelled_window_expires_at=row["expires_at"],
                   occurred_at="2026-03-03T09:00:00Z", source_span=[0, len("取消本项目的临时时间预算安排")])
        args[1]["teaching_decisions"] = []
        self.assertTrue(checks(verify_trial(*args))["teaching_guidance_scope_source_expiry"]["passed"])
        args[0]["_source_events"][8]["learner_id"] = 99
        self.assertFalse(checks(verify_trial(*args))["teaching_guidance_scope_source_expiry"]["passed"])

    def test_fact_scope_is_checked_in_addition_to_node_scope(self):
        args = episode_fixture(); args[0]["_source_facts"][5]["session_id"] = 999
        self.assertFalse(checks(verify_trial(*args))["episode_source_chain"]["passed"])

    def test_exercise_boolean_result_requires_real_attempt_pass_counts(self):
        args = episode_fixture()
        args[0]["_source_attempts"][2].update(item_type="exercise", result={"passed": 2, "total": 2})
        args[0]["learning_episodes"][0]["task"]["item_type"] = "exercise"
        event = args[0]["_source_events"][1]; event["event_type"] = "exercise_attempt_evaluated"
        event["payload"].pop("correct"); event["payload"]["passed"] = True
        self.assertTrue(checks(verify_trial(*args))["episode_source_chain"]["passed"])
        args[0]["_source_attempts"][2]["result"]["passed"] = 1
        self.assertFalse(checks(verify_trial(*args))["episode_source_chain"]["passed"])

    def test_omitted_new_budget_fields_detected(self):
        for name, value in (("learning_episodes", [{"text": "x" * 100}]),
                            ("retrieval_diagnostics", {"additional": "x" * 100})):
            args = trial(); args[0][name] = value
            self.assertFalse(checks(verify_trial(*args))["budget"]["passed"])
        args = trial(); args[0]["manifest"]["policy"] = {
            key: False for key in ("enable_episodes", "enable_bm25", "enable_aliases", "enable_fuzzy",
                                   "enable_temporal", "enable_summary_boost")}
        self.assertFalse(checks(verify_trial(*args))["budget"]["passed"])

    def test_driver_estimate_matches_independent_verifier_with_new_fields(self):
        args = episode_fixture(); args[0]["retrieval_diagnostics"] = {"episodes": {"selected": 1}}
        args[0]["manifest"]["token_estimate"] = packet_tokens(args[0])
        self.assertTrue(checks(verify_trial(*args))["budget"]["passed"])


class ComponentTests(unittest.TestCase):
    def test_missing_activation_is_unmeasured(self):
        result = activation_metrics({})
        self.assertIsNone(result["component_bm25_matched"])
        self.assertIsNone(result["component_episodes_enabled"])

    def test_disabled_and_inactive_are_separate(self):
        result = activation_metrics({"retrieval_diagnostics": {"components": {"aliases": {"enabled": True, "activated": 0}}}})
        self.assertTrue(result["component_aliases_enabled"])
        self.assertEqual(result["component_aliases_activated"], 0)

    def test_disabled_component_cannot_claim_activation(self):
        names = ("episodes", "bm25", "aliases", "fuzzy", "temporal", "summary_boost")
        packet = {"manifest": {"policy": {"enable_" + name: name != "bm25" for name in names}},
                  "retrieval_diagnostics": {"episodes": {"enabled": True, "selected": 0},
                    "components": {name: {"enabled": name != "bm25", "selected": 0} for name in names if name != "episodes"}}}
        packet["retrieval_diagnostics"]["components"]["paths"] = {"enabled": True, "selected": 0}
        self.assertTrue(verify_component_intervention(packet, {"_variant": "no_bm25"})["passed"])
        packet["retrieval_diagnostics"]["components"]["bm25"]["matched"] = 1
        self.assertFalse(verify_component_intervention(packet, {"_variant": "no_bm25"})["passed"])

    def test_no_memory_cannot_keep_episode(self):
        self.assertFalse(verify_component_intervention({"learning_episodes": [{"id": 1}]}, {"_variant": "no_memory"})["passed"])

    def test_single_component_interventions_do_not_change_other_fields(self):
        @dataclass
        class Policy:
            token_budget: int = 1800
            max_paths: int = 4
            enable_episodes: bool = True
            enable_bm25: bool = True
            enable_aliases: bool = True
            enable_fuzzy: bool = True
            enable_temporal: bool = True
            enable_summary_boost: bool = True
        original = Policy()
        for variant, field in COMPONENT_VARIANTS.items():
            changed = asdict(policy_for(original, variant, 3200))
            self.assertEqual(changed, {**asdict(original), "token_budget": 3200, field: False})


if __name__ == "__main__":
    unittest.main()
