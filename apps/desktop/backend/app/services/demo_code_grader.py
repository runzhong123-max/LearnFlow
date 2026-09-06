"""Deterministic, non-executing grader for the isolated seeded demo.

This module is deliberately not a general Python judge. It recognizes one
versioned competition-demo exercise and inspects a narrowly defined AST
contract. Submitted code is never imported, evaluated, or executed.
"""
from __future__ import annotations

import ast
import hashlib
import json
from typing import Any

from app.core.config import settings


SEEDED_DEMO_GRADER_ID = "seeded_safe_average_ast_v1"
SEEDED_DEMO_SOURCE = "seeded_competition_demo"
SEEDED_DEMO_EXERCISE_TITLE = "修复 safe_average 的空列表错误"
SEEDED_DEMO_CASES = (
    {"input": "[]", "expected": "0.0"},
    {"input": "[2, 4, 6]", "expected": "4.0"},
    {"input": "[-2, 2]", "expected": "0.0"},
)


def seeded_demo_grader_digest() -> str:
    payload = {
        "grader_id": SEEDED_DEMO_GRADER_ID,
        "exercise_title": SEEDED_DEMO_EXERCISE_TITLE,
        "test_cases": list(SEEDED_DEMO_CASES),
        "contract": "safe_average(values): empty guard then sum(values) / len(values)",
    }
    rendered = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def seeded_demo_assessment_metadata() -> dict[str, Any]:
    return {
        "source": SEEDED_DEMO_SOURCE,
        "grader_id": SEEDED_DEMO_GRADER_ID,
        "grader_contract_sha256": seeded_demo_grader_digest(),
        "execution_mode": "deterministic_ast_contract",
        "execution_performed": False,
    }


def _canonical_cases(value: Any) -> tuple[dict[str, str], ...]:
    if not isinstance(value, list):
        return ()
    result: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            return ()
        result.append({
            "input": str(item.get("input", "")),
            "expected": str(item.get("expected", "")),
        })
    return tuple(result)


def _is_supported_exercise(exercise: Any) -> bool:
    metadata = dict(getattr(exercise, "assessment_meta", None) or {})
    return all((
        settings.competition_demo_mode,
        str(getattr(exercise, "title", "")) == SEEDED_DEMO_EXERCISE_TITLE,
        str(getattr(exercise, "judge_mode", "")) == "test_cases",
        metadata.get("source") == SEEDED_DEMO_SOURCE,
        metadata.get("grader_id") == SEEDED_DEMO_GRADER_ID,
        metadata.get("grader_contract_sha256") == seeded_demo_grader_digest(),
        _canonical_cases(getattr(exercise, "test_cases", None)) == SEEDED_DEMO_CASES,
    ))


def _is_name(node: ast.AST | None, expected: str) -> bool:
    return isinstance(node, ast.Name) and node.id == expected


def _is_values_empty_guard(node: ast.AST, argument_name: str) -> bool:
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return _is_name(node.operand, argument_name)
    if not isinstance(node, ast.Compare) or len(node.ops) != 1 or len(node.comparators) != 1:
        return False
    left = node.left
    comparator = node.comparators[0]
    is_len_call = (
        isinstance(left, ast.Call)
        and _is_name(left.func, "len")
        and len(left.args) == 1
        and _is_name(left.args[0], argument_name)
        and not left.keywords
    )
    is_zero = isinstance(comparator, ast.Constant) and comparator.value == 0
    return is_len_call and is_zero and isinstance(node.ops[0], (ast.Eq, ast.LtE))


def _is_zero_return(statement: ast.stmt) -> bool:
    return (
        isinstance(statement, ast.Return)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, (int, float))
        and not isinstance(statement.value.value, bool)
        and float(statement.value.value) == 0.0
    )


