"""Extract original text windows, retaining qualifiers and verifiable offsets."""
from __future__ import annotations
import hashlib
import re

QUALIFIERS = re.compile(
    r'仅|只适用|尚未|未验证|仍未|不能|不代表|除非|例外|上限|最大|至少|至多|有提示|受助|'
    r'\b(?:only|unless|except|not|unverified|untested|assisted|maximum|minimum|limit)\b', re.I)


def excerpt(text: str, terms=(), *, limit: int = 640) -> tuple[str, dict]:
    """No paraphrasing or evidence upgrade. Gaps are explicit; offsets use original text."""
    text = str(text or '')
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
    if len(text) <= limit:
        return text, {'sha256': digest, 'chars': len(text), 'ranges': [[0, len(text)]]}
    # Sentence punctuation preserves separate negations/conditions, including distant ones.
    boundaries = [0, *[m.end() for m in re.finditer(r'[。！？；\n]|[.!?;](?=\s|$)', text)], len(text)]
    spans = [(a, b) for a, b in zip(boundaries, boundaries[1:]) if b > a and text[a:b].strip()]
    matches = []
    query_terms = tuple(str(t).casefold() for t in terms if t)
    for a, b in spans:
        body = text[a:b]
        hits = sum(t in body.casefold() for t in query_terms)
        qualifier = bool(QUALIFIERS.search(body))
        # Explicit conditions compete before filler, independently of query position.
        matches.append((hits, qualifier, a, b))
    ranked = sorted(matches, key=lambda x: (-bool(x[0]), -x[0], -x[1], x[2]))
    # Reserve at most half for distant qualifiers; never silently drop all exceptions.
    selected = []
    used = 0
    def add(a, b, allowance):
        nonlocal used
        if any(a >= left and b <= right for left, right in selected):
            return
        room = min(allowance, limit - used - (3 if selected else 0))
        if room <= 0:
            return
        if b - a > room:
            local = text[a:b].casefold()
            locations = [local.find(t) for t in query_terms if t in local]
            marker = QUALIFIERS.search(text[a:b])
            center = min(locations) if locations else marker.start() if marker else 0
            start = max(a, min(a + center - room // 3, b - room))
            a, b = start, start + room
        selected.append((a, b)); used += b-a + (3 if len(selected)>1 else 0)
    if ranked:
        add(ranked[0][2], ranked[0][3], limit // 2)
    for _, qualifier, a, b in sorted(matches, key=lambda x: (-x[1], x[2])):
        if qualifier:
            add(a, b, max(80, limit // 3))
    for _, _, a, b in ranked:
        add(a, b, limit)
        if used >= limit or len(selected) >= 6:
            break
    # Merge overlapping windows; never concatenate overlaps into false duplicated evidence.
    merged = []
    for a, b in sorted(selected):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    rendered = ' … '.join(text[a:b] for a, b in merged)
    assert len(rendered) <= limit
    missing_qualifiers = sum(q and not any(a >= x and b <= y for x, y in merged)
                             for _, q, a, b in matches)
    return rendered, {'sha256': digest, 'chars': len(text), 'ranges': merged,
                      'truncated': True, 'qualifier_spans_omitted': missing_qualifiers}
