"""Deterministic, bounded read-side query normalization; never learner evidence.

Aliases are an explicit terminology table, not a semantic model. Fuzzy probes
only obtain candidates: they must never count as evidence of relevance. Hosts
must scope/filter those candidates before calling ``resolve_fuzzy``.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from itertools import islice
import re
from typing import Iterable
import unicodedata

QUERY_PLAN_VERSION = "memory-query.v1"
ALIAS_VERSION = "computing-terminology.v1"
MAX_QUERY_CHARS = 4096
MAX_TEXT_CHARS = 65536
MAX_TERMS = 48
MAX_LITERAL_TERMS = 32
MAX_FUZZY_TERMS = 12
MAX_FUZZY_TEXTS = 512
MAX_FUZZY_CHARS = 262144
MAX_FUZZY_VOCABULARY = 8192

# Each group denotes the same computing concept. Broad/multivalent terms such
# as "memory", "attention", "index", and "TTL" deliberately have no expansion.
ALIAS_GROUPS = (
    ("mvcc", "multiversion concurrency control", "multi-version concurrency control",
     "multi version concurrency control", "多版本并发控制"),
    ("rag", "retrieval augmented generation", "retrieval-augmented generation", "检索增强生成"),
    ("tcp", "transmission control protocol", "传输控制协议"),
    ("udp", "user datagram protocol", "用户数据报协议"),
    ("dns", "domain name system", "域名系统"),
    ("http", "hypertext transfer protocol", "超文本传输协议"),
    ("sql", "structured query language", "结构化查询语言"),
    ("bfs", "breadth first search", "breadth-first search", "广度优先搜索", "宽度优先搜索"),
    ("dfs", "depth first search", "depth-first search", "深度优先搜索"),
    ("api", "application programming interface", "应用程序编程接口"),
    ("lru", "least recently used", "最近最少使用"),
)
_HAN = r"\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0002fa1f"
_HAN_RE = re.compile(f"[{_HAN}]+")
_WORD_RE = re.compile(rf"[^\W_{_HAN}]+(?:[_-][^\W_{_HAN}]+)*", re.UNICODE)
_LATIN_RE = re.compile(r"[a-z]+\Z")
_WEAK_ENGLISH = frozenset("""
a an and are as at be been by can could did do does evidence fact facts find
for from give has have how i in is it its learning me memory my of on or our
please query recall record records recorded retrieve show some tell that the
their them these they this those to us was we were what when where which who
why with would you your about information detail details data study history
historical past previous earlier earliest initially originally initial current
currently now latest summary summarize summarise overview recap all entire
""".split())
_WEAK_HAN_WORDS = (
    "学习", "记录", "证据", "记忆", "信息", "内容", "情况", "查询", "查找", "寻找", "检索",
    "查看", "看看", "告诉", "显示", "提供", "给出", "请问", "是否", "什么", "哪些", "如何",
    "怎么", "多少", "有关", "关于", "相关", "一下", "一些", "我的", "我们", "你的", "全部",
    "所有", "汇总", "复盘", "综述", "总结", "历史", "历次", "当前", "现在", "最近", "最初",
    "最早", "最先", "起初", "以前", "此前", "过去", "变化", "演变", "沿革", "时间线",
    "第一次", "最开始", "整体情况", "全貌", "详情",
)
_WEAK_HAN_CHARS = frozenset("的了呢吗呀啊和我你他她它请把将给从在到与对及有无是为着地得也又都还就这那么吗吧呢")
_WEAK_HAN_RE = re.compile("|".join(re.escape(w) for w in sorted(_WEAK_HAN_WORDS, key=lambda w: (-len(w), w))))
_SUMMARY_MARKERS = ("汇总", "复盘", "综述", "总结", "全貌", "整体情况", "全部记录", "所有记录",
                    "overview", "summarize", "summarise", "summary", "recap")
_EARLIEST_MARKERS = ("最初", "最早", "第一次", "起初", "最开始", "最先", "earliest", "initially",
                     "first attempt", "originally", "initial")
_HISTORY_MARKERS = ("历史", "历次", "此前", "以前", "过去", "变化", "演变", "沿革", "不同阶段",
                    "时间线", "history", "historical", "over time", "past", "previous", "earlier")


@dataclass(frozen=True)
class QueryPlan:
    terms: tuple[str, ...]
    literal_terms: tuple[str, ...]
    latin_terms: tuple[str, ...]
    intent: str
    temporal: str
    audit: dict


def _normalize(text: str, limit: int) -> str:
    # Bound input before Unicode work; normalize resulting whitespace as well.
    return " ".join(unicodedata.normalize("NFKC", str(text or "")[:limit]).casefold().split())


def _contains(text: str, phrase: str) -> bool:
    if _HAN_RE.search(phrase):
        return phrase in text
    # ASCII terminology must not match identifiers such as tcp_socket or APIs.
    return re.search(rf"(?<![^\W{_HAN}])(?<!-)" + re.escape(phrase)
                     + rf"(?![^\W{_HAN}]|-)", text) is not None


def _unique(values: Iterable[str], limit: int) -> tuple[str, ...]:
    return tuple(islice(dict.fromkeys(values), limit))


def _han_terms(run: str) -> list[str]:
    covered = [char in _WEAK_HAN_CHARS for char in run]
    for match in _WEAK_HAN_RE.finditer(run):
        covered[match.start():match.end()] = [True] * (match.end() - match.start())
    if all(covered):
        return []
    # Do not delete substrings from compounds: 学习率 and 证据理论 retain their
    # full text and their meaningful boundary bigrams (习率, 据理, 理论).
    values = [run] if 2 <= len(run) <= 24 else []
    values.extend(run[i:i + 2] for i in range(len(run) - 1)
                  if not (covered[i] and covered[i + 1])
                  and not any(c in _WEAK_HAN_CHARS for c in run[i:i + 2]))
    return values


def _ordered_tokens(text: str) -> list[str]:
    parts = [(m.start(), m.group()) for m in _WORD_RE.finditer(text)]
    parts += [(m.start(), m.group()) for m in _HAN_RE.finditer(text)]
    values: list[str] = []
    for _, part in sorted(parts):
        if _HAN_RE.fullmatch(part):
            values.extend(_han_terms(part))
        elif len(part) >= 2 and part not in _WEAK_ENGLISH:
            values.append(part)
    # Preserve literal multiword terminology as a phrase. This does not expand
    # document meaning: only a phrase actually present in the text is added.
    for group in ALIAS_GROUPS:
        values.extend(alias for alias in group if _contains(text, alias))
    return values


def tokenize(text: str) -> set[str]:
    """NFKC/casefold words and Chinese bigrams, with weak-only units removed.

    No alias expansion or fuzzy correction occurs here. At most 65,536 input
    characters are inspected, so callers handling longer bodies must segment
    them rather than assume a complete-document match.
    """
    return set(_ordered_tokens(_normalize(text, MAX_TEXT_CHARS)))


def _aliases(text: str) -> tuple[list[str], list[dict]]:
    expansions: list[str] = []
    audit: list[dict] = []
    for group in ALIAS_GROUPS:
        matched = [alias for alias in group if _contains(text, alias)]
        if matched:
            added = [alias for alias in group if alias not in matched]
            expansions.extend(added)
            audit.append({"concept": group[0], "matched": matched, "expanded": added})
    return expansions, audit


def plan_query(query: str) -> QueryPlan:
    normalized = _normalize(query, MAX_QUERY_CHARS)
    tokens = _ordered_tokens(normalized)
    literal = _unique(tokens, MAX_LITERAL_TERMS)
    expansions, aliases = _aliases(normalized)
    terms = _unique((*literal, *expansions), MAX_TERMS)
    latin = tuple(term for term in literal if _LATIN_RE.fullmatch(term))
    intent = "summary" if any(_contains(normalized, m) for m in _SUMMARY_MARKERS) else "fact"
    temporal = ("earliest" if any(_contains(normalized, m) for m in _EARLIEST_MARKERS)
                else "history" if any(_contains(normalized, m) for m in _HISTORY_MARKERS)
                else "current")
    return QueryPlan(terms, literal, latin, intent, temporal, {
        "version": QUERY_PLAN_VERSION,
        "alias_version": ALIAS_VERSION,
        "normalization": "unicode_nfkc_casefold_whitespace",
        "query_truncated": len(str(query or "")) > MAX_QUERY_CHARS,
        "terms_truncated": len(set(tokens)) > MAX_LITERAL_TERMS or len(set((*literal, *expansions))) > MAX_TERMS,
        "aliases": aliases,
        "fuzzy_corrections": [],
    })


def _fuzzy_terms(plan: QueryPlan) -> tuple[str, ...]:
    return tuple(term for term in plan.latin_terms
                 if 5 <= len(term) <= 32 and _LATIN_RE.fullmatch(term))[:MAX_FUZZY_TERMS]


def fuzzy_probes(plan: QueryPlan) -> tuple[str, ...]:
    """Return <= 48 literal SQL probes; a probe is never a relevance match."""
    probes: list[str] = []
    for term in _fuzzy_terms(plan):
        probes.extend((term[:3], term[-3:]))
        if len(term) <= 6:
            # A middle transposition can change both trigrams in a short word.
            probes.extend((term[:2], term[-2:]))
    return _unique(probes, 48)


def _one_edit(left: str, right: str) -> bool:
    """Exactly one insertion/deletion/substitution or adjacent transposition."""
    if left == right or abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        differing = [i for i, (a, b) in enumerate(zip(left, right)) if a != b]
        return (len(differing) == 1 or
                (len(differing) == 2 and differing[1] == differing[0] + 1
                 and left[differing[0]] == right[differing[1]]
                 and left[differing[1]] == right[differing[0]]))
    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    index = next((i for i, (a, b) in enumerate(zip(shorter, longer)) if a != b), len(shorter))
    return shorter[index:] == longer[index + 1:]


def resolve_fuzzy(plan: QueryPlan, texts: Iterable[str]) -> QueryPlan:
    """Add only unique distance-one corrections from the supplied candidates.

    Exact original words anywhere in that bounded candidate vocabulary suppress
    correction. Ambiguity or corpus truncation rejects correction. Uniqueness is
    only relative to these scoped candidates, not the learner's entire corpus.
    """
    candidates: set[str] = set()
    count = characters = 0
    truncated = False
    for count, text in enumerate(islice(texts, MAX_FUZZY_TEXTS + 1), start=1):
        raw = str(text or "")
        if count > MAX_FUZZY_TEXTS or len(raw) > MAX_TEXT_CHARS or characters + len(raw) > MAX_FUZZY_CHARS:
            truncated = True
            break
        characters += len(raw)
        candidates.update(term for term in tokenize(raw)
                          if 4 <= len(term) <= 33 and _LATIN_RE.fullmatch(term))
        if len(candidates) > MAX_FUZZY_VOCABULARY:
            truncated = True
            break
    corrections: list[dict] = [dict(item) for item in plan.audit.get("fuzzy_corrections", [])]
    already_resolved = {item["original"] for item in corrections}
    rejected: list[dict] = []
    expanded: list[str] = []
    if not truncated:
        for original in _fuzzy_terms(plan):
            if original in already_resolved:
                continue
            if original in candidates:
                rejected.append({"original": original, "reason": "exact_present"})
                continue
            matches = sorted(word for word in candidates if _one_edit(original, word))
            if len(matches) != 1:
                rejected.append({"original": original, "reason": "ambiguous" if matches else "no_unique_candidate",
                                 "candidates": matches[:8], "candidate_count": len(matches)})
                continue
            corrected = matches[0]
            if corrected in plan.terms or corrected in expanded:
                continue
            if len(set((*plan.terms, *expanded))) >= MAX_TERMS:
                rejected.append({"original": original, "reason": "term_budget"})
                continue
            expanded.append(corrected)
            corrections.append({"original": original, "corrected": corrected,
                                "distance": 1, "basis": "unique_scoped_candidate"})
    audit = {**plan.audit, "fuzzy_corrections": corrections, "fuzzy_rejected": rejected,
             "fuzzy_scan": {"texts": min(count, MAX_FUZZY_TEXTS), "characters": characters,
                            "vocabulary_size": len(candidates), "truncated": truncated,
                            "uniqueness_scope": "provided_candidates"}}
    return replace(plan, terms=_unique((*plan.terms, *expanded), MAX_TERMS), audit=audit)
