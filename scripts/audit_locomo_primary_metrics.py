#!/usr/bin/env python3
"""Post-hoc LoCoMo main-class audit; no product imports, QA text or gold changes.

Example:
  python3 learnflow-locomo-main-audit-v1.py --current CURRENT.jsonl.gz \
    --baseline BASELINE.jsonl.gz --output NEW_AUDIT.json

Use the same script and unchanged baseline for formal-03. Output must not exist.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import sys

METRICS = ("full_text_recall", "full_evidence_complete")
REPETITIONS = 2000
SEED_PREFIX = "20260908"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as stream:
        rows = [json.loads(line) for line in stream if line.strip()]
    keys = [(r["case_id"], r["budget"], r["variant"]) for r in rows]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate trial conditions")
    return rows


def main_rows(rows):
    return [r for r in rows if r["category"] in (1, 2, 4)
            and r["scoring_status"] == "valid"]


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def metric_summary(rows, metric):
    values = [r["metrics"].get(metric) for r in rows]
    measured = [v for v in values if finite(v)]
    out = {"mean": statistics.mean(measured) if measured else None,
           "denominator": len(measured), "NA": len(rows) - len(measured)}
    if metric == "full_evidence_complete":
        out.update({"passed": sum(measured), "failed": len(measured) - sum(measured)})
    return out


def group_summary(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["budget"], row["variant"])].append(row)
    result = []
    for (budget, variant), members in sorted(groups.items()):
        main = main_rows(members)
        multi = [r for r in main if r["category"] == 1]
        categories = Counter((r["category"], r["scoring_status"]) for r in members)
        components = {}
        for key in sorted({k for r in members for k in r["metrics"] if k.startswith("component_")}):
            values = [r["metrics"].get(key) for r in main]
            measured = [v for v in values if finite(v)]
            components[key] = {"sum": sum(measured) if measured else None,
                               "nonzero_conditions": sum(v != 0 for v in measured),
                               "denominator": len(measured), "NA": len(main) - len(measured)}
        result.append({"budget": budget, "variant": variant, "all_conditions": len(members),
            "scoring_status": dict(Counter(r["scoring_status"] for r in members)),
            "category_status": [{"category": c, "scoring_status": s, "count": n}
                                for (c, s), n in sorted(categories.items())],
            "overall_metric_denominators": {m: metric_summary(members, m) for m in METRICS},
            "main": {"conditions": len(main), "clusters": len({r["conversation_id"] for r in main}),
                     "metrics": {m: metric_summary(main, m) for m in METRICS},
                     "zero_full_text_recall": sum(r["metrics"].get("full_text_recall") == 0 for r in main)},
            "multi_hop_category_1": {"conditions": len(multi),
                     "metrics": {m: metric_summary(multi, m) for m in METRICS}},
            "main_components": components,
            "budget_ok": metric_summary(members, "budget_ok"),
            "attribution_error_count": sum(r["metrics"].get("attribution_error_count", 0) for r in members),
            "repeat_stable": metric_summary(members, "repeat_stable"),
            "tokens_estimate": metric_summary(members, "tokens_estimate")})
    return result


def percentile(values, p):
    values = sorted(values)
    position = (len(values) - 1) * p
    lo, hi = math.floor(position), math.ceil(position)
    return values[lo] + (values[hi] - values[lo]) * (position - lo)


def paired(left, right, label, seed_variant):
    indexed = {(r["case_id"], r["budget"]): r for r in right}
    results = []
    for budget in sorted({r["budget"] for r in left}):
        base = [r for r in left if r["budget"] == budget]
        for metric in METRICS:
            groups = defaultdict(list)
            unmatched = missing = 0
            for a in base:
                b = indexed.get((a["case_id"], budget))
                if b is None:
                    unmatched += 1
                    continue
                if a["conversation_id"] != b["conversation_id"]:
                    raise ValueError("Mismatched conversation identity")
                x, y = a["metrics"].get(metric), b["metrics"].get(metric)
                if not finite(x) or not finite(y):
                    missing += 1
                    continue
                groups[a["conversation_id"]].append(float(x) - float(y))
            cluster_values = [statistics.mean(v) for _, v in sorted(groups.items())]
            all_values = [v for values in groups.values() for v in values]
            seed_text = f"{SEED_PREFIX}:{budget}:{seed_variant}:{metric}"
            seed = int(hashlib.sha256(seed_text.encode()).hexdigest()[:16], 16)
            rng = random.Random(seed)
            distribution = [statistics.mean(rng.choices(cluster_values, k=len(cluster_values)))
                            for _ in range(REPETITIONS)] if len(cluster_values) >= 2 else []
            results.append({"budget": budget, "comparison": label, "metric": metric,
                "paired_cases": len(all_values), "clusters": len(cluster_values),
                "case_weighted_delta": statistics.mean(all_values) if all_values else None,
                "cluster_equal_weight_delta": statistics.mean(cluster_values) if cluster_values else None,
                "cluster_bootstrap_95_interval": [percentile(distribution, .025), percentile(distribution, .975)] if distribution else None,
                "full_better": sum(v > 0 for v in all_values), "ties": sum(v == 0 for v in all_values),
                "full_worse": sum(v < 0 for v in all_values),
                "unmatched_full_cases": unmatched, "unmeasured_pairs": missing,
                "bootstrap_repetitions": REPETITIONS if distribution else 0,
                "seed_material": seed_text, "seed_integer": seed})
    return results


def audit(current, baseline):
    # Each current condition matrix must be complete. Baseline may have fewer arms.
    for rows in (current, baseline):
        case_meta = {}
        for row in rows:
            meta = (row["category"], row["scoring_status"], row["conversation_id"])
            if row["case_id"] in case_meta and case_meta[row["case_id"]] != meta:
                raise ValueError("Condition-dependent annotation metadata")
            case_meta[row["case_id"]] = meta
        expected = len(case_meta) * len({r["variant"] for r in rows}) * len({r["budget"] for r in rows})
        if len(rows) != expected:
            raise ValueError("Incomplete condition matrix")
    new_meta = {r["case_id"]: (r["category"], r["scoring_status"], r["conversation_id"]) for r in current}
    old_meta = {r["case_id"]: (r["category"], r["scoring_status"], r["conversation_id"]) for r in baseline}
    if new_meta != old_meta:
        raise ValueError("Current/baseline case annotations differ")
    new, old = main_rows(current), main_rows(baseline)
    full = [r for r in new if r["variant"] == "full"]
    pairs = []
    for variant in sorted({r["variant"] for r in new} - {"full"}):
        pairs += paired(full, [r for r in new if r["variant"] == variant], f"full-minus-{variant}", variant)
    pairs += paired(full, [r for r in old if r["variant"] == "full"], "full-minus-old_full", "old_full")
    return {"current_conditions": len(current), "baseline_conditions": len(baseline),
            "annotation_metadata_identical": True, "complete_condition_matrices": True,
            "current_groups": group_summary(current), "baseline_groups": group_summary(baseline),
            "main_paired_comparisons": pairs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    inputs = {name: {"path": str(path.absolute()), "sha256": sha(path)}
              for name, path in (("current", args.current), ("baseline", args.baseline))}
    result = audit(read(args.current), read(args.baseline))
    if any(sha(Path(value["path"])) != value["sha256"] for value in inputs.values()):
        raise ValueError("Input changed during audit")
    result.update({"schema": "learnflow.locomo-main-posthoc-audit.v1", "post_hoc_audit": True,
        "script": {"path": str(Path(__file__).absolute()), "sha256": sha(Path(__file__))},
        "inputs": inputs, "inputs_unchanged": True,
        "reproduction_argv": [sys.executable, str(Path(__file__).absolute()), "--current", str(args.current.absolute()),
                              "--baseline", str(args.baseline.absolute()), "--output", "NEW_OUTPUT_PATH.json"],
        "runtime": {"python": sys.version},
        "method": {"main_filter": "category in [1,2,4] and scoring_status == valid",
            "multi_hop_filter": "main filter and category == 1", "cluster": "conversation_id",
            "repetitions": REPETITIONS, "seed_prefix": SEED_PREFIX,
            "seed_rule": "int(sha256(f'20260908:{budget}:{comparison_variant}:{metric}').hexdigest()[:16], 16)",
            "bootstrap": "Python random.Random(seed).choices over sorted equal-weight per-conversation mean paired differences; 2.5/97.5 linear percentiles",
            "provenance": "Same fixed algorithm as frozen education_memory_v2/analyze.py, implemented independently here with main-only filtering."},
        "interpretation": ["Post-hoc audit, not a changed frozen primary score or gold.",
            "1438 valid main questions and 89 valid category-3 questions make the 1527 overall metric denominator; 446 adversarial and 13 invalid questions are NA for recall/complete.",
            "Intervals describe this fixed corpus with equal conversation weighting. Ten dialogue clusters are not a population sample; no general or universal improvement claim.",
            "Case-weighted point differences and equal-cluster-weight point differences are different estimands.",
            "LoCoMo evaluates attributed full original text delivery, not generated answer accuracy, real learner benefit or native memory formation.",
            "Cross-version comparisons combine retrieval changes and expanded budget payload accounting; they do not isolate a single causal component.",
            "Null or unavailable measurements are NA, never counted as passing. Repeat stability is not measured.",
            "Frozen analyze.py requested annotation_status breakdown but trials export scoring_status; this audit supplies scoring_status groups without changing frozen files."]})
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"output": str(args.output.absolute()), "sha256": sha(args.output),
                      "current_conditions": len(read(args.current)), "post_hoc_audit": True}))


if __name__ == "__main__":
    main()
