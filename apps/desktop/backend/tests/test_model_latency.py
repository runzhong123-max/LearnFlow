import asyncio
import time

import pytest

from app.services.model_latency import (
    InteractiveModelBudgetExceeded,
    invoke_before_deadline,
    invoke_with_budget,
    model_deadline,
)


def test_invoke_with_budget_returns_completed_result():
    async def scenario():
        return await invoke_with_budget(lambda: asyncio.sleep(0, result="ready"), 0.1)

    assert asyncio.run(scenario()) == "ready"


def test_invoke_with_budget_stops_a_slow_provider():
    async def scenario():
        started = time.perf_counter()
        with pytest.raises(InteractiveModelBudgetExceeded):
            await invoke_with_budget(lambda: asyncio.sleep(1), 0.01)
        return time.perf_counter() - started

    assert asyncio.run(scenario()) < 0.5


def test_structured_and_plain_retries_share_one_deadline():
    async def scenario():
        deadline = model_deadline(0.03)
        started = time.perf_counter()
        with pytest.raises(ValueError):
            await invoke_before_deadline(
                lambda: _fail_after(0.015), deadline,
            )
        with pytest.raises(InteractiveModelBudgetExceeded):
            await invoke_before_deadline(
                lambda: asyncio.sleep(1), deadline,
            )
        return time.perf_counter() - started

    async def _fail_after(seconds: float):
        await asyncio.sleep(seconds)
        raise ValueError("invalid structured response")

    assert asyncio.run(scenario()) < 0.3
