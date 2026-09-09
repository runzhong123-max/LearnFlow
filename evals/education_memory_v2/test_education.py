"""Adversarial pure-data tests of verifier failure detection (not system evaluation)."""
import copy
import hashlib
import json
import math
import unittest

from education_verifier import verify_formation, verify_trial
from education import VARIANTS, intervene, native_current


def checks(result):
    return {row["name"]: row for row in result["checks"]}


def formation():
    return {"events": [{"id": 1, "event_type": "concept_attempt_evaluated",
                        "payload": {"attempt_id": 2, "item_id": 9, "correct": True}},
                       {"id": 4, "event_type": "profile_observed", "payload": {}}],
            "attempts": [{"id": 2, "item_id": 9, "assistance_level": "none", "result": {"correct": True},
                          "status": "evaluated", "attempt_role": "original"}],
            "states": {"knowledge": {"short_term": {"policy": "no stable mastery inference"},
                                      "long_term": {"mastery": {"item:9": {"level": "verified_once", "policy_version": "stable"}}}}},
            "mutations": [{"id": 3, "event_id": 1, "kernel": "knowledge"}],
            "facts": [{"id": 5, "text": "独立完成一次", "event_id": 1, "mutation_id": 3,
                       "kernel": "knowledge", "grade": "verified"}], "worker_runs": []}


def trial():
    text = "只在单线程通过；并发未验证。"
    meta = {"sha256": hashlib.sha256(text.encode()).hexdigest(), "chars": len(text), "ranges": [[0, len(text)]]}
    packet = {"kernel_heads": {}, "items": [{"id": 5, "kernel": "knowledge", "text": text, "status": "active",
              "detail": {"source_event_id": 1, "evidence_grade": "observed", "source_text": meta}, "evidence_refs": [1]}],
              "relation_paths": [], "personal_concept_graph": {}, "adaptation_directives": {}, "teaching_guidance": {},
              "_source_nodes": {5: {"text": text, "learner_id": 8, "project_id": 9, "checkpoint_id": 10,
                                      "status": "active", "source_event_id": 1}},
              "_source_events": {1: {"id": 1}}, "manifest": {}}
    plan = {"estimated_minutes": 10, "phases": [{"id": "learn", "kind": "learn", "required": True, "status": "pending"},
                                               {"id": "verify", "kind": "verify", "required": True, "status": "pending"}]}
    case = {"_budget": 2000, "_scope": {"learner_id": 8, "project_id": 9, "checkpoint_id": 10}}
    rubric = {"active_constraints": {"max_session_minutes": 10, "withhold_full_solution": True}}
    evidence = [{"source_event_id": 1, "terms": ["单线程通过", "并发未验证"], "kind": "limitation"}]
    restamp(packet)
    return packet, plan, case, rubric, evidence


def restamp(packet):
    packet["manifest"]["token_estimate"] = independently_estimated_tokens(packet)


def summary_trial(node_type="module"):
    args = trial()
    packet = args[0]
    item = packet["items"][0]
    item["node_type"] = node_type
    item["detail"].pop("source_event_id")
    item["evidence_refs"] = []
    source = packet["_source_nodes"][5]
    source.pop("source_event_id")
    source.update(node_type=node_type, evidence_event_ids=[1])
    restamp(packet)
    return args


def control_packet():
    packet = trial()[0]
    packet["scope"] = {"learner_id": 8, "project_id": 9, "checkpoint_id": 10}
    packet["kernel_heads"] = {"knowledge": {"summary": "Historical head"}}
    packet["personal_concept_graph"] = {"nodes": [{"id": "historical-concept"}]}
    packet["teaching_guidance"] = [
        {"slot": "same_slot", "source_event_id": 11, "marker": "old-same-slot"},
        {"slot": "same_slot", "source_event_id": 91, "marker": "current-single"},
        {"slot": "previously-unseen-slot", "source_event_ids": [15, 92], "marker": "current-plural"},
        {"slot": "apparently-current", "marker": "no-provenance"},
    ]
    packet["adaptation_directives"] = [
        {"slot": "same_slot", "evidence_event_ids": [11], "marker": "old-adaptation"},
        {"slot": "unexpected-adaptation", "evidence_event_ids": [93], "marker": "current-evidence"},
    ]
    packet["relation_paths"] = [{"source": {"id": 7}, "target": {"id": 8}, "relation": "RELATED"}]
    restamp(packet)
    return packet, [91, 92, 93]


