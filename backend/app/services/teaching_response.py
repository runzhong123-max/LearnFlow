"""Shared presentation instructions, never a teaching/state decision authority."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

POLICY_PATH = Path(__file__).resolve().parents[1] / "contracts" / "teaching-response.v1.json"


@lru_cache(maxsize=1)
def teaching_response_manifest() -> dict[str, str]:
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    sections = [f"教学表达规范（{policy['version']}）", *policy["instructions"]]
    sections.extend(
        f"写作示例 {index}（仅供表达参考）\n问题：{example['question']}\n回答：{example['answer']}"
        for index, example in enumerate(policy["examples"], start=1)
    )
    return {"version": policy["version"], "prompt": "\n\n".join(sections)}


def teaching_response_prompt() -> str:
    return teaching_response_manifest()["prompt"]
