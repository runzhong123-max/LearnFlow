"""The evaluation must execute real strategies without touching configured data."""
import json
import os
from pathlib import Path
import subprocess
import sys

from scripts.evaluate_memory_upgrade import score_case


def test_scoring_reports_missed_and_stale_memory_without_manufacturing_success():
    result = score_case([{"id": 2}, {"id": 7}], [1], [2])
    assert result["recall"] == 0
    assert result["missed_ids"] == [1]
    assert result["old_memory_reference_ids"] == [2]
    assert result["unexpected_ids"] == [2, 7]
    assert score_case([], [], [2])["empty_when_uncovered"] is True


def test_three_strategies_execute_in_temporary_database(tmp_path):
    sentinel = tmp_path / "configured-production.db"
    sentinel.write_bytes(b"must never be opened or changed")
    report_file = tmp_path / "report.json"
    script = Path(__file__).resolve().parents[1] / "scripts/evaluate_memory_upgrade.py"
    env = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{sentinel}", "LLM_API_KEY": ""}
    completed = subprocess.run([sys.executable, str(script), "--repetitions", "1",
        "--output", str(report_file)], env=env, capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stderr
    assert sentinel.read_bytes() == b"must never be opened or changed"
    report = json.loads(report_file.read_text())
    assert report["evaluation_kind"] == "retrieval_only_not_learning_gain"
    assert report["fixture"]["nodes"] > 300
    assert report["network_calls"] == 0
    rows = report["results"]
    assert len(rows) == 9
    assert {row["strategy"] for row in rows} == {"recent_window", "compact_facts", "five_kernel"}
    for row in rows:
        assert row["latency_ms"]["median"] > 0
        assert len(row["latency_ms"]["samples"]) == 1
        assert row["budget"]["selected_items"] <= report["limits"]["max_items"]
        assert row["budget"]["context_tokens_estimate"] <= report["limits"]["context_tokens_estimate"]
        assert row["old_memory_reference_ids"] == []
        assert row["recall"] is None or 0 <= row["recall"] <= 1
    # Do not assert a winning strategy: uncovered production packets may contain
    # irrelevant context, and that result must stay visible in the report.
    assert {row["case_id"] for row in rows} == {
        "old_anchor_after_360_records", "corrected_goal", "uncovered_topic"}