def independently_estimated_tokens(packet):
    fields = ("enable_episodes", "max_episodes", "max_episode_facts", "enable_bm25",
              "enable_aliases", "enable_fuzzy", "enable_temporal", "enable_summary_boost")
    body = {"heads": packet.get("kernel_heads", {}), "items": packet.get("items", []),
            "paths": packet.get("relation_paths", []),
            "personal_concept_graph": packet.get("personal_concept_graph", {}),
            "adaptation_directives": packet.get("adaptation_directives", []),
            "teaching_guidance": packet.get("teaching_guidance", []),
            "learning_episodes": packet.get("learning_episodes", []),
            "retrieval_diagnostics": packet.get("retrieval_diagnostics", {}),
            "component_policy": {name: (packet.get("manifest", {}).get("policy", {}) or {}).get(name)
                                 for name in fields}}
    return max(1, math.ceil(len(json.dumps(body, ensure_ascii=False, sort_keys=True)) / 3.2))


class FormationTests(unittest.TestCase):
    def test_real_link_passes_without_scoring_metadata_policy(self):
        self.assertTrue(all(row["passed"] for row in verify_formation(formation())["checks"]))

    def test_ordinary_success_cannot_be_stable(self):
        for location in ("mastery", "proof_chain"):
            with self.subTest(location=location):
                data = formation()
                data["states"]["knowledge"]["long_term"][location] = {"item:9": {"level": "stable"}}
                self.assertFalse(checks(verify_formation(data))["no_stable_mastery"]["passed"])

    def test_missing_attempt_and_inconsistent_result_fail(self):
        for mutation in (lambda x: x["attempts"].clear(),
                         lambda x: x["attempts"][0]["result"].update(correct=False),
                         lambda x: x["attempts"][0]["result"].update(correct="true"),
                         lambda x: x["attempts"][0].update(item_id=19)):
            data = formation()
            mutation(data)
            self.assertFalse(checks(verify_formation(data))["attempt_event_link"]["passed"])

    def test_forged_chain_cannot_pass(self):
        for field, value in (("event_id", 99), ("mutation_id", 99), ("kernel", "human")):
            with self.subTest(field=field):
                data = formation()
                data["facts"][0][field] = value
                self.assertFalse(checks(verify_formation(data))["fact_chain"]["passed"])

    def test_fabricated_grade_is_explicitly_unscored(self):
        data = formation()
        data["facts"][0]["grade"] = "fabricated_stable_mastery"
        result = verify_formation(data)
        self.assertNotIn("evidence_grade_semantics", checks(result))
        self.assertIn("evidence_grade_semantics", {row["name"] for row in result["unscored"]})

    def test_duplicate_ids_fail(self):
        data = formation()
        data["events"].append(copy.deepcopy(data["events"][0]))
        self.assertFalse(checks(verify_formation(data))["snapshot_unique_ids"]["passed"])

    def test_zero_concept_events_and_facts_are_not_applicable(self):
        data = formation()
        data["events"] = [data["events"][1]]
        data["facts"] = []
        result = checks(verify_formation(data))
        for name in ("attempt_event_link", "fact_chain"):
            with self.subTest(name=name):
                self.assertIsNone(result[name]["passed"])
                self.assertEqual(result[name]["denominator"], 0)


