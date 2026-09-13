"""Rebuildable retrieval over a caller-authorized corpus, never learner state.

The caller MUST filter ownership, scope, sensitive and archived material before
calling this module. It has no database access and never caches IDs, text,
corpora or rankings. Only content-addressed float32 embeddings are cached, in
bounded process memory. BM25 uses the existing query/alias policy over *all*
supplied documents; it is not a lexical prefilter for the semantic channel.

Hybrid is opt-in and strictly offline. No model or ML library is imported at
module import time. Missing dependencies, files or an incomplete tokenizer are
errors, never a successful lexical fallback. thenlper/gte-small is an English
model; Chinese retrieval quality must be evaluated independently.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
import math
import os
from threading import RLock
from typing import Any, Mapping

from learnflow_core.memory_query import MAX_QUERY_CHARS, MAX_TEXT_CHARS, QueryPlan, bm25_scores, plan_query


PROVIDER_VERSION = "scoped-memory-candidates.v1"
DEFAULT_SEMANTIC_MODEL = "thenlper/gte-small"
SEMANTIC_SEGMENTATION = "token-window-max-minus-special-overlap64-max-cosine.v1"
SEMANTIC_OVERLAP = 64
MAX_VECTOR_CACHE_ENTRIES = 16_384
MAX_VECTOR_CACHE_BYTES = 64 * 1024 * 1024
MAX_ENCODE_WINDOWS_PER_CALL = 32_768
DocumentId = int | str


class SemanticModelUnavailable(RuntimeError):
    """The requested offline semantic channel could not run faithfully."""


@dataclass(frozen=True)
class CandidateRanking:
    ordered_ids: tuple[DocumentId, ...]
    scores: dict[DocumentId, dict[str, float | int]]
    diagnostics: dict[str, str | float | int | bool]


@dataclass(frozen=True)
class _Embedding:
    vectors: Any
    tokens: int
    unknown_tokens: int
    truncated_tokens: int
    truncated_characters: int


@dataclass(frozen=True)
class _Encoder:
    model: Any
    identity: str
    max_tokens: int
    content_tokens: int


_LOCK = RLock()
# At most one loaded model. The vector cache may contain several model hashes,
# but different models/segmenters/roles never share a cache key.
_MODEL: tuple[str, _Encoder] | None = None
_VECTOR_CACHE: OrderedDict[tuple[str, str, str], _Embedding] = OrderedDict()
_VECTOR_CACHE_BYTES = 0


def clear_candidate_caches() -> None:
    """Release process-local derived vectors and the lazy model, not source data."""
    global _MODEL, _VECTOR_CACHE_BYTES
    with _LOCK:
        _MODEL = None
        _VECTOR_CACHE.clear()
        _VECTOR_CACHE_BYTES = 0


def _identifier_order(identifier: DocumentId) -> tuple[int, int | str]:
    return (0, identifier) if isinstance(identifier, int) else (1, identifier)


def _fingerprint_model(model: Any) -> str:
    """Hash loaded config, tokenizer and weights once; never hash user text here."""
    digest = hashlib.sha256()
    auto_model = model[0].auto_model
    config = auto_model.config.to_dict()
    config.pop("_name_or_path", None)
    digest.update(json.dumps(config, sort_keys=True, default=str).encode())
    vocabulary = sorted(model.tokenizer.get_vocab().items(), key=lambda item: item[0])
    digest.update(json.dumps(vocabulary, ensure_ascii=True, separators=(",", ":")).encode())
    backend = getattr(model.tokenizer, "backend_tokenizer", None)
    if backend is not None:
        digest.update(backend.to_str().encode())
    else:
        settings = dict(getattr(model.tokenizer, "init_kwargs", {}))
        for key in ("name_or_path", "vocab_file", "tokenizer_file", "special_tokens_map_file"):
            settings.pop(key, None)
        digest.update(json.dumps(settings, sort_keys=True, default=str).encode())
    digest.update(json.dumps(model[1].get_config_dict(), sort_keys=True).encode())
    # This binds even a locally supplied snapshot to its actual weights. A
    # matching model name alone is not proof that the same model was loaded.
    for name, tensor in sorted(auto_model.state_dict().items()):
        digest.update(name.encode())
        digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    digest.update(SEMANTIC_SEGMENTATION.encode())
    return digest.hexdigest()


def _validate_tokenizer(model: Any) -> None:
    tokenizer = model.tokenizer
    embedding_size = model[0].auto_model.get_input_embeddings().num_embeddings
    # Some Transformers versions silently create a five-special-token BERT
    # vocabulary when the cached weights exist but tokenizer files do not.
    # Such a model emits vectors successfully while every word becomes UNK.
    vocabulary = tokenizer.get_vocab()
    if len(vocabulary) != embedding_size or len(vocabulary) < 100:
        raise SemanticModelUnavailable(
            "Offline tokenizer vocabulary does not match model embeddings; "
            "complete the same model snapshot before enabling semantic retrieval."
        )
    probe = tokenizer.encode("a student studies computer science", add_special_tokens=False)
    unknown_id = tokenizer.unk_token_id
    if not probe or (unknown_id is not None and all(token == unknown_id for token in probe)):
        raise SemanticModelUnavailable("Offline tokenizer maps ordinary English entirely to UNK.")


def _load_encoder(model_id: str, threads: int) -> _Encoder:
    global _MODEL
    model_path = (os.environ.get("LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH")
                  if model_id == DEFAULT_SEMANTIC_MODEL else None)
    location = model_path or model_id
    # Include the path in the loader key, not in user-facing diagnostics.
    if _MODEL is not None and _MODEL[0] == location:
        return _MODEL[1]
    try:
        import torch
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(threads)
        model = SentenceTransformer(
            location, device="cpu", local_files_only=True, trust_remote_code=False,
        )
        # Cached checkpoints may default to bf16. Normalize and score in float32.
        model.float().eval()
        _validate_tokenizer(model)
        if model[0].auto_model.config.model_type != "bert":
            raise SemanticModelUnavailable("This provider requires a BERT sentence encoder such as gte-small.")
        max_tokens = int(model.max_seq_length)
        content_tokens = max_tokens - model.tokenizer.num_special_tokens_to_add(pair=False)
        if content_tokens <= SEMANTIC_OVERLAP or max_tokens > 8192:
            raise SemanticModelUnavailable("Unsupported offline model token-window configuration.")
        encoder = _Encoder(model, _fingerprint_model(model), max_tokens, content_tokens)
    except SemanticModelUnavailable:
        raise
    except Exception as exc:
        # Avoid forwarding provider exceptions that may contain paths or input.
        raise SemanticModelUnavailable(
            "Offline semantic model unavailable; install the complete local model "
            "and dependencies or explicitly select mode='bm25'. "
            f"Failure type: {type(exc).__name__}."
        ) from None
    _MODEL = (location, encoder)
    return encoder


def _cache_put(key: tuple[str, str, str], entry: _Embedding) -> None:
    global _VECTOR_CACHE_BYTES
    size = int(entry.vectors.nbytes)
    if size > MAX_VECTOR_CACHE_BYTES or MAX_VECTOR_CACHE_ENTRIES < 1:
        return
    previous = _VECTOR_CACHE.pop(key, None)
    if previous is not None:
        _VECTOR_CACHE_BYTES -= int(previous.vectors.nbytes)
    while _VECTOR_CACHE and (
        len(_VECTOR_CACHE) >= MAX_VECTOR_CACHE_ENTRIES
        or _VECTOR_CACHE_BYTES + size > MAX_VECTOR_CACHE_BYTES
    ):
        _, removed = _VECTOR_CACHE.popitem(last=False)
        _VECTOR_CACHE_BYTES -= int(removed.vectors.nbytes)
    _VECTOR_CACHE[key] = entry
    _VECTOR_CACHE_BYTES += size


def _encode_batches(encoder: _Encoder, windows: list[list[int]], batch_size: int) -> Any:
    import numpy as np
    import torch

    chunks = []
    tokenizer = encoder.model.tokenizer
    with torch.inference_mode():
        for start in range(0, len(windows), batch_size):
            # Transformers 5 removed prepare_for_model. Build the supported
            # BERT single-sequence format from original IDs (no decode/re-tokenize
            # round trip), then let the tokenizer perform batch padding.
            if tokenizer.encode("", add_special_tokens=True) != [tokenizer.cls_token_id, tokenizer.sep_token_id]:
                raise SemanticModelUnavailable("Unexpected BERT special-token format.")
            prepared = []
            for ids in windows[start:start + batch_size]:
                input_ids = [tokenizer.cls_token_id, *ids, tokenizer.sep_token_id]
                prepared.append({"input_ids": input_ids,
                                 "attention_mask": [1] * len(input_ids),
                                 "token_type_ids": [0] * len(input_ids)})
            features = tokenizer.pad(prepared, padding=True, return_tensors="pt")
            vectors = encoder.model(dict(features))["sentence_embedding"].float()
            vectors = torch.nn.functional.normalize(vectors, p=2, dim=1)
            chunks.append(vectors.cpu().numpy().astype(np.float32, copy=False))
    output = np.concatenate(chunks, axis=0)
    if not np.isfinite(output).all() or (np.linalg.norm(output, axis=1) < .99).any():
        raise SemanticModelUnavailable("Offline semantic model returned invalid embeddings.")
    return output


def _semantic_scores(
    query: str, documents: Mapping[DocumentId, str], *, model_id: str,
    batch_size: int, threads: int,
) -> tuple[dict[DocumentId, float], dict[str, str | float | int | bool]]:
    import numpy as np
    import torch

    # Serialize load/inference/cache access within a process. Evaluation workers
    # should use spawn and set OMP/OPENBLAS/MKL threads to 1 before importing ML.
    with _LOCK:
        encoder = _load_encoder(model_id, threads)
        torch.set_num_threads(threads)
        local: dict[tuple[str, str, str], _Embedding] = {}
        pending: dict[tuple[str, str, str], tuple[int, int, int, int, int, int]] = {}
        windows: list[list[int]] = []
        hits = 0

        def obtain_key(text: str, role: str) -> tuple[str, str, str]:
            nonlocal hits
            key = (encoder.identity, role, hashlib.sha256(text.encode()).hexdigest())
            if key in local or key in pending:
                return key
            cached = _VECTOR_CACHE.get(key)
            if cached is not None:
                _VECTOR_CACHE.move_to_end(key)
                local[key] = cached
                hits += 1
                return key
            tokenizer = encoder.model.tokenizer
            character_limit = MAX_QUERY_CHARS if role == "query" else MAX_TEXT_CHARS
            omitted_characters = max(0, len(text) - character_limit)
            ids = tokenizer.encode(text[:character_limit], add_special_tokens=False, truncation=False)
            unknown = sum(token == tokenizer.unk_token_id for token in ids)
            total = len(ids)
            truncated = max(0, total - encoder.content_tokens) if role == "query" else 0
            if role == "query":
                segments = [ids[:encoder.content_tokens]]
            else:
                stride = encoder.content_tokens - SEMANTIC_OVERLAP
                segments = []
                for start in range(0, max(1, total), stride):
                    segments.append(ids[start:start + encoder.content_tokens])
                    if start + encoder.content_tokens >= total:
                        break
            offset = len(windows)
            if offset + len(segments) > MAX_ENCODE_WINDOWS_PER_CALL:
                raise SemanticModelUnavailable(
                    "Offline semantic corpus exceeds the per-call encoding window budget; "
                    "no partial ranking returned."
                )
            windows.extend(segments)
            pending[key] = (offset, len(segments), total, unknown, truncated, omitted_characters)
            return key

        query_key = obtain_key(query, "query")
        keys = {identifier: obtain_key(text, "document") for identifier, text in documents.items()}
        if windows:
            vectors = _encode_batches(encoder, windows, batch_size)
            for key, (start, count, tokens, unknown, truncated, omitted_characters) in pending.items():
                # A copy prevents an evicted entry retaining an entire batch's
                # backing array, which would defeat the byte-bound cache.
                values = vectors[start:start + count].copy()
                values.flags.writeable = False
                entry = _Embedding(values, tokens, unknown, truncated, omitted_characters)
                local[key] = entry
                _cache_put(key, entry)
        query_vector = local[query_key].vectors[0]
        scores = {identifier: float(np.clip(
            np.max(local[key].vectors @ query_vector), -1.0, 1.0,
        )) for identifier, key in keys.items()}
        entries = [local[key] for key in keys.values()]
        query_entry = local[query_key]
        return scores, {
            "semantic_used": True,
            "semantic_model": model_id,
            "semantic_model_sha256": encoder.identity,
            "semantic_language_scope": "english; multilingual quality not validated",
            "semantic_dimension": int(query_vector.shape[0]),
            "semantic_model_max_tokens": encoder.max_tokens,
            "semantic_content_window_tokens": encoder.content_tokens,
            "semantic_overlap_tokens": SEMANTIC_OVERLAP,
            "semantic_segmentation": SEMANTIC_SEGMENTATION,
            "semantic_query_tokens": query_entry.tokens,
            "semantic_query_truncated_tokens": query_entry.truncated_tokens,
            "semantic_query_char_limit": MAX_QUERY_CHARS,
            "semantic_query_truncated_characters": query_entry.truncated_characters,
            "semantic_query_unknown_tokens": query_entry.unknown_tokens,
            "semantic_document_tokens": sum(entry.tokens for entry in entries),
            "semantic_document_unknown_tokens": sum(entry.unknown_tokens for entry in entries),
            "semantic_document_char_limit": MAX_TEXT_CHARS,
            "semantic_document_truncated_characters": sum(entry.truncated_characters for entry in entries),
            "semantic_character_truncated_documents": sum(entry.truncated_characters > 0 for entry in entries),
            "semantic_document_window_coverage": "all tokens within character limit",
            "semantic_document_windows": sum(len(entry.vectors) for entry in entries),
            "semantic_windowed_documents": sum(len(entry.vectors) > 1 for entry in entries),
            "semantic_cache_hits": hits,
            "semantic_cache_misses": len(pending),
            "semantic_encoded_windows": len(windows),
            "semantic_max_encode_windows_per_call": MAX_ENCODE_WINDOWS_PER_CALL,
            "semantic_cache_entries": len(_VECTOR_CACHE),
            "semantic_cache_bytes": _VECTOR_CACHE_BYTES,
            "semantic_threads": threads,
        }


def rank_candidates(
    query: str, documents: Mapping[DocumentId, str], *, mode: str = "bm25",
    limit: int = 80, semantic_threshold: float = .35, rrf_k: int = 60,
    semantic_model: str = DEFAULT_SEMANTIC_MODEL, semantic_batch_size: int = 32,
    semantic_threads: int = 1, enable_aliases: bool = True, enable_bm25: bool = True,
    lexical_plan: QueryPlan | None = None,
) -> CandidateRanking:
    """Rank every document in the already filtered scope; preserve int/string IDs.

    BM25 uses the existing bounded tokenizer (65,536 characters/document and
    4,096 characters/query), explicitly reported below. Hybrid embeds every
    document's first 65,536 characters with overlapping token windows and
    max-window cosine. Queries use at most 4,096 characters and the first model
    window; both kinds of truncation are disclosed separately. RRF combines the complete
    positive-BM25 list with the complete above-threshold semantic list, then
    applies ``limit``. A semantic candidate needs no lexical match. Empty query,
    empty corpus or limit=0 return without loading a model.

    Scores describe returned IDs only. Diagnostics contain no query text, source
    text, gold answers, references, corpus IDs or cached retrieval results.
    Keyword aliases are the existing versioned QueryPlan table; no fuzzy or LLM
    expansion is performed here. ``enable_aliases`` must follow caller policy.
    A supplied ``lexical_plan`` preserves the caller's already scoped fuzzy
    corrections; it must use the same alias policy. Semantic search always
    embeds the original query, never query-plan terms or gold/reference data.
    """
    if mode not in {"bm25", "hybrid"}:
        raise ValueError("mode must be 'bm25' or 'hybrid'")
    if not isinstance(query, str):
        raise TypeError("query must be a string")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
        raise ValueError("limit must be a nonnegative integer")
    if not isinstance(rrf_k, int) or isinstance(rrf_k, bool) or rrf_k < 1:
        raise ValueError("rrf_k must be a positive integer")
    if not math.isfinite(semantic_threshold) or not -1 <= semantic_threshold <= 1:
        raise ValueError("semantic_threshold must be finite and between -1 and 1")
    for value, name in ((semantic_batch_size, "semantic_batch_size"), (semantic_threads, "semantic_threads")):
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f"{name} must be a positive integer")
    if not isinstance(semantic_model, str) or not semantic_model.strip():
        raise ValueError("semantic_model must be a nonempty local model identifier")
    if not isinstance(enable_aliases, bool):
        raise TypeError("enable_aliases must be a boolean")
    if not isinstance(enable_bm25, bool):
        raise TypeError("enable_bm25 must be a boolean")
    if lexical_plan is not None and not isinstance(lexical_plan, QueryPlan):
        raise TypeError("lexical_plan must be a QueryPlan")
    if lexical_plan is not None and not enable_aliases and lexical_plan.audit.get("aliases"):
        raise ValueError("lexical_plan aliases conflict with enable_aliases=False")
    for identifier, text in documents.items():
        if isinstance(identifier, bool) or not isinstance(identifier, (int, str)):
            raise TypeError("document IDs must be integers or strings")
        if not isinstance(text, str):
            raise TypeError("document values must be strings")
    # Copy the current scope so mutation by a caller cannot change IDs mid-rank.
    corpus = dict(documents)
    diagnostics: dict[str, str | float | int | bool] = {
        "provider_version": PROVIDER_VERSION, "mode": mode,
        "documents": len(corpus), "limit": limit, "semantic_used": False,
        "semantic_threshold": semantic_threshold, "rrf_k": rrf_k,
        "aliases_enabled": enable_aliases, "bm25_enabled": enable_bm25, "fuzzy_enabled": False,
    }
    if not corpus or not query.strip() or limit == 0:
        diagnostics.update({"returned": 0, "bm25_candidates": 0, "semantic_candidates": 0})
        return CandidateRanking((), {}, diagnostics)
    plan = lexical_plan if lexical_plan is not None else plan_query(query, enable_aliases=enable_aliases)
    lexical, lexical_stats = bm25_scores(plan, corpus) if enable_bm25 else ({}, {
        "documents": 0, "text_limit": MAX_TEXT_CHARS, "truncated_documents": 0,
    })
    lexical_ids = sorted(lexical, key=lambda identifier: (-lexical[identifier], _identifier_order(identifier)))
    diagnostics.update({
        "bm25_candidates": len(lexical), "bm25_documents": lexical_stats["documents"],
        "bm25_document_char_limit": lexical_stats["text_limit"],
        "bm25_truncated_documents": lexical_stats["truncated_documents"],
        "bm25_query_char_limit": MAX_QUERY_CHARS,
        "bm25_query_truncated": bool(plan.audit["query_truncated"]),
        "bm25_query_terms_truncated": bool(plan.audit["terms_truncated"]),
        "bm25_query_terms": len(plan.terms), "alias_version": plan.audit["alias_version"],
        "fuzzy_corrections_applied": len(plan.audit.get("fuzzy_corrections", [])),
    })
    semantic: dict[DocumentId, float] = {}
    semantic_ids: list[DocumentId] = []
    if mode == "hybrid":
        try:
            semantic, semantic_stats = _semantic_scores(
                query, corpus, model_id=semantic_model, batch_size=semantic_batch_size,
                threads=semantic_threads,
            )
        except SemanticModelUnavailable:
            raise
        except Exception as exc:
            raise SemanticModelUnavailable(
                f"Offline semantic retrieval failed ({type(exc).__name__}); no ranking returned."
            ) from None
        diagnostics.update(semantic_stats)
        semantic_ids = sorted(
            (identifier for identifier, score in semantic.items() if score >= semantic_threshold),
            key=lambda identifier: (-semantic[identifier], _identifier_order(identifier)),
        )
    lexical_ranks = {identifier: rank for rank, identifier in enumerate(lexical_ids, 1)}
    semantic_ranks = {identifier: rank for rank, identifier in enumerate(semantic_ids, 1)}
    rrf = {identifier: (1 / (rrf_k + lexical_ranks[identifier]) if identifier in lexical_ranks else 0)
           + (1 / (rrf_k + semantic_ranks[identifier]) if identifier in semantic_ranks else 0)
           for identifier in set(lexical_ranks) | set(semantic_ranks)}
    ranked = (sorted(rrf, key=lambda identifier: (-rrf[identifier], _identifier_order(identifier)))
              if mode == "hybrid" else lexical_ids)
    selected = tuple(ranked[:limit])
    scores = {identifier: {
        "bm25": lexical.get(identifier, 0.0), "semantic_cosine": semantic.get(identifier, 0.0),
        "bm25_rank": lexical_ranks.get(identifier, 0), "semantic_rank": semantic_ranks.get(identifier, 0),
        "rrf": rrf[identifier],
    } for identifier in selected}
    diagnostics.update({"returned": len(selected), "semantic_candidates": len(semantic_ids),
                        "union_candidates": len(rrf), "limited_candidates": max(0, len(rrf) - limit)})
    return CandidateRanking(selected, scores, diagnostics)
