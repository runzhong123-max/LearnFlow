#!/usr/bin/env python3
"""Run data/oracle checks and report coverage; never invokes a tested tutor."""
from collections import Counter
from itertools import combinations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

import dataset


def text_shingles(text):
    # Review aid only: number normalization may flag legitimate boundary variants.
    text = re.sub(r"\d+(?:\.\d+)?", "#", text.lower())
    text = re.sub(r"\s+", "", text)
    return {text[i:i + 5] for i in range(max(1, len(text) - 4))}


def run_audit():
    summary = dataset.validate()
    families = dataset.load_families()
    expected = {p["oracle_id"] for f in families for p in f["probes"] if p["answer_validation"] == "executable"}
    assert len(expected) == sum(p["answer_validation"] == "executable" for f in families for p in f["probes"]), "duplicate executable oracle binding"
    oracle_reports, checked = {}, set()
    for name in ("foundations", "software", "operations"):
        script = dataset.ROOT / "checks" / f"{name}_check.py"
        result = subprocess.run([sys.executable, str(script), "--catalog", str(dataset.ROOT / "catalog" / f"{name}.json")],
                                cwd=dataset.ROOT, text=True, capture_output=True, timeout=60, check=True)
        report = json.loads(result.stdout)
        if "catalog" in report:
            report["catalog"] = f"catalog/{name}.json"
        if result.stderr:
            report["stderr"] = result.stderr.replace(str(dataset.ROOT), "${DATASET_ROOT}")
        ids = report["checked_oracle_ids"]
        assert isinstance(ids, list) and all(isinstance(s, str) for s in ids)
        assert len(ids) == len(set(ids)), f"duplicate checked ids in {name}"
        assert not (checked & set(ids)), "oracle identity collision"
        checked.update(ids)
        oracle_reports[name] = report
    assert checked == expected, {"not_checked": sorted(expected - checked), "not_declared": sorted(checked - expected)}
    splits = dataset.assign_splits(families)
    probes = [{"family_id": f["family_id"], "probe_id": p["id"], "split": splits[f["family_id"]],
               "shingles": text_shingles(p["prompt"] + "\n" + p["artifact"])}
              for f in families for p in f["probes"]]
    flagged = []
    for a, b in combinations(probes, 2):
        score = len(a["shingles"] & b["shingles"]) / max(1, len(a["shingles"] | b["shingles"]))
        if score >= 0.72:
            flagged.append({"a": [a["family_id"], a["probe_id"]], "b": [b["family_id"], b["probe_id"]],
                            "similarity": round(score, 4), "cross_split": a["split"] != b["split"],
                            "review_status": "candidate_requires_semantic_review_not_automatic_duplicate"})
    summary.update({
        "python_version": sys.version,
        "executable_answers_recomputed": len(checked), "oracle_reports": oracle_reports,
        "technical_reasoning_only_probes": [{"family_id": f["family_id"], "probe_id": p["id"]}
            for f in families for p in f["probes"] if p["answer_validation"] != "executable"],
        "levels_by_split": {split: dict(Counter(f["level"] for f in families if splits[f["family_id"]] == split))
                            for split in ("development", "validation", "holdout")},
        "similarity_screen": {"method": "5-character shingle Jaccard after whitespace removal and digit normalization",
                              "threshold": 0.72, "purpose": "review triage; does not prove semantic novelty or absence of leakage",
                              "flagged_pairs": flagged},
        "frozen_source_sha256": {str(p.relative_to(dataset.ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(dataset.ROOT.glob("*.py")) + sorted((dataset.ROOT / "checks").glob("*.py"))},
        "data_manifest_sha256": hashlib.sha256((dataset.ROOT / "data/manifest.json").read_bytes()).hexdigest(),
        "claims_excluded": ["real learner accuracy", "learning gains", "teacher endorsement", "product pass rate", "ablation effect", "blind holdout"],
    })
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = run_audit()
    if args.output:
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    # Keep the terminal concise. Full independent oracle evidence goes into the report.
    print(json.dumps({k: v for k, v in report.items() if k not in {"oracle_reports", "frozen_source_sha256", "similarity_screen"}}, ensure_ascii=False, indent=2))
    print(json.dumps({"similarity_candidates": len(report["similarity_screen"]["flagged_pairs"]),
                      "cross_split_candidates": sum(p["cross_split"] for p in report["similarity_screen"]["flagged_pairs"]),
                      "full_report": str(args.output) if args.output else None}, ensure_ascii=False))


if __name__ == "__main__":
    main()
