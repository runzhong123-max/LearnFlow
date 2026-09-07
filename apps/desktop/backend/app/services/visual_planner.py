from __future__ import annotations

import time
from urllib.parse import urlparse
from typing import Any

from app.core.config import openai_chat_provider_kwargs, settings


def _message_text(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(getattr(item, "text", None), str):
                parts.append(item.text)
        return "\n".join(parts).strip()
    return ""


async def plan_learning_visual(
    *, instructions: str, input_text: str, timeout_ms: int, max_tokens: int,
    response_format: str = "json_object",
) -> dict[str, Any]:
    """Run visual planning; shared host validates computation and client renders."""
    if not settings.llm_api_key.strip():
        raise RuntimeError("visual_planner_not_configured")

    from openai import AsyncOpenAI

    started = time.perf_counter()
    client = AsyncOpenAI(
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        max_retries=0,
    )
    provider_kwargs = openai_chat_provider_kwargs(
        settings.llm_base_url, settings.llm_model, thinking_enabled=False,
    )
    if urlparse(settings.llm_base_url).hostname == 'api.deepseek.com' and settings.llm_model.casefold().startswith('deepseek-v4'):
        provider_kwargs = {**provider_kwargs, 'extra_body': {**provider_kwargs.get('extra_body', {}), 'thinking': {'type': 'disabled'}}}
    response = await client.chat.completions.create(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": input_text},
        ],
        max_tokens=max_tokens,
        timeout=max(1.0, timeout_ms / 1000),
        response_format={"type": response_format},
        **provider_kwargs,
    )
    choices = getattr(response, "choices", None) or []
    finish = str(getattr(choices[0], 'finish_reason', '') or '') if choices else ''
    if finish in {'length', 'content_filter'}:
        raise RuntimeError('visual_provider_incomplete:' + finish)
    text = _message_text(choices[0].message) if choices else ""
    if not text:
        raise RuntimeError("visual_provider_empty")
    return {
        "text": text,
        "model": str(getattr(response, "model", None) or settings.llm_model),
        "duration_ms": round((time.perf_counter() - started) * 1000),
    }
