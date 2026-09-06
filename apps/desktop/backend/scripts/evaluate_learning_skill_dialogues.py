"""Evaluate multi-turn pedagogical contracts for SkillSpec v3.

This suite checks deterministic orchestration safety and coherence.  It does
not claim to measure real learner gain; that requires human or field studies.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.services.architecture_registry import EVENTS, learning_skill_runtime_contract  # noqa: E402
from app.services.learning_skill_runtime import transition_learning_skill_turn  # noqa: E402


def evaluate(cases: list[dict[str, Any]]) -> dict[str, Any]:
    checks = {
        "signal_classification": [],
        "state_transition": [],
        "support_boundary": [],
        "one_step_advance": [],
        "verification_handoff": [],
        "evidence_boundary": [],
        "feynman_diagnostic_boundary": [],
        "calibration_contract": [],
    }
    details = []
    for case in cases:
        runtime = learning_skill_runtime_contract(case["skill_id"])
        if not runtime:
            raise ValueError(f"missing runtime: {case['skill_id']}")
        state = runtime.initial_state
        step_index = 1
        turn_count = 0
        support_count = 0
        calibration = dict(case.get("calibration") or {})
        teach_back_diagnostic: dict[str, Any] = {}
        gap_loop_count = 0
        trace = []
        for turn in case["turns"]:
            previous_state = state
            result = transition_learning_skill_turn(
                skill_id=case["skill_id"],
                current_state=state,
                step_index=step_index,
                turn_count=turn_count,
                support_count=support_count,
                goal=case["goal"],
                message=turn["message"],
                entry_mode=case.get("entry_mode", "direct"),
                calibration=calibration,
                teach_back_diagnostic=teach_back_diagnostic,
                gap_loop_count=gap_loop_count,
            )
            state = result["state"]
            step_index = int(result["step_index"])
            turn_count = int(result["turn_count"])
            support_count = int(result["support_count"])
            calibration = dict(result.get("calibration") or {})
            teach_back_diagnostic = dict(result.get("teach_back_diagnostic") or {})
            gap_loop_count = int(result.get("gap_loop_count") or 0)
            signal_ok = result["response_signal"] == turn["signal"]
            state_ok = (
                state == turn["state"]
                and turn_count == turn["turn_count"]
                and support_count == turn["support_count"]
            )
            support_ok = (result["support_only"] and state == previous_state) or (
                not result["support_only"]
            )
            previous_index = [item.id for item in runtime.states].index(previous_state)
            current_index = [item.id for item in runtime.states].index(state)
            one_step_ok = current_index - previous_index in ({0} if result["support_only"] else {0, 1})
            terminal_ok = state != "verification_ready" or (
                turn_count <= runtime.turn_budget and runtime.verification_required
            )
            event_ok = all(EVENTS[event_id].kernel_targets == () for event_id in runtime.allowed_event_types)
            checks["signal_classification"].append(signal_ok)
            checks["state_transition"].append(state_ok)
            checks["support_boundary"].append(support_ok)
            checks["one_step_advance"].append(one_step_ok)
            checks["verification_handoff"].append(terminal_ok)
            checks["evidence_boundary"].append(event_ok and "zero-target" in runtime.evidence_policy)
            diagnostic_ok = case["skill_id"] != "feynman_dialogue" or result["support_only"] or (
                bool(teach_back_diagnostic)
                and teach_back_diagnostic.get("verification") == "unverified"
                and teach_back_diagnostic.get("mastery_inference") is False
            )
            calibration_ok = case["skill_id"] != "feynman_dialogue" or all(
                axis.id in calibration for axis in runtime.calibration_axes
            )
            checks["feynman_diagnostic_boundary"].append(diagnostic_ok)
            checks["calibration_contract"].append(calibration_ok)
            trace.append({
                "message": turn["message"],
                "signal": result["response_signal"],
                "state": state,
                "turn_count": turn_count,
                "support_count": support_count,
                "gap_loop_count": gap_loop_count,
                "candidate_gap": teach_back_diagnostic.get("candidate_gap"),
            })
        details.append({"id": case["id"], "passed": all(items[-1] for items in checks.values()), "trace": trace})
    metrics = {
        key: round(sum(values) / len(values), 3) if values else 0.0
        for key, values in checks.items()
    }
    return {
        "evaluation_scope": "deterministic_pedagogical_contract_not_learning_gain",
        "schema_version": "learning-skill-dialogue-v3",
        "scenario_count": len(cases),
        "turn_count": sum(len(case["turns"]) for case in cases),
        "metrics": metrics,
        "passed": len(cases) >= 6 and all(value == 1.0 for value in metrics.values()),
        "details": details,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cases", type=Path,
        default=BACKEND_ROOT / "evals" / "learning_skill_dialogues.json",
    )
    args = parser.parse_args()
    report = evaluate(json.loads(args.cases.read_text(encoding="utf-8")))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
