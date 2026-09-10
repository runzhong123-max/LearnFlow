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


def test_explicit_composer_state_wins_over_keyword_guessing():
    """The state a learner picked is not re-guessed from what they typed.

    Every one of these messages carries a keyword that used to route the turn
    somewhere else, which is why the same selection produced a different
    posture depending on wording.
    """
    assert classify_chat_mode(
        "帮我规划从零开始系统学习操作系统的路线",
        session_type="global",
        requested_mode="simple_explain",
    ) == ("explain", "学习者在输入框显式选择了这个状态")
    assert classify_chat_mode(
        "跟我讲讲什么是朴素贝叶斯分类器",
        session_type="global",
        requested_mode="learning_plan",
    )[0] == "plan"
    assert classify_chat_mode(
        "我最近有点不知道从哪里聊起",
        session_type="global",
        requested_mode="guided_learning",
    )[0] == "learn"
    # Contract ids are accepted alongside the composer's own vocabulary.
    assert classify_chat_mode(
        "帮我规划从零开始系统学习操作系统的路线",
        session_type="global",
        requested_mode="explain",
    )[0] == "explain"


def test_free_state_still_lets_the_classifier_converge_the_intent():
    """`free` means "you decide"; it must not freeze the turn in free."""
    assert classify_chat_mode(
        "带我深入理解朴素贝叶斯，并安排练习和验证",
        session_type="global",
        requested_mode="free",
    )[0] == "learn"
    assert classify_chat_mode(
        "跟我讲讲什么是朴素贝叶斯分类器",
        session_type="global",
        requested_mode="free",
    )[0] == "explain"
    # An unknown or absent value behaves exactly like `free`.
    assert classify_chat_mode(
        "帮我规划从零开始系统学习操作系统的路线",
        session_type="global",
        requested_mode="nonsense",
    )[0] == "plan"


def test_an_explicit_state_lets_a_learner_step_out_of_a_running_task():
    """A task is durable; stepping out to ask a side question must not require
    abandoning it. Refusing the switch left only two options — drop the task, or
    do not ask — and the composer chip kept showing a state nobody had picked."""
    for requested, expected in (
        ("simple_explain", "explain"),
        ("learning_plan", "plan"),
    ):
        assert classify_chat_mode(
            "顺便问一下，什么是闭包",
            session_type="global",
            has_active_task=True,
            requested_mode=requested,
        )[0] == expected, requested
        assert classify_chat_mode(
            "顺便问一下，什么是闭包",
            session_type="global",
            has_active_skill_run=True,
            requested_mode=requested,
        )[0] == expected, requested


def test_free_keeps_a_running_task_because_it_delegates_the_decision():
    """`free` is "you decide", and with a task in flight that decision is to
    stay with the task rather than silently dropping the learner out of it."""
    for context in ({"has_active_task": True}, {"has_active_skill_run": True}):
        assert classify_chat_mode(
            "继续", session_type="global", requested_mode="free", **context,
        )[0] == "learn", context
        assert classify_chat_mode(
            "继续", session_type="global", **context,
        )[0] == "learn", context


def test_a_checkpoint_session_stays_a_task_space():
    """A checkpoint is a place, not a per-turn posture, so it outranks the pick."""
    for requested in ("simple_explain", "learning_plan", "free"):
        assert classify_chat_mode(
            "什么是指针",
            session_type="checkpoint",
            requested_mode=requested,
        )[0] == "learn", requested


def test_every_mode_prompt_states_how_the_turn_should_be_written():
    from app.services.chat_modes import chat_mode_prompt

    shapes = {
        mode_id: chat_mode_prompt({"id": mode_id, "goal": "示例目标"})
        for mode_id in ("free", "explain", "learn", "plan")
    }
    for mode_id, prompt in shapes.items():
        assert "本轮怎么写：" in prompt, mode_id
        assert "所有状态都适用：" in prompt, mode_id
    # The four modes must not collapse into the same instruction.
    assert len(set(shapes.values())) == 4


# Kept in sync with the same corpus in frontend/server/learning-task.test.ts.
# The composer resolves 自由状态 itself before the turn is sent, so a phrase
# that lands in a different mode on each side means the same sentence teaches
# differently depending on which runtime answered it.
SHARED_INTENT_CORPUS = (
    ("什么是指针", "explain"),
    ("跟我讲讲什么是朴素贝叶斯分类器", "explain"),
    ("解释一下哈希表", "explain"),
    ("帮我理解一下闭包", "explain"),
    ("怎么理解动态规划", "explain"),
    ("介绍一下 TCP 三次握手", "explain"),
    ("带我学会二叉树", "learn"),
    ("深入理解朴素贝叶斯", "learn"),
    ("彻底搞懂指针", "learn"),
    ("真正弄懂闭包", "learn"),
    ("帮我搞懂动态规划", "learn"),
    ("逐步带我实现一个链表", "learn"),
    ("练习并验证我对递归的理解", "learn"),
    ("从头学会线性代数", "learn"),
    ("教我学会正则表达式", "learn"),
    ("帮我规划从零开始系统学习操作系统的路线", "plan"),
    ("我想系统学习编译原理", "plan"),
    ("做一个项目练手", "plan"),
    ("以后想做算法工程师", "plan"),
    ("我在考虑转行做前端", "plan"),
    ("未来读研还是就业", "plan"),
    ("半年内想掌握后端开发", "plan"),
    ("给我一个学习路线图", "plan"),
    ("这个函数的返回值是什么意思", "free"),
    ("我最近有点不知道从哪里聊起", "free"),
    ("今天天气不错", "free"),
    ("这段代码报错了怎么办", "free"),
    ("谢谢", "free"),
)


def test_shared_intent_corpus_matches_the_frontend_resolver():
    mismatched = [
        (phrase, expected, classify_chat_mode(phrase, session_type="global")[0])
        for phrase, expected in SHARED_INTENT_CORPUS
        if classify_chat_mode(phrase, session_type="global")[0] != expected
    ]
    assert not mismatched, mismatched


def test_direction_words_alone_do_not_hijack_an_ordinary_sentence():
    """未来 / 以后 are ordinary words; only a direction question is planning."""
    for phrase in ("以后再说吧", "这个以后会不会变", "未来的版本里还有吗"):
        assert classify_chat_mode(phrase, session_type="global")[0] == "free", phrase
    for phrase in ("以后想做算法工程师", "毕业后想从事后端开发"):
        assert classify_chat_mode(phrase, session_type="global")[0] == "plan", phrase
