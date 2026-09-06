import asyncio
from types import SimpleNamespace

from app.api.review import _grade_code
from app.core.config import settings
from app.services.demo_code_grader import (
    SEEDED_DEMO_CASES,
    SEEDED_DEMO_EXERCISE_TITLE,
    grade_seeded_demo_code,
    seeded_demo_assessment_metadata,
)
from app.services.exercise_agent import ExerciseAgent


STARTER = """import ast
import sys

def safe_average(values):
    return sum(values) / len(values)

values = ast.literal_eval(sys.stdin.read().strip())
print(f"{safe_average(values):.1f}")
"""


FIXED = """import ast
import sys

def safe_average(values):
    if not values:
        return 0.0
    return sum(values) / len(values)

values = ast.literal_eval(sys.stdin.read().strip())
print(f"{safe_average(values):.1f}")
"""


def _exercise(**changes):
    values = {
        "title": SEEDED_DEMO_EXERCISE_TITLE,
        "judge_mode": "test_cases",
        "test_cases": list(SEEDED_DEMO_CASES),
        "assessment_meta": seeded_demo_assessment_metadata(),
        "files": [],
    }
    values.update(changes)
    return SimpleNamespace(**values)


def test_seeded_demo_grader_is_closed_outside_demo_mode(monkeypatch):
    monkeypatch.setattr(settings, "competition_demo_mode", False)
    assert grade_seeded_demo_code(_exercise(), FIXED) is None


def test_seeded_demo_grader_requires_exact_versioned_contract(monkeypatch):
    monkeypatch.setattr(settings, "competition_demo_mode", True)
    metadata = seeded_demo_assessment_metadata()
    metadata["grader_contract_sha256"] = "wrong"
    assert grade_seeded_demo_code(_exercise(assessment_meta=metadata), FIXED) is None
    changed_cases = [*list(SEEDED_DEMO_CASES), {"input": "[1]", "expected": "1.0"}]
    assert grade_seeded_demo_code(_exercise(test_cases=changed_cases), FIXED) is None


def test_seeded_demo_ast_contract_reports_failure_then_pass_without_execution(monkeypatch):
    monkeypatch.setattr(settings, "competition_demo_mode", True)
    starter = grade_seeded_demo_code(_exercise(), STARTER)
    fixed = grade_seeded_demo_code(_exercise(), FIXED)

    assert starter is not None and starter["passed"] == 2 and starter["total"] == 3
    assert starter["results"][0]["actual"] == "ZeroDivisionError: division by zero"
    assert fixed is not None and fixed["passed"] == fixed["total"] == 3
    assert fixed["execution_performed"] is False
    assert fixed["execution_boundary"] == "not_executed"
    assert fixed["assessment_scope"] == "isolated_seeded_demo_only"


def test_review_grader_uses_seeded_contract_before_generic_executor(monkeypatch):
    monkeypatch.setattr(settings, "competition_demo_mode", True)

    def forbidden_execution(*_args, **_kwargs):
        raise AssertionError("generic code execution must not be called")

    monkeypatch.setattr(ExerciseAgent, "verify_exercise", forbidden_execution)
    result = asyncio.run(_grade_code(_exercise(), STARTER, []))
    assert result["passed"] == 2
    assert result["execution_performed"] is False
