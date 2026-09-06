#!/usr/bin/env python3
"""Export the shared prompt for frontend builds; --check detects drift without writing."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.teaching_response import teaching_response_manifest  # noqa: E402

TARGET = ROOT / "frontend" / "src" / "generated" / "teaching-response-policy.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = json.dumps(teaching_response_manifest(), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not TARGET.exists() or TARGET.read_text(encoding="utf-8") != expected:
            raise SystemExit("Teaching response policy drift: run backend/scripts/export_teaching_response_policy.py")
        print("Teaching response policy is current.")
        return
    TARGET.write_text(expected, encoding="utf-8")
    print(f"Exported {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
