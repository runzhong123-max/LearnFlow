"""Shared candidate-provider contract, run independently in both hosts."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from learnflow_core import memory_candidates as candidates
from learnflow_core.memory_query import plan_query, resolve_fuzzy


def test_default_import_and_bm25_do_not_import_ml_or_load_a_model():
    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(candidates.__file__).parents[1])
    script = """
import sys
from learnflow_core.memory_candidates import rank_candidates
result = rank_candidates('binary search', {1: 'binary search', 2: 'SQL joins'})
assert result.ordered_ids == (1,)
assert not {'torch', 'numpy', 'sentence_transformers', 'transformers'} & sys.modules.keys()
"""
    subprocess.run([sys.executable, "-c", script], env=env, check=True, capture_output=True, text=True)


def test_bm25_searches_all_supplied_documents_and_preserves_identifier_types():
    docs = {index: "unrelated discussion" for index in range(2500)}
    docs[2501] = "amortized analysis of dynamic arrays"
    docs["2501"] = "amortized analysis of dynamic arrays"
    result = candidates.rank_candidates("amortized", docs, limit=2)
    reverse = candidates.rank_candidates("amortized", dict(reversed(list(docs.items()))), limit=2)
    assert result.ordered_ids == (2501, "2501")
    assert result.ordered_ids == reverse.ordered_ids
    assert result.diagnostics["bm25_documents"] == 2502
    assert result.scores[2501]["bm25"] > 0


def test_alias_ablation_and_chinese_literal_retrieval_are_real():
    docs = {1: "多版本并发控制", 2: "二分查找的边界"}
    assert candidates.rank_candidates("mvcc", docs).ordered_ids == (1,)
    no_aliases = candidates.rank_candidates("mvcc", docs, enable_aliases=False)
    assert no_aliases.ordered_ids == ()
    assert no_aliases.diagnostics["aliases_enabled"] is False
    assert candidates.rank_candidates("二分查找", docs, enable_aliases=False).ordered_ids == (2,)


def test_caller_resolved_fuzzy_plan_is_preserved_and_alias_policy_cannot_be_bypassed():
    query = "transactoin"
    docs = {1: "transaction isolation"}
    plan = resolve_fuzzy(plan_query(query, enable_aliases=False), docs.values())
    assert candidates.rank_candidates(query, docs, enable_aliases=False).ordered_ids == ()
    corrected = candidates.rank_candidates(query, docs, enable_aliases=False, lexical_plan=plan)
    assert corrected.ordered_ids == (1,)
    assert corrected.diagnostics["fuzzy_corrections_applied"] == 1
    with pytest.raises(ValueError, match="aliases conflict"):
        candidates.rank_candidates("mvcc", docs, enable_aliases=False, lexical_plan=plan_query("mvcc"))


def test_bm25_off_does_not_leave_a_hidden_lexical_lane(monkeypatch):
    docs = {1: "literal phrase", 2: "paraphrased evidence"}
    assert candidates.rank_candidates("literal", docs, enable_bm25=False).ordered_ids == ()
    monkeypatch.setattr(candidates, "_semantic_scores", lambda *args, **kwargs: (
        {1: .2, 2: .8}, {"semantic_used": True},
    ))
    result = candidates.rank_candidates("literal", docs, mode="hybrid", enable_bm25=False)
    assert result.ordered_ids == (2,)
    assert result.diagnostics["bm25_candidates"] == 0
    assert result.scores[2]["bm25_rank"] == 0


def test_semantic_zero_lexical_candidate_is_not_prefiltered_and_threshold_is_applied(monkeypatch):
    docs = {1: "binary search", 2: "halving the sorted interval", 3: "tomatoes"}

    def semantic(query, documents, **kwargs):
        assert set(documents) == {1, 2, 3}
        return {1: .7, 2: .9, 3: .1}, {"semantic_used": True}

    monkeypatch.setattr(candidates, "_semantic_scores", semantic)
    result = candidates.rank_candidates("binary search", docs, mode="hybrid", limit=5)
    assert set(result.ordered_ids) == {1, 2}
    assert result.scores[2]["bm25"] == 0
    assert result.scores[2]["semantic_rank"] == 1
    assert result.scores[1]["rrf"] == pytest.approx(1 / 61 + 1 / 62)
    assert result.scores[2]["rrf"] == pytest.approx(1 / 61)


def test_provider_does_not_cache_corpus_ids_results_or_text(monkeypatch):
    seen = []

    def semantic(query, documents, **kwargs):
        seen.append(dict(documents))
        return {key: .9 for key in documents}, {"semantic_used": True}

    monkeypatch.setattr(candidates, "_semantic_scores", semantic)
    first = candidates.rank_candidates("needle", {1: "needle private-learner-a"}, mode="hybrid")
    second = candidates.rank_candidates("needle", {2: "different private-learner-b"}, mode="hybrid")
    assert first.ordered_ids == (1,)
    assert second.ordered_ids == (2,)
    assert set(second.scores) == {2}
    assert seen == [{1: "needle private-learner-a"}, {2: "different private-learner-b"}]
    serialized = json.dumps(second.diagnostics)
    assert "needle" not in serialized
    assert "private-learner" not in serialized


def test_bm25_character_truncation_is_reported_instead_of_hidden():
    result = candidates.rank_candidates("needle", {1: "x" * 66000 + " needle"})
    assert result.ordered_ids == ()
    assert result.diagnostics["bm25_truncated_documents"] == 1
    assert result.diagnostics["bm25_document_char_limit"] == 65536


def test_hybrid_failure_never_returns_a_successful_bm25_fallback(monkeypatch):
    def unavailable(*args, **kwargs):
        raise candidates.SemanticModelUnavailable("incomplete local snapshot")

    monkeypatch.setattr(candidates, "_semantic_scores", unavailable)
    with pytest.raises(candidates.SemanticModelUnavailable, match="incomplete"):
        candidates.rank_candidates("exact", {1: "exact"}, mode="hybrid")


@pytest.mark.parametrize("query,docs,limit", [("", {1: "x"}, 80), ("x", {}, 80), ("x", {1: "x"}, 0)])
def test_empty_work_does_not_load_semantic_model(monkeypatch, query, docs, limit):
    def forbidden(*args, **kwargs):
        raise AssertionError("model must stay lazy")

    monkeypatch.setattr(candidates, "_semantic_scores", forbidden)
    assert candidates.rank_candidates(query, docs, mode="hybrid", limit=limit).ordered_ids == ()


def test_incomplete_tokenizer_fails_closed_before_encoding():
    tokenizer = SimpleNamespace(get_vocab=lambda: {str(index): index for index in range(5)})
    auto_model = SimpleNamespace(get_input_embeddings=lambda: SimpleNamespace(num_embeddings=30522))

    class IncompleteModel:
        def __init__(self):
            self.tokenizer = tokenizer

        def __getitem__(self, index):
            return SimpleNamespace(auto_model=auto_model)

    with pytest.raises(candidates.SemanticModelUnavailable, match="vocabulary"):
        candidates._validate_tokenizer(IncompleteModel())


@pytest.fixture
def synthetic_encoder(monkeypatch):
    """Controlled vectors test cache/window mechanics, never semantic quality."""
    np = pytest.importorskip("numpy")
    pytest.importorskip("torch")
    candidates.clear_candidate_caches()
    monkeypatch.setattr(candidates, "SEMANTIC_OVERLAP", 2)
    tokenizer = SimpleNamespace(
        encode=lambda text, **kwargs: [int(word) for word in text.split()], unk_token_id=-1,
    )
    state = {"identity": "synthetic-model-a", "calls": []}

    def load(model_id, threads):
        return candidates._Encoder(SimpleNamespace(tokenizer=tokenizer), state["identity"], 7, 5)

    def encode(encoder, windows, batch_size):
        state["calls"].append([list(window) for window in windows])
        vectors = np.asarray([[sum(window) + 1, len(window) + 1] for window in windows], dtype=np.float32)
        return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)

    monkeypatch.setattr(candidates, "_load_encoder", load)
    monkeypatch.setattr(candidates, "_encode_batches", encode)
    yield state
    candidates.clear_candidate_caches()


def test_vector_cache_reuses_content_but_not_ids_scope_or_changed_body(synthetic_encoder):
    first = candidates.rank_candidates("1 2", {11: "2 3", 12: "4 5"}, mode="hybrid")
    second = candidates.rank_candidates("1 2", {901: "2 3"}, mode="hybrid")
    assert second.ordered_ids == (901,)
    assert second.diagnostics["semantic_encoded_windows"] == 0
    assert second.diagnostics["semantic_cache_hits"] == 2
    changed = candidates.rank_candidates("1 2", {901: "2 3 4"}, mode="hybrid")
    assert changed.diagnostics["semantic_cache_misses"] == 1
    assert changed.diagnostics["semantic_encoded_windows"] == 1
    assert first.diagnostics["semantic_cache_misses"] == 3
    assert all(len(key[2]) == 64 for key in candidates._VECTOR_CACHE)


def test_vector_cache_is_model_specific_and_bounded(synthetic_encoder, monkeypatch):
    monkeypatch.setattr(candidates, "MAX_VECTOR_CACHE_ENTRIES", 2)
    monkeypatch.setattr(candidates, "MAX_VECTOR_CACHE_BYTES", 16)
    first = candidates.rank_candidates("1", {1: "2", 2: "3", 3: "4"}, mode="hybrid")
    assert first.diagnostics["semantic_cache_entries"] <= 2
    assert first.diagnostics["semantic_cache_bytes"] <= 16
    synthetic_encoder["identity"] = "synthetic-model-b"
    other_model = candidates.rank_candidates("1", {9: "4"}, mode="hybrid")
    assert other_model.diagnostics["semantic_cache_hits"] == 0


def test_long_documents_are_fully_windowed_and_query_truncation_is_disclosed(synthetic_encoder):
    result = candidates.rank_candidates(
        "1 2 3 4 5 6 7", {8: "1 2 3 4 5 6 7 8 9"}, mode="hybrid",
    )
    assert synthetic_encoder["calls"] == [[[1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [4, 5, 6, 7, 8], [7, 8, 9]]]
    assert result.diagnostics["semantic_query_truncated_tokens"] == 2
    assert result.diagnostics["semantic_document_truncated_characters"] == 0
    assert result.diagnostics["semantic_document_windows"] == 3
    assert result.diagnostics["semantic_windowed_documents"] == 1


def test_semantic_character_limits_and_window_budget_fail_explicitly(synthetic_encoder, monkeypatch):
    monkeypatch.setattr(candidates, "MAX_TEXT_CHARS", 5)
    monkeypatch.setattr(candidates, "MAX_QUERY_CHARS", 3)
    result = candidates.rank_candidates("1 2 3", {1: "1 2 3 4 5"}, mode="hybrid")
    assert result.diagnostics["semantic_query_truncated_characters"] == 2
    assert result.diagnostics["semantic_document_truncated_characters"] == 4
    assert result.diagnostics["semantic_character_truncated_documents"] == 1
    assert result.diagnostics["semantic_document_tokens"] == 3
    candidates.clear_candidate_caches()
    monkeypatch.setattr(candidates, "MAX_ENCODE_WINDOWS_PER_CALL", 1)
    with pytest.raises(candidates.SemanticModelUnavailable, match="window budget"):
        candidates.rank_candidates("1 2 3", {1: "1 2 3 4 5"}, mode="hybrid")


@pytest.mark.parametrize("kwargs", [
    {"mode": "fake_semantic"}, {"limit": -1}, {"rrf_k": 0},
    {"semantic_threshold": float("nan")}, {"semantic_threshold": 1.01},
    {"semantic_threads": 0}, {"enable_bm25": "false"}, {"enable_aliases": "false"},
])
def test_invalid_configuration_is_rejected(kwargs):
    with pytest.raises((ValueError, TypeError)):
        candidates.rank_candidates("test", {1: "test"}, **kwargs)


@pytest.mark.skipif(os.environ.get("LEARNFLOW_TEST_LOCAL_SEMANTIC") != "1",
                    reason="explicit offline model integration check; no downloads in the test suite")
def test_real_local_semantic_paraphrase_and_repeated_query_cache():
    candidates.clear_candidate_caches()
    docs = {1: "The car broke down.", 2: "A student solved a differential equation.",
            3: "A tomato grows in the garden."}
    first = candidates.rank_candidates("An automobile malfunctioned.", docs, mode="hybrid", enable_aliases=False)
    assert first.ordered_ids[0] == 1
    assert first.scores[1]["bm25"] == 0
    assert first.scores[1]["semantic_cosine"] > first.scores[2]["semantic_cosine"]
    assert first.diagnostics["semantic_query_unknown_tokens"] == 0
    assert first.diagnostics["semantic_dimension"] == 384
    assert len(first.diagnostics["semantic_model_sha256"]) == 64
    # Compare the manual ID-window path with the model's public short-text
    # encoder; this detects missing/misordered special tokens and wrong pooling.
    import numpy as np
    public_vectors = candidates._MODEL[1].model.encode(
        ["An automobile malfunctioned.", docs[1]], normalize_embeddings=True,
        show_progress_bar=False, convert_to_numpy=True,
    )
    public_cosine = float(np.dot(public_vectors[0], public_vectors[1]))
    assert first.scores[1]["semantic_cosine"] == pytest.approx(public_cosine, abs=1e-5)
    second = candidates.rank_candidates("An automobile malfunctioned.", docs, mode="hybrid", enable_aliases=False)
    assert second.ordered_ids == first.ordered_ids
    assert second.diagnostics["semantic_encoded_windows"] == 0
    candidates.clear_candidate_caches()
