"""Explicit read-time interventions and independently implemented budget contract.

Never imports product code. This driver helper is not the verifier: the verifier
keeps its own public-payload reconstruction to detect omissions here.
"""
from dataclasses import replace
import json
import math

COMPONENT_FIELDS = ("enable_episodes", "max_episodes", "max_episode_facts", "enable_bm25",
                    "enable_aliases", "enable_fuzzy", "enable_temporal", "enable_summary_boost")
COMPONENT_VARIANTS = {"no_episodes": "enable_episodes", "no_bm25": "enable_bm25",
                      "no_aliases": "enable_aliases", "no_fuzzy": "enable_fuzzy",
                      "no_temporal": "enable_temporal", "no_summary_boost": "enable_summary_boost"}
EDUCATION_VARIANTS = ("full", "facts_only", "recent_facts", "no_relations", "no_guidance",
                      *COMPONENT_VARIANTS, "no_memory")
LOCOMO_VARIANTS = ("full", "recent_facts", "no_bm25", "no_aliases", "no_fuzzy",
                   "no_temporal", "no_memory")


def policy_for(base, variant, budget):
    changes = {"token_budget": budget}
    if variant in COMPONENT_VARIANTS:
        changes[COMPONENT_VARIANTS[variant]] = False
    if variant == "no_relations":
        changes["max_paths"] = 0
    return replace(base, **changes)


def budget_body(packet):
    return {"heads": packet.get("kernel_heads", {}), "items": packet.get("items", []),
            "paths": packet.get("relation_paths", []),
            "personal_concept_graph": packet.get("personal_concept_graph", {}),
            "adaptation_directives": packet.get("adaptation_directives", []),
            "teaching_guidance": packet.get("teaching_guidance", []),
            "learning_episodes": packet.get("learning_episodes", []),
            "retrieval_diagnostics": packet.get("retrieval_diagnostics", {}),
            "component_policy": {name: (packet.get("manifest", {}).get("policy", {}) or {}).get(name)
                                 for name in COMPONENT_FIELDS}}


def packet_tokens(packet):
    return max(1, math.ceil(len(json.dumps(budget_body(packet), ensure_ascii=False,
                                         sort_keys=True, default=str)) / 3.2))


def activation_metrics(packet):
    """Report actual component work separately from whether it was configured.

    A missing diagnostic is unmeasured, never zero. Alias/fuzzy activation is
    query transformation, temporal activation is candidate-slot allocation,
    BM25 matched is a candidate score; none alone proves evidence delivery.
    """
    diagnostics = packet.get("retrieval_diagnostics") or {}
    parts = diagnostics.get("components") or {}
    result = {"episode_count": len(packet.get("learning_episodes") or []),
              "episode_observation_count": sum(len(row.get("observations") or [])
                                               for row in packet.get("learning_episodes") or [])}
    fields = {"bm25": ("enabled", "documents", "matched", "selected"),
              "aliases": ("enabled", "activated"), "fuzzy": ("enabled", "activated"),
              "temporal": ("enabled", "activated"), "summary_boost": ("enabled", "activated"),
              "paths": ("enabled", "selected", "eligible_bundles", "candidate_edges", "root_limit_omitted")}
    for component, names in fields.items():
        values = parts.get(component) or {}
        for name in names:
            value = values.get(name)
            result[f"component_{component}_{name}"] = value if type(value) in (bool, int, float) else None
    episodes = diagnostics.get("episodes") or {}
    for name in ("enabled", "eligible", "selected", "budget_omitted", "limit_omitted", "fact_limit_omitted"):
        value = episodes.get(name)
        result[f"component_episodes_{name}"] = value if type(value) in (bool, int, float) else None
    rejected = episodes.get("rejected")
    result["component_episodes_rejected"] = sum(rejected.values()) if isinstance(rejected, dict) and all(
        type(v) is int for v in rejected.values()) else None
    return result
