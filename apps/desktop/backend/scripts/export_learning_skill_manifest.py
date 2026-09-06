#!/usr/bin/env python3
"""Export the browser Skill manifest from the architecture registry authority."""
from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = ROOT / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

from app.services.architecture_registry import frontend_learning_skill_manifest  # noqa: E402


TARGET = ROOT / "frontend" / "src" / "generated" / "learning-skill-manifest.json"


def main() -> None:
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        frontend_learning_skill_manifest(),
        ensure_ascii=False,
        indent=2,
        sort_keys=False,
    )
    TARGET.write_text(f"{payload}\n", encoding="utf-8")
    print(TARGET)


if __name__ == "__main__":
    main()
