"""Offline comparison for the stage-one micro-learning generation contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.services.micro_learning import _fallback_artifact, _valid_question  # noqa: E402


REQUIRED_CARD_FIELDS = {
    "title", "objective", "key_points", "target_concepts",
    "example", "common_confusion", "success_criteria",
}


def naive_outline(goal: str, source_text: str) -> dict[str, Any]:
    """Old-style content baseline: a readable outline without a learning loop."""
    text = source_text.strip() or f"请阅读并理解：{goal}。"
    return {
        "card": {"title": goal, "key_points": [text[:500]]},
        "questions": [],
    }


def score_artifact(artifact: dict[str, Any], source_text: str) -> dict[str, float]:
    card = dict(artifact.get("card") or {})
    questions = list(artifact.get("questions") or [])
    complete_card = REQUIRED_CARD_FIELDS <= set(card)
    point_count = len(list(card.get("key_points") or []))
    valid_questions = sum(1 for question in questions if _valid_question(question))
    source_grounded = 1.0
    if source_text:
        source_grounded = float(all(
            str(point) in source_text
            for point in list(card.get("key_points") or [])
        ))
    return {
        "card_contract": float(complete_card and 3 <= point_count <= 5),
        "assessment_contract": float(valid_questions >= 2),
        "source_grounding": source_grounded,
        "resumable_loop_ready": float(
            complete_card and valid_questions >= 2
            and bool(card.get("success_criteria"))
        ),
    }


def average(rows: list[dict[str, float]]) -> dict[str, float]:
    keys = tuple(rows[0]) if rows else ()
    return {
        key: round(sum(row[key] for row in rows) / len(rows), 3)
        for key in keys
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cases",
        type=Path,
        default=BACKEND_ROOT / "evals" / "micro_learning_cases.json",
    )
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    verified_rows = []
    baseline_rows = []
    details = []
    for case in cases:
        verified = score_artifact(
            _fallback_artifact(case["goal"], case.get("source_text", "")),
            case.get("source_text", ""),
        )
        baseline = score_artifact(
            naive_outline(case["goal"], case.get("source_text", "")),
            case.get("source_text", ""),
        )
        verified_rows.append(verified)
        baseline_rows.append(baseline)
        details.append({"id": case["id"], "verified": verified, "baseline": baseline})

    verified_average = average(verified_rows)
    baseline_average = average(baseline_rows)
    verified_total = sum(verified_average.values()) / max(1, len(verified_average))
    baseline_total = sum(baseline_average.values()) / max(1, len(baseline_average))
    report = {
        "case_count": len(cases),
        "candidate": "verified_micro_learning_fallback_v1",
        "baseline": "naive_outline",
        "candidate_metrics": verified_average,
        "baseline_metrics": baseline_average,
        "mean_lift": round(verified_total - baseline_total, 3),
        "details": details,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if (
        len(cases) >= 20
        and verified_average.get("card_contract", 0) >= 0.95
        and verified_average.get("assessment_contract", 0) >= 0.95
        and report["mean_lift"] >= 0.3
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