class TrialTests(unittest.TestCase):
    def test_complete_source_and_plan_pass(self):
        result = verify_trial(*trial())
        self.assertTrue(all(row["passed"] for row in result["checks"] if row["passed"] is not None), result)

    def test_only_id_hash_not_body_is_not_delivery(self):
        args = trial()
        args[0]["items"][0]["text"] = ""
        restamp(args[0])
        result = checks(verify_trial(*args))
        self.assertFalse(result["source_fact_evidence_delivered"]["passed"])
        self.assertFalse(result["source_excerpts"]["passed"])

    def test_partial_term_not_full_evidence(self):
        args = trial()
        item = args[0]["items"][0]
        item["text"] = "只在单线程通过"
        item["detail"]["source_text"]["ranges"] = [[0, len(item["text"])]]
        restamp(args[0])
        result = checks(verify_trial(*args))
        self.assertTrue(result["source_excerpts"]["passed"])
        self.assertFalse(result["source_fact_evidence_delivered"]["passed"])

    def test_bad_hash_and_ranges_fail(self):
        for patch in ({"sha256": "0" * 64}, {"ranges": [[0, 1000]]}, {"chars": 999}, {"ranges": [[False, 3]]}):
            with self.subTest(patch=patch):
                args = trial()
                args[0]["items"][0]["detail"]["source_text"].update(patch)
                restamp(args[0])
                self.assertFalse(checks(verify_trial(*args))["source_excerpts"]["passed"])

    def test_valid_disjoint_ranges_reconstruct_exactly(self):
        args = trial()
        item = args[0]["items"][0]
        original = args[0]["_source_nodes"][5]["text"]
        ranges = [[0, 7], [8, len(original)]]
        item["text"] = " … ".join(original[a:b] for a, b in ranges)
        item["detail"]["source_text"]["ranges"] = ranges
        restamp(args[0])
        self.assertTrue(checks(verify_trial(*args))["source_excerpts"]["passed"])

    def test_path_endpoint_can_deliver(self):
        args = trial()
        item = args[0]["items"].pop()
        endpoint = {name: item[name] for name in ("id", "kernel", "text", "status")}
        endpoint.update(item["detail"])
        args[0]["relation_paths"] = [{"source": endpoint, "target": copy.deepcopy(endpoint)}]
        restamp(args[0])
        result = checks(verify_trial(*args))
        self.assertTrue(result["source_fact_evidence_delivered"]["passed"])
        self.assertTrue(result["source_fact_evidence_delivered"]["actual"][0]["visible_paths"][0].startswith("relation_paths"))

    def test_wrong_event_and_global_refs_do_not_deliver(self):
        args = trial()
        args[0]["items"][0]["detail"]["source_event_id"] = 999
        args[0]["_source_events"][999] = {"id": 999}
        restamp(args[0])
        result = checks(verify_trial(*args))
        self.assertFalse(result["visible_event_sources"]["passed"])
        self.assertFalse(result["source_fact_evidence_delivered"]["passed"])

    def test_ten_minutes_must_change_actual_plan_field(self):
        args = trial()
        args[1]["estimated_minutes"] = 45
        args[1]["teaching_constraints"] = {"max_minutes": 10}
        args[1]["session_focus"] = {"max_minutes": 10}
        self.assertFalse(checks(verify_trial(*args))["actual_plan_minutes"]["passed"])

    def test_invalid_minutes_not_accepted(self):
        for value in (None, True, "10", -1, 0, float("nan"), float("inf")):
            with self.subTest(value=value):
                args = trial()
                args[1]["estimated_minutes"] = value
                self.assertFalse(checks(verify_trial(*args))["actual_plan_minutes"]["passed"])

    def test_ten_minute_check_only_when_constraint_active(self):
        args = trial()
        args[3]["active_constraints"] = {}
        self.assertNotIn("actual_plan_minutes", checks(verify_trial(*args)))

    def test_verify_required_and_no_completed(self):
        args = trial()
        args[1]["phases"][1]["required"] = False
        args[1]["phases"][0]["status"] = "completed"
        result = checks(verify_trial(*args))
        self.assertFalse(result["verify_required"]["passed"])
        self.assertFalse(result["no_premature_completion"]["passed"])

    def test_forged_budget_not_accepted(self):
        args = trial()
        args[0]["manifest"]["token_estimate"] = 1
        self.assertFalse(checks(verify_trial(*args))["budget"]["passed"])

        restamp(args[0])
        args[2]["_budget"] = 1
        self.assertFalse(checks(verify_trial(*args))["budget"]["passed"])

    def test_foreign_scope_archived_and_human_fail(self):
        args = trial()
        args[0]["_source_nodes"][5].update(learner_id=999, status="archived")
        args[0]["items"][0]["kernel"] = "human"
        restamp(args[0])
        result = checks(verify_trial(*args))
        self.assertFalse(result["visible_memory_scope"]["passed"])
        self.assertFalse(result["no_human_raw_memory"]["passed"])
        self.assertFalse(result["source_fact_evidence_delivered"]["passed"])

    def test_semantic_rubric_and_disclosure_not_keyword_scored(self):
        args = trial()
        args[1]["summary"] = "完整答案 独立验证 分步教学 不提供答案"
        result = verify_trial(*args)
        self.assertNotIn("withhold_full_solution", checks(result))
        self.assertIn("semantic_rubrics", {row["name"] for row in result["unscored"]})

    def test_empty_terms_do_not_vacuously_count(self):
        args = trial()
        args[4][0]["terms"] = []
        self.assertFalse(checks(verify_trial(*args))["source_fact_evidence_delivered"]["passed"])

    def test_zero_expected_evidence_has_zero_denominator_and_no_pass(self):
        args = trial()
        args[4].clear()
        result = checks(verify_trial(*args))
        for name in ("source_fact_evidence_delivered", "attributed_evidence_delivered"):
            with self.subTest(name=name):
                self.assertIsNone(result[name]["passed"])
                self.assertEqual(result[name]["denominator"], 0)
                self.assertEqual(result[name]["actual"], [])

    def test_empty_visible_packet_does_not_claim_source_checks_passed(self):
        args = trial()
        args[0]["items"].clear()
        restamp(args[0])
        result = checks(verify_trial(*args))
        for name in ("source_excerpts", "visible_memory_scope", "visible_event_sources"):
            self.assertIsNone(result[name]["passed"])
            self.assertEqual(result[name]["denominator"], 0)
        self.assertFalse(result["attributed_evidence_delivered"]["passed"])
        self.assertEqual(result["attributed_evidence_delivered"]["denominator"], 1)

    def test_module_and_claim_closure_attribution_is_distinct_from_fact_delivery(self):
        for node_type in ("module", "claim"):
            with self.subTest(node_type=node_type):
                result = checks(verify_trial(*summary_trial(node_type)))
                self.assertTrue(result["visible_event_sources"]["passed"])
                self.assertTrue(result["attributed_evidence_delivered"]["passed"])
                self.assertFalse(result["source_fact_evidence_delivered"]["passed"])
                self.assertEqual(result["attributed_evidence_delivered"]["denominator"], 1)

    def test_module_text_and_existing_event_without_closure_do_not_attribute(self):
        args = summary_trial()
        args[0]["_source_events"][999] = {"id": 999}
        args[4][0]["source_event_id"] = 999
        result = checks(verify_trial(*args))
        self.assertTrue(result["visible_event_sources"]["passed"])
        self.assertFalse(result["attributed_evidence_delivered"]["passed"])

    def test_forged_module_source_declaration_cannot_expand_closure(self):
        for forged_field in ("source_event_id", "evidence_refs"):
            with self.subTest(forged_field=forged_field):
                args = summary_trial()
                args[0]["_source_events"][999] = {"id": 999}
                args[4][0]["source_event_id"] = 999
                if forged_field == "source_event_id":
                    args[0]["items"][0]["detail"]["source_event_id"] = 999
                else:
                    args[0]["items"][0]["evidence_refs"] = [999]
                restamp(args[0])
                result = checks(verify_trial(*args))
                self.assertFalse(result["visible_event_sources"]["passed"])
                self.assertFalse(result["attributed_evidence_delivered"]["passed"])

    def test_missing_module_closure_and_missing_fact_binding_are_rejected(self):
        args = summary_trial()
        del args[0]["_source_nodes"][5]["evidence_event_ids"]
        self.assertFalse(checks(verify_trial(*args))["visible_event_sources"]["passed"])
        args = trial()
        args[0]["_source_nodes"][5]["node_type"] = "fact"
        del args[0]["_source_nodes"][5]["source_event_id"]
        self.assertFalse(checks(verify_trial(*args))["visible_event_sources"]["passed"])

    def test_module_closure_id_alone_without_body_is_not_delivery(self):
        args = summary_trial()
        args[0]["items"][0]["text"] = ""
        restamp(args[0])
        self.assertFalse(checks(verify_trial(*args))["attributed_evidence_delivered"]["passed"])

    def test_cropped_packet_uses_current_manifest_not_pre_ablation_estimate(self):
        args = trial()
        previous = args[0]["manifest"]["token_estimate"]
        args[0]["items"].clear()
        args[0]["manifest"]["pre_ablation_token_estimate"] = previous
        restamp(args[0])
        self.assertTrue(checks(verify_trial(*args))["budget"]["passed"])
        args[0]["manifest"]["token_estimate"] = previous
        self.assertFalse(checks(verify_trial(*args))["budget"]["passed"])


