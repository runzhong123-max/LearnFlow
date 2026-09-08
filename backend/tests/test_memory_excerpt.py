import hashlib
from learnflow_core.memory_excerpt import excerpt


def test_distant_constraints_and_tail_are_original_and_bounded():
    prefix = '仅 UTF-8 文本通过；二进制尚未验证。'
    middle = '最大 8 MiB。'
    tail = '压缩率验证通过。'
    text = prefix + '过程记录。'*200 + middle + '过程记录。'*200 + tail
    shown, source = excerpt(text, ['压缩率'], limit=640)
    assert all(t in shown for t in (prefix, middle, tail))
    assert len(shown) <= 640 and source['truncated']
    assert source['sha256'] == hashlib.sha256(text.encode()).hexdigest()
    assert shown == ' … '.join(text[a:b] for a,b in source['ranges'])
    assert source['qualifier_spans_omitted'] == 0


def test_partial_sentence_is_explicit_and_short_text_is_unchanged():
    text = 'instrument '*200 + 'only isolated input is verified.'
    shown, source = excerpt(text, ['isolated'], limit=200)
    assert 'only isolated input is verified.' in shown
    assert source['truncated'] and len(shown) <= 200
    assert excerpt('有提示成功，不代表独立。')[0] == '有提示成功，不代表独立。'
