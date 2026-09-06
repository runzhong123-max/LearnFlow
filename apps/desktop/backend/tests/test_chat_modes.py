from app.models.learning import AgentSession
from app.services.chat_modes import chat_mode_view, classify_chat_mode
from app.services.learning_tasks import deterministic_learning_task_opportunity


def test_coarse_mode_classifier_keeps_definition_out_of_task_runtime():
    assert classify_chat_mode(
        "跟我讲讲什么是朴素贝叶斯分类器",
        session_type="global",
    )[0] == "explain"
    assert classify_chat_mode(
        "带我深入理解朴素贝叶斯，并安排练习和验证",
        session_type="global",
    )[0] == "learn"
    assert classify_chat_mode(
        "帮我规划从零开始系统学习操作系统的路线",
        session_type="global",
    )[0] == "plan"
    assert classify_chat_mode(
        "我最近有点不知道从哪里聊起",
        session_type="global",
    )[0] == "free"


def test_active_domain_runtime_and_checkpoint_force_learning_mode():
    assert classify_chat_mode(
        "继续",
        session_type="global",
        has_active_task=True,
    )[0] == "learn"
    assert classify_chat_mode(
        "先简单解释一下",
        session_type="global",
        selected_skill_id="socratic_dialogue",
    )[0] == "learn"
    assert classify_chat_mode(
        "你好",
        session_type="checkpoint",
    )[0] == "learn"

    session = AgentSession(
        learner_id=1,
        session_type="checkpoint",
        project_id=1,
        checkpoint_id=1,
        context_summary={},
    )
    view = chat_mode_view(session)
    assert view["id"] == "learn"
    assert "关卡" in view["reason"]


def test_deep_selected_text_becomes_a_deterministic_atomic_task():
    opportunity = deterministic_learning_task_opportunity(
        "带我深入理解我选中的这段内容，并安排一次练习与验证。",
        selected_text="装饰器会接收函数并返回一个包装后的可调用对象。",
        force=True,
    )
    assert opportunity is not None
    assert opportunity["should_propose"] is True
    assert "装饰器会接收函数" in opportunity["objective"]

    direct = deterministic_learning_task_opportunity(
        "带我深入理解 Python 装饰器如何包装函数，并安排一次练习与验证。",
    )
    assert direct is not None
    assert direct["title"] == "弄懂：Python 装饰器如何包装函数"
