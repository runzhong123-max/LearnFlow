"""Independent adversarial checks of v2 reporting, not production ranking."""
from run_expanded import score_packet, aggregate
from test_ablation import fixture, item


def test_forbidden_content_in_any_attachment_is_audited():
    case, meta, span = fixture()
    case['forbidden'] = ['private sentinel']
    for packet in ({'personal_concept_graph': {'text': 'private sentinel'}},
                   {'manifest': {'provenance': ['private sentinel']}},
                   {'kernel_heads': {}, 'guidance': 'private sentinel'}):
        result = score_packet(packet, case, meta)
        assert result['coverage'] == 0
        assert result['violations'] == ['forbidden_content_anywhere']


def test_checkpoint_isolation_is_not_only_project_isolation():
    case, meta, span = fixture()
    case['checkpoint_id'] = 2
    meta['1']['checkpoint_id'] = 3
    result = score_packet({'items': [item(1, span)]}, case, meta)
    assert result['violations'] == ['checkpoint_leak']


def test_uncovered_variants_and_empty_denominators():
    case, meta, span = fixture()
    case.update(family='uncovered_generic_terms', required=[])
    assert score_packet({'items': [item(1, span)]}, case, meta)['empty_on_uncovered'] is False
    assert score_packet({}, case, meta)['empty_on_uncovered'] is True
