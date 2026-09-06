"""Offline stage-two comparison for conversational learning Skill readiness.

This evaluates deterministic product contracts, not human learning outcomes.
The frozen labels are independent of the candidate implementation.  The
baseline models the previous prompt-only behavior: every request receives a
normal explanation and has no bounded workflow or verified handoff.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.services.architecture_registry import EVENTS  # noqa: E402
from app.services.learning_skill_runtime import (  # noqa: E402
    recommend_learning_skill,
    workflow_blueprint,
)


RUNTIME_SKILLS = {
    "guided_explanation", "socratic_dialogue", "feynman_dialogue",
    "worked_example_fading",
}
RUNTIME_EVENTS = {
    "learning_skill_run_started",
    "learning_skill_run_advanced",
    "learning_skill_run_paused",
    "learning_skill_run_resumed",
    "learning_skill_calibration_updated",
    "learning_skill_teach_back_diagnostic_updated",
    "learning_skill_verification_started",
    "learning_skill_run_completed",
}


def candidate_prediction(message: str) -> str:
    recommendation = recommend_learning_skill(message)
    return str((recommendation or {}).get("skill", {}).get("id") or "guided_explanation")


def baseline_prediction(_message: str) -> str:
    return "guided_explanation"


def accuracy(rows: list[dict[str, Any]], prediction_key: str) -> float:
    if not rows:
        return 0.0
    return round(sum(row[prediction_key] == row["expected_skill"] for row in rows) / len(rows), 3)


def runtime_contract_score() -> dict[str, float]:
    blueprints = [workflow_blueprint(skill_id) for skill_id in sorted(RUNTIME_SKILLS)]
    bounded = all(
        blueprint
        and 1 <= int(blueprint["turn_budget"]) <= 5
        and list(blueprint["states"])[-1] == "verification_ready"
        for blueprint in blueprints
    )
    verified_handoff = all(
        blueprint
        and blueprint.get("verification_required") is True
        and "zero-target" in str(blueprint.get("evidence_policy"))
        and "independently graded attempts" in str(blueprint.get("evidence_policy"))
        for blueprint in blueprints
    )
    zero_target_events = all(
        event_id in EVENTS and EVENTS[event_id].kernel_targets == ()
        for event_id in RUNTIME_EVENTS
    )
    return {
        "bounded_runtime": float(bounded),
        "verified_handoff": float(verified_handoff),
        "evidence_boundary": float(verified_handoff and zero_target_events),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cases", type=Path,
        default=BACKEND_ROOT / "evals" / "learning_skill_cases.json",
    )
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    details = []
    for case in cases:
        details.append({
            **case,
            "candidate_prediction": candidate_prediction(case["message"]),
            "baseline_prediction": baseline_prediction(case["message"]),
        })

    contract = runtime_contract_score()
    candidate_metrics = {
        "routing_accuracy": accuracy(details, "candidate_prediction"),
        **contract,
    }
    baseline_metrics = {
        "routing_accuracy": accuracy(details, "baseline_prediction"),
        "bounded_runtime": 0.0,
        "verified_handoff": 0.0,
        "evidence_boundary": 0.0,
    }
    candidate_mean = sum(candidate_metrics.values()) / len(candidate_metrics)
    baseline_mean = sum(baseline_metrics.values()) / len(baseline_metrics)
    report = {
        "evaluation_scope": "engineering_readiness_not_learning_effect",
        "case_count": len(cases),
        "candidate": "atomic_learning_skill_runtime_v6_skill_spec_v3",
        "baseline": "prompt_only_guided_explanation",
        "candidate_metrics": candidate_metrics,
        "baseline_metrics": baseline_metrics,
        "mean_lift": round(candidate_mean - baseline_mean, 3),
        "details": details,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if (
        len(cases) >= 24
        and candidate_metrics["routing_accuracy"] >= 0.9
        and candidate_metrics["bounded_runtime"] == 1.0
        and candidate_metrics["verified_handoff"] == 1.0
        and candidate_metrics["evidence_boundary"] == 1.0
        and report["mean_lift"] >= 0.7
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
