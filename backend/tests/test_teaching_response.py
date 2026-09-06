"""The browser artifact must match the backend's exact prompt, not a hand copy."""
import json
from pathlib import Path

from app.services.teaching_response import teaching_response_manifest, teaching_response_prompt
from app.services.architecture_registry import DATA_CONTRACTS


def test_browser_export_matches_backend_prompt_and_registered_version():
    root = Path(__file__).resolve().parents[2]
    exported = json.loads((root / "frontend/src/generated/teaching-response-policy.json").read_text())
    assert exported == teaching_response_manifest()
    assert exported["version"] == DATA_CONTRACTS["teaching_response_v1"]["schema_version"]
    assert exported["prompt"] == teaching_response_prompt()
    assert len(exported["prompt"]) < 6000  # Stable, bounded prefix; no whole evaluation corpus.


def test_feedback_corpus_has_twenty_scoped_cases_and_no_measured_quality_claim():
    corpus = json.loads((Path(__file__).parent / "fixtures/teaching_response_cases.json").read_text())
    assert corpus["kind"] == "synthetic_reference_cases_not_model_measurements"
    assert [case["id"] for case in corpus["cases"]] == [f"{index:02}" for index in range(1, 21)]
    assert {case["category"] for case in corpus["cases"]} == {"concept", "mechanism", "comparison", "procedure", "followup"}
    for case in corpus["cases"]:
        assert case["messages"][-1]["role"] == "user"
        assert case["referenceAnswer"] and case["reviewCriteria"]