def _is_average_return(statement: ast.stmt, argument_name: str) -> bool:
    if not isinstance(statement, ast.Return) or not isinstance(statement.value, ast.BinOp):
        return False
    expression = statement.value
    if not isinstance(expression.op, ast.Div):
        return False
    numerator = expression.left
    denominator = expression.right
    return all((
        isinstance(numerator, ast.Call),
        _is_name(getattr(numerator, "func", None), "sum"),
        len(getattr(numerator, "args", [])) == 1,
        _is_name(numerator.args[0], argument_name),
        not numerator.keywords,
        isinstance(denominator, ast.Call),
        _is_name(getattr(denominator, "func", None), "len"),
        len(getattr(denominator, "args", [])) == 1,
        _is_name(denominator.args[0], argument_name),
        not denominator.keywords,
    ))


def _function_contract(tree: ast.Module) -> tuple[bool, bool, str]:
    functions = [
        node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "safe_average"
    ]
    if len(functions) != 1 or not isinstance(functions[0], ast.FunctionDef):
        return False, False, "未找到唯一的同步函数 safe_average(values)"
    function = functions[0]
    arguments = function.args
    if (
        len(arguments.args) != 1
        or arguments.vararg is not None
        or arguments.kwarg is not None
        or arguments.kwonlyargs
        or arguments.defaults
        or arguments.kw_defaults
        or function.decorator_list
    ):
        return False, False, "safe_average 必须只接收一个普通参数"
    argument_name = arguments.args[0].arg
    body = list(function.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    if len(body) == 1:
        base_ok = _is_average_return(body[0], argument_name)
        detail = "空列表仍会在除法处触发错误" if base_ok else "函数主体不符合本题的最小计算合同"
        return base_ok, False, detail
    if len(body) != 2 or not isinstance(body[0], ast.If):
        return False, False, "请保留最小修复：一个前置判断和原有平均值返回"
    guard = body[0]
    guard_ok = (
        _is_values_empty_guard(guard.test, argument_name)
        and len(guard.body) == 1
        and _is_zero_return(guard.body[0])
        and not guard.orelse
    )
    base_ok = _is_average_return(body[1], argument_name)
    if not base_ok:
        return False, guard_ok, "平均值主路径必须保持 sum(values) / len(values)"
    if not guard_ok:
        return True, False, "空列表前置判断尚未覆盖本题合同"
    return True, True, "固定 AST 合同已满足"


def _result_row(*, passed: bool, expected: str, actual: str) -> dict[str, Any]:
    return {
        "passed": passed,
        "expected": expected,
        "actual": actual,
        "stderr": "",
    }


def grade_seeded_demo_code(exercise: Any, code: str) -> dict[str, Any] | None:
    """Grade the one seeded exercise without executing submitted code.

    ``None`` means the exercise is outside this private demo contract and must
    continue through the normal (fail-closed) execution policy.
    """
    if not _is_supported_exercise(exercise):
        return None
    try:
        tree = ast.parse(str(code or ""), filename="<seeded-demo-submission>", mode="exec")
    except SyntaxError as exc:
        detail = f"语法错误（第 {exc.lineno or 0} 行）"
        rows = [
            _result_row(passed=False, expected=item["expected"], actual=detail)
            for item in SEEDED_DEMO_CASES
        ]
    else:
        base_ok, guard_ok, detail = _function_contract(tree)
        rows = [
            _result_row(
                passed=guard_ok,
                expected=SEEDED_DEMO_CASES[0]["expected"],
                actual=SEEDED_DEMO_CASES[0]["expected"] if guard_ok else (
                    "ZeroDivisionError: division by zero" if base_ok else detail
                ),
            ),
            _result_row(
                passed=base_ok,
                expected=SEEDED_DEMO_CASES[1]["expected"],
                actual=SEEDED_DEMO_CASES[1]["expected"] if base_ok else detail,
            ),
            _result_row(
                passed=base_ok,
                expected=SEEDED_DEMO_CASES[2]["expected"],
                actual=SEEDED_DEMO_CASES[2]["expected"] if base_ok else detail,
            ),
        ]
    return {
        "passed": sum(1 for row in rows if row["passed"]),
        "total": len(rows),
        "results": rows,
        "grader_id": SEEDED_DEMO_GRADER_ID,
        "grader_contract_sha256": seeded_demo_grader_digest(),
        "execution_policy": "deterministic_seeded_ast_contract",
        "execution_boundary": "not_executed",
        "execution_performed": False,
        "assessment_scope": "isolated_seeded_demo_only",
    }
