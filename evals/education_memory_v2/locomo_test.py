"""Verifier calibration and input isolation tests; these are not LoCoMo results."""
import copy
from datetime import datetime
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("locomo_driver", Path(__file__).with_name("locomo.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture():
    return [{"sample_id": "conv-test", "conversation": {"speaker_a": "A", "speaker_b": "B",
        "session_1_date_time": "1:56 pm on 8 May, 2023", "session_1": [
            {"dia_id": "D1:1", "speaker": "A", "text": "The first complete original statement.", "blip_caption": "CAPTION_SECRET"},
            {"dia_id": "D1:2", "speaker": "B", "text": "The second complete original statement."}]},
        "qa": [{"question": "Which statements?", "answer": "ANSWER_SECRET", "category": 1, "evidence": ["D1:1", "D1:2"]}],
        "observation": "OBSERVATION_SECRET", "session_summary": "SUMMARY_SECRET", "event_summary": "EVENT_SECRET"}]


class DriverTests(unittest.TestCase):
    def test_allowlist_excludes_answers_summaries_and_captions(self):
        data = fixture()
        extracted = m.extract_conversations(data)
        body = str(extracted)
        self.assertNotIn("SECRET", body)
        self.assertEqual(extracted[0]["turns"][0]["speaker"], "A")
        self.assertEqual(extracted[0]["turns"][0]["text"], data[0]["conversation"]["session_1"][0]["text"])

    def test_qa_change_cannot_change_database_projection(self):
        data = fixture(); changed = copy.deepcopy(data)
        changed[0]["qa"] = [{"question": "Different", "answer": "other", "evidence": ["D1:2"], "category": 5}]
        self.assertEqual(m.extract_conversations(data), m.extract_conversations(changed))

    def test_timestamp_format(self):
        self.assertEqual(m.session_time("1:56 pm on 8 May, 2023"), datetime(2023, 5, 8, 13, 56))

    def test_missing_reference_is_invalid_not_zero(self):
        data = fixture(); data[0]["qa"][0]["evidence"].append("D99:1")
        c = m.extract_conversations(data); q = m.question_manifest(data, c)[0]
        metrics, _ = m.score_packet(m.no_memory_packet(), q, c[0])
        self.assertEqual(q["annotation_status"], "invalid_annotation")
        self.assertIsNone(metrics["source_recall"])

    def test_complete_id_match_does_not_imply_complete_text(self):
        data = fixture(); c = m.extract_conversations(data); q = m.question_manifest(data, c)[0]
        packet = {"items": [{"id": 1, "text": c[0]["turns"][0]["body"]}, {"id": 2, "text": "The second…"}]}
        metrics, diagnostic = m.score_packet(packet, q, c[0])
        self.assertEqual(metrics["source_recall"], 1)
        self.assertEqual(metrics["full_text_recall"], .5)
        self.assertFalse(metrics["full_evidence_complete"])
        self.assertEqual(diagnostic["clipped_evidence"], ["D1:2"])

    def test_unknown_id_cannot_gain_credit_from_copied_text(self):
        data = fixture(); c = m.extract_conversations(data); q = m.question_manifest(data, c)[0]
        metrics, _ = m.score_packet({"items": [{"id": 100, "text": c[0]["turns"][0]["text"]}]}, q, c[0])
        self.assertEqual(metrics["source_recall"], 0)
        self.assertEqual(metrics["full_text_recall"], 0)
        self.assertEqual(metrics["attribution_error_count"], 1)

    def test_wrong_source_hash_cannot_gain_full_text_credit(self):
        data = fixture(); c = m.extract_conversations(data); q = m.question_manifest(data, c)[0]
        turn = c[0]["turns"][0]
        packet = {"items": [{"id": turn["node_id"], "text": turn["body"], "detail": {
            "source_text": {"sha256": "wrong", "chars": len(turn["body"]), "ranges": [[0, len(turn["body"])]]}}}]}
        metrics, _ = m.score_packet(packet, q, c[0])
        self.assertEqual(metrics["source_recall"], .5)
        self.assertEqual(metrics["full_text_recall"], 0)
        self.assertEqual(metrics["attribution_error_count"], 1)

    def test_adversarial_evidence_is_not_answer_gold(self):
        data = fixture(); data[0]["qa"][0]["category"] = 5
        c = m.extract_conversations(data); q = m.question_manifest(data, c)[0]
        metrics, _ = m.score_packet(m.no_memory_packet(), q, c[0])
        self.assertEqual(q["scoring_group"], "adversarial_no_answer")
        self.assertIsNone(metrics["source_recall"])
        self.assertIsNone(metrics["evidence_precision"])

    def test_external_knowledge_is_separate(self):
        data = fixture(); data[0]["qa"][0]["category"] = 3
        c = m.extract_conversations(data); q = m.question_manifest(data, c)[0]
        self.assertEqual(q["scoring_group"], "external_knowledge")

    def test_empty_evidence_not_perfect_recall(self):
        data = fixture(); data[0]["qa"][0]["evidence"] = []
        c = m.extract_conversations(data); q = m.question_manifest(data, c)[0]
        metrics, _ = m.score_packet(m.no_memory_packet(), q, c[0])
        self.assertIsNone(metrics["source_complete"])

    def test_duplicate_turn_identity_rejected(self):
        data = fixture(); data[0]["conversation"]["session_1"][1]["dia_id"] = "D1:1"
        with self.assertRaises(ValueError):
            m.extract_conversations(data)


if __name__ == "__main__":
    unittest.main()
