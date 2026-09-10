"""The plain reply tier is what explain and learn turns run on.

It is configured with ``max_retries=0``, so before this wrapper existed a single
empty completion — a transient provider behaviour — surfaced to the learner as
canned failure text instead of a lesson.
"""

import asyncio

import pytest

from app.services.model_latency import InteractiveModelBudgetExceeded
from app.services import tutor_service


class _Response:
    def __init__(self, content: str) -> None:
        self.content = content


class _Model:
    """Returns each queued body in turn; records how often it was called."""

    def __init__(self, *bodies: str) -> None:
        self._bodies = list(bodies)
        self.calls = 0

    async def ainvoke(self, _messages):
        self.calls += 1
        body = self._bodies.pop(0) if self._bodies else ""
        return _Response(body)


def _deadline(seconds: float) -> float:
    return asyncio.get_event_loop().time() + seconds


@pytest.mark.asyncio
async def test_an_empty_first_body_is_retried_and_the_lesson_still_arrives():
    model = _Model("", "指针保存的是一个地址。")
    reply, *_ = await tutor_service._invoke_plain_tutor_reply_resiliently(
        model, [], _deadline(120),
    )
    assert model.calls == 2
    assert reply == "指针保存的是一个地址。"


@pytest.mark.asyncio
async def test_a_body_that_arrives_first_time_is_not_called_twice():
    model = _Model("指针保存的是一个地址。")
    await tutor_service._invoke_plain_tutor_reply_resiliently(model, [], _deadline(120))
    assert model.calls == 1


@pytest.mark.asyncio
async def test_retries_are_bounded_so_a_persistently_empty_model_still_fails():
    model = _Model("", "", "")
    with pytest.raises(ValueError):
        await tutor_service._invoke_plain_tutor_reply_resiliently(
            model, [], _deadline(120),
        )
    assert model.calls == 2


@pytest.mark.asyncio
async def test_a_nearly_spent_budget_is_not_spent_again_on_a_retry():
    """Retrying inside the last seconds of the budget only trades an empty
    reply for a timeout, which reads worse and costs the learner the wait."""
    model = _Model("", "太晚了，这条不该被请求")
    with pytest.raises(ValueError):
        await tutor_service._invoke_plain_tutor_reply_resiliently(
            model, [], _deadline(2),
        )
    assert model.calls == 1


@pytest.mark.asyncio
async def test_an_exhausted_deadline_is_never_retried():
    class _SlowModel:
        def __init__(self) -> None:
            self.calls = 0

        async def ainvoke(self, _messages):
            self.calls += 1
            await asyncio.sleep(5)
            return _Response("never reached")

    model = _SlowModel()
    with pytest.raises(InteractiveModelBudgetExceeded):
        await tutor_service._invoke_plain_tutor_reply_resiliently(
            model, [], _deadline(0.05),
        )
    assert model.calls == 1
