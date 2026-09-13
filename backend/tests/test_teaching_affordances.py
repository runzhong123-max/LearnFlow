import asyncio
import app  # bootstrap shared source checkout

from learnflow_core.teaching_affordances import TeachingAffordancesRequest, validate_affordances, generate_teaching_affordances
from app.services.learning_skill_runtime import learner_response_signal


def test_candidates_are_sparse_and_grounded():
    content = "闭包引用外层变量。函数返回后仍能访问变量。"
    result = validate_affordances({"followUps": ["变量为什么还在？", "可以举一个例子吗？", "两个闭包会共享变量吗？"], "highlights": [
        {"quote": "变量", "reason": "重复位置"}, {"quote": "不存在", "reason": "无原文"},
        {"quote": "闭包", "reason": "核心概念"}, {"quote": "闭包引用外层变量", "reason": "重叠"},
        {"quote": "函数返回后仍能访问变量", "reason": "关键机制"},
    ]}, content)
    assert len(result["followUps"]) == 3
    assert result["highlights"] == [{"quote": "闭包"}, {"quote": "函数返回后仍能访问变量"}]
    assert result["sourceText"] == content
    assert validate_affordances({"followUps": ["问题一样？", "问题一样?", "其他问题？"]}, content)["followUps"] == []


def test_followup_click_is_an_explanation_request_not_an_attempt():
    assert learner_response_signal("请直接解释：两个闭包会共享变量吗？") == "direct_explanation_requested"


def test_optional_generation_without_model_is_empty(monkeypatch):
    from app.core.config import settings
    import app.services.auth as auth
    monkeypatch.setattr(settings, "llm_api_key", "")
    monkeypatch.setattr(auth, "model_credential_configured", lambda account: False)
    data = TeachingAffordancesRequest(content="这是原文", mode="simple_explain")
    result = asyncio.run(generate_teaching_affordances(data, object()))
    assert result["followUps"] == [] and result["highlights"] == []
    assert result["sourceText"] == data.content


def test_api_owns_source_and_preserves_metadata(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    import app.api.agent as api
    calls = []

    async def generate(data, account):
        calls.append(data)
        return validate_affordances({"followUps": ["变量为什么还在？", "可以举个例子吗？", "两个闭包会共享变量吗？"]}, data.content)

    monkeypatch.setattr(api, "generate_teaching_affordances", generate)
    with TestClient(app) as client:
        accounts = client.get('/api/dev/accounts').json()
        user = next(a for a in accounts if a['username'] == 'legacy-demo')
        assert client.post(f"/api/dev/accounts/{user['id']}/login").status_code == 200
        client.headers['x-csrf-token'] = client.get('/api/auth/csrf').json()['csrf_token']
        session = client.post('/api/agent/sessions', json={"session_type": "global", "create_new": True, "client_conversation_id": "affordance-test-owned"}).json()
        session_id = session['id']
        saved = client.put(f'/api/agent/sessions/{session_id}/vnext', json={
            "client_conversation_id": "affordance-test-owned", "title": "重点引用测试", "mode": "simple_explain",
            "messages": [{"client_message_id": "affordance-message-1", "role": "assistant", "content": "闭包保留变量引用。", "created_at_ms": 1, "meta_data": {"retained": True}}],
        })
        assert saved.status_code == 200, saved.text
        message_id = next(m['id'] for m in saved.json()['messages'] if m['content'] == '闭包保留变量引用。')
        data = {"message_id": message_id, "content": "闭包保留变量引用。", "mode": "simple_explain"}
        url = f'/api/agent/sessions/{session_id}/teaching-affordances'
        first = client.post(url, json=data)
        assert first.status_code == 200 and len(first.json()['followUps']) == 3
        assert client.post(url, json=data).json() == first.json()
        assert len(calls) == 1
        assert client.post(url, json={**data, "content": "改变后的原文"}).status_code == 404
        other_session = client.post('/api/agent/sessions', json={"session_type": "global", "create_new": True}).json()['id']
        assert client.post(f'/api/agent/sessions/{other_session}/teaching-affordances', json=data).status_code == 404
        stored = next(m for m in client.get(f'/api/agent/sessions/{session_id}').json()['messages'] if m['id'] == message_id)
        assert stored['content'] == data['content']
        assert stored['meta_data']['vnext']['retained'] is True
        assert stored['meta_data']['teachingAffordances'] == first.json()
        import uuid
        client.post('/api/auth/logout')
        other = client.post('/api/auth/register', json={'username': 'aff' + uuid.uuid4().hex[:12], 'password': 'affordance-isolation-4826', 'display_name': 'Other', 'education_stage': 'undergraduate', 'background': '初次学习', 'focus_areas': ['数据库'], 'weekly_hours': 6, 'preferred_modes': ['practice']})
        assert other.status_code == 200, other.text
        client.headers['x-csrf-token'] = client.get('/api/auth/csrf').json()['csrf_token']
        assert client.post(url, json=data).status_code in (403, 404)
        assert len(calls) == 1