class DriverControlTests(unittest.TestCase):
    def test_same_slot_different_event_is_excluded_and_new_slot_current_is_included(self):
        packet, event_ids = control_packet()
        current = native_current(packet, event_ids)
        self.assertEqual([row["marker"] for row in current["teaching_guidance"]],
                         ["current-single", "current-plural"])
        self.assertEqual([row["marker"] for row in current["adaptation_directives"]], ["current-evidence"])

    def test_each_supported_source_field_works_without_slot_or_value_matching(self):
        for field, value in (("source_event_id", 91), ("source_event_ids", [11, 91]),
                             ("evidence_event_ids", [91])):
            with self.subTest(field=field):
                row = {field: value, "slot": "unfamiliar", "value": "unrelated to gold wording"}
                packet = {"teaching_guidance": [row], "adaptation_directives": [copy.deepcopy(row)]}
                self.assertEqual(native_current(packet, [91]), packet)
                self.assertEqual(native_current(packet, [999]), {"teaching_guidance": [], "adaptation_directives": []})

    def test_all_six_variants_preserve_identical_current_control_projection(self):
        self.assertEqual(set(VARIANTS), {"full", "facts_only", "recent_facts", "no_relations", "no_guidance", "no_memory", "no_episodes", "no_bm25", "no_aliases", "no_fuzzy", "no_temporal", "no_summary_boost"})
        packet, event_ids = control_packet()
        current = native_current(packet, event_ids)
        before = copy.deepcopy(packet)
        for variant in VARIANTS:
            with self.subTest(variant=variant):
                result = intervene(packet, variant, current)
                self.assertEqual(native_current(result, event_ids), current)
        self.assertEqual(packet, before)

    def test_no_guidance_removes_only_historical_guidance_and_recalculates_tokens(self):
        packet, event_ids = control_packet()
        current = native_current(packet, event_ids)
        result = intervene(packet, "no_guidance", current)
        self.assertEqual(result["teaching_guidance"], current["teaching_guidance"])
        for name in ("items", "relation_paths", "kernel_heads", "personal_concept_graph", "adaptation_directives"):
            self.assertEqual(result[name], packet[name], name)
        self.assertEqual(result["manifest"]["pre_ablation_token_estimate"], packet["manifest"]["token_estimate"])
        self.assertEqual(result["manifest"]["token_estimate"], independently_estimated_tokens(result))
        self.assertLess(result["manifest"]["token_estimate"], packet["manifest"]["token_estimate"])

    def test_no_memory_has_only_current_controls_empty_history_and_current_token_cost(self):
        packet, event_ids = control_packet()
        current = native_current(packet, event_ids)
        result = intervene(packet, "no_memory", current)
        self.assertEqual(result["teaching_guidance"], current["teaching_guidance"])
        self.assertEqual(result["adaptation_directives"], current["adaptation_directives"])
        self.assertEqual(result["scope"], packet["scope"])
        self.assertEqual(result["items"], [])
        self.assertEqual(result["relation_paths"], [])
        self.assertEqual(result["kernel_heads"], {})
        self.assertFalse(result.get("personal_concept_graph"))
        self.assertFalse(result["manifest"]["direct_memory_evidence"])
        self.assertEqual(result["manifest"]["pre_ablation_token_estimate"], packet["manifest"]["token_estimate"])
        self.assertEqual(result["manifest"]["token_estimate"], independently_estimated_tokens(result))
        self.assertGreater(result["manifest"]["token_estimate"], 0)
        self.assertLess(result["manifest"]["token_estimate"], packet["manifest"]["token_estimate"])

    def test_control_projection_and_intervention_outputs_do_not_alias_inputs(self):
        packet, event_ids = control_packet()
        original = copy.deepcopy(packet)
        current = native_current(packet, event_ids)
        result = intervene(packet, "no_memory", current)
        result["teaching_guidance"][0]["marker"] = "mutated-output"
        self.assertEqual(packet, original)
        self.assertEqual(current["teaching_guidance"][0]["marker"], "current-single")
        current["teaching_guidance"][0]["marker"] = "mutated-projection"
        self.assertEqual(packet, original)


if __name__ == "__main__":
    unittest.main()
