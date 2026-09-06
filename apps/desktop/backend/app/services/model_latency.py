"""Shared wall-clock budgets for optional interactive model enhancement."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar


T = TypeVar("T")


class InteractiveModelBudgetExceeded(TimeoutError):
    """Raised when an interactive model call exhausts its shared deadline."""


def model_deadline(seconds: float | int) -> float:
    return asyncio.get_running_loop().time() + max(0.01, float(seconds))


async def invoke_before_deadline(
    factory: Callable[[], Awaitable[T]],
    deadline: float,
) -> T:
    remaining = deadline - asyncio.get_running_loop().time()
    if remaining <= 0:
        raise InteractiveModelBudgetExceeded("interactive model deadline exhausted")
    try:
        return await asyncio.wait_for(factory(), timeout=remaining)
    except TimeoutError as error:
        raise InteractiveModelBudgetExceeded(
            "interactive model deadline exhausted"
        ) from error


async def invoke_with_budget(
    factory: Callable[[], Awaitable[T]],
    seconds: float | int,
) -> T:
    return await invoke_before_deadline(factory, model_deadline(seconds))
