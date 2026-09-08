"""Curated curriculum assets: identity integrity, retrieval and honest structural scope."""
import json
from pathlib import Path
from app.main import app  # initialize the host shared-package bootstrap
from learnflow_core.visuals.catalog import _entries, read_template, search_catalog
from learnflow_core.visuals.engine import compile_visual
from learnflow_core.visuals.hub import curriculum, compile_work


def test_library_links_and_all_authored_frames_compile():
    root = next(p for p in Path(__file__).resolve().parents if (p / 'packages/learning-core').exists())
    graph = json.loads((root / 'backend/app/contracts/official-learning-path.v2.json').read_text())
    nodes = {n['id']: n['title'] for n in graph['nodes']}
    hub_nodes = {s['id']:s['title'] for m in curriculum()['modules'] for c in m['chapters'] for s in c['sessions']}
    for entry in _entries():
        metadata = read_template(entry['id'], entry['version'])['retrieval']
        assert metadata['questions'] and metadata['not_for'] and isinstance(metadata['prerequisites'], list)
        linked = hub_nodes if metadata['learning_path']['graph_id']=='visual-hub-curriculum/v1' else nodes
        assert metadata['learning_path']['graph_id'] in ('visual-hub-curriculum/v1', graph['graphId'])
        for n in metadata['learning_path']['nodes']:
            assert linked[n['id']] == n['title']
        if entry.get('builder')=='interactive_html':
            result=compile_work(entry['spec'])
            assert result['verification']['status']=='pass' and "connect-src 'none'" in result['html']
            continue
        result = compile_visual(entry['spec'])
        assert result['verification']['status'] == 'pass'
        if entry['spec']['model']['id'] == 'structure.sequence':
            assert result['verification']['scope'] == 'illustrative_authored_sequence'
            assert len(result['frames']) >= 3


def test_retrieval_matches_student_questions_and_curriculum_ids():
    for query, expected in [
        ('二分查找为什么不会漏掉目标', 'algorithms.binary_search.interval'),
        ('虚拟地址怎样变成物理地址', 'systems.virtual_memory.translation'),
        ('脏读和不可重复读有什么区别', 'database.transaction.dirty_read'),
        ('递归为什么要有终止条件', 'programming.recursion.stack'),
        ('RAG 为什么仍然会幻觉', 'ai.rag.evidence_flow'),
    ]:
        assert search_catalog(query, 'animation')['templates'][0]['id'] == expected
    assert any(x['id'] == 'systems.virtual_memory.translation' for x in search_catalog('虚拟地址 operating-systems', 'animation')['templates'])
    assert search_catalog('从零演示新矩阵', 'animation', include_templates=False)['templates'] == []
