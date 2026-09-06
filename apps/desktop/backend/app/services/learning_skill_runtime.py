"""Deterministic session runtime for conversational learning Skills.

The runtime owns workflow position, turn budgets, pause/resume and the handoff
to the existing verified micro-learning loop.  It deliberately does not grade
answers or create mastery claims.  Model output may render the next prompt,
but state transitions are selected here.
"""
from __future__ import annotations

from datetime import datetime
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import (
    AgentMessage, AgentSession, LearnerProfile, LearningSkillRun, LearningTask,
    MicroLearningRun,
)
from app.models.project import Checkpoint, Project, Roadmap
from app.services.architecture_registry import (
    learning_skill_runtime_contract,
    selectable_learning_skill,
)
from app.services.learning_runtime import record_event


SKILL_RUNTIME_VERSION = "atomic-learning-skill-runtime-v6"
SUPPORT_TURN_BUDGET = 3
RUNTIME_SKILL_IDS = (
    "guided_explanation",
    "socratic_dialogue",
    "feynman_dialogue",
    "worked_example_fading",
    "learning_file_study",
)
ACTIVE_RUN_STATUSES = ("active", "paused", "verification")

FEYNMAN_GAP_LABELS = {
    "circular_definition": "定义绕回原词",
    "missing_prerequisite": "缺少必要前提",
    "causal_break": "因果链断裂",
    "mechanism_black_box": "机制仍是黑箱",
    "boundary_confusion": "适用边界不清",
    "example_mismatch": "例子与解释未对齐",
    "transfer_failure": "尚未迁移到新情境",
    "unresolved": "仍需独立核实",
}

_FEYNMAN_DEFAULT_CALIBRATION = {
    "audience_level": "undergraduate",
    "cognitive_demand": "mechanism",
    "scaffold_level": "guided",
    "representation_mode": "auto",
}

_EDUCATION_TO_AUDIENCE = {
    "middle_school": "beginner",
    "high_school": "high_school",
    "vocational": "vocational",
    "higher_vocational": "vocational",
    "undergraduate": "undergraduate",
    "graduate": "graduate",
    "postgraduate": "graduate",
    "professional": "professional",
}

_SCAFFOLD_ORDER = ("none", "minimal", "guided", "model")


def feynman_calibration_options() -> dict[str, tuple[str, ...]]:
    runtime = learning_skill_runtime_contract("feynman_dialogue")
    if not runtime:
        return {}
    return {
        axis.id: tuple(option[0] for option in axis.options)
        for axis in runtime.calibration_axes
    }


def normalize_feynman_calibration(
    value: dict[str, Any] | None,
    *,
    education_stage: str = "",
) -> dict[str, str]:
    calibration = dict(_FEYNMAN_DEFAULT_CALIBRATION)
    audience = _EDUCATION_TO_AUDIENCE.get(str(education_stage or "").strip().casefold())
    if audience:
        calibration["audience_level"] = audience
    options = feynman_calibration_options()
    for key, option in dict(value or {}).items():
        if key in options and str(option) in options[key]:
            calibration[key] = str(option)
    return calibration


def _increase_scaffold(calibration: dict[str, str]) -> dict[str, str]:
    result = dict(calibration)
    current = result.get("scaffold_level", "guided")
    try:
        index = _SCAFFOLD_ORDER.index(current)
    except ValueError:
        index = 2
    result["scaffold_level"] = _SCAFFOLD_ORDER[min(len(_SCAFFOLD_ORDER) - 1, index + 1)]
    return result


def _teach_back_coverage(message: str) -> dict[str, bool]:
    text = re.sub(r"\s+", " ", str(message or "")).strip().casefold()
    compact = re.sub(r"[\s，,。.!！?？、；;：:]", "", text)
    return {
        "definition": any(marker in text for marker in (
            "是", "指", "意味着", "可以理解为", "一种", " refers to ", " means ",
        )) or bool(re.search(r"\b\w+(?:\s+\w+){0,4}\s+is\s+", text)),
        "mechanism": any(marker in text for marker in (
            "因为", "所以", "通过", "导致", "从而", "使得", "依赖",
            " because ", " therefore ", " through ", " causes ", " depends on ",
        )) or bool(re.search(r"先.{1,80}(?:再|然后)", text)),
        "example": any(marker in text for marker in (
            "例如", "比如", "举例", "假设", "代码", "就像",
            " for example ", " e.g.", " suppose ", " code ",
        )),
        "boundary": any(marker in text for marker in (
            "但是", "但", "除非", "只有", "不适用", "前提", "条件", "边界", "例外", "并不代表",
            " but ", " unless ", " only if ", " boundary ", " except ",
        )),
        "transfer": any(marker in text for marker in (
            "如果", "换成", "类似", "应用", "迁移", "另一个",
            " if ", " similar ", " apply ", " another ",
        )),
        "substantive": len(compact) >= 18,
    }


def _candidate_gap(
    message: str,
    coverage: dict[str, bool],
    calibration: dict[str, str],
) -> str:
    compact = re.sub(r"[\s，,。.!！?？、；;：:]", "", str(message or "").casefold())
    if len(compact) < 10:
        return "missing_prerequisite"
    circular = re.search(r"(.{2,10})(?:就是|是)(?:一种)?\1", compact)
    if circular:
        return "circular_definition"
    demand = calibration.get("cognitive_demand", "mechanism")
    if demand in {"mechanism", "boundary", "transfer"} and not coverage["mechanism"]:
        return "causal_break"
    if demand in {"boundary", "transfer"} and not coverage["boundary"]:
        return "boundary_confusion"
    if demand == "transfer" and not coverage["transfer"]:
        return "transfer_failure"
    if demand == "mechanism" and not coverage["example"]:
        return "mechanism_black_box"
    return "unresolved"


def build_teach_back_diagnostic(
    message: str,
    *,
    calibration: dict[str, str],
    previous: dict[str, Any] | None = None,
    preserve_gap: bool = False,
) -> dict[str, Any]:
    """Build an operational, unverified diagnostic from observable answer form.

    This never evaluates domain correctness and therefore cannot become a
    Knowledge/Practice claim without the independent assessment handoff.
    """
    coverage = _teach_back_coverage(message)
    previous_gap = str((previous or {}).get("candidate_gap") or "")
    gap = previous_gap if preserve_gap and previous_gap in FEYNMAN_GAP_LABELS else _candidate_gap(
        message, coverage, calibration,
    )
    return {
        "schema_version": "teach-back-diagnostic-v1",
        "learner_wording": str(message or "").strip()[:1200],
        "candidate_gap": gap,
        "candidate_gap_label": FEYNMAN_GAP_LABELS[gap],
        "coverage": coverage,
        "calibration": dict(calibration),
        "status": "needs_focused_repair",
        "verification": "unverified",
        "mastery_inference": False,
        "decision_owner": "deterministic_surface_diagnostic",
        "updated_at": datetime.utcnow().isoformat(),
    }


def _gap_observably_addressed(
    diagnostic: dict[str, Any],
    message: str,
    calibration: dict[str, str],
) -> bool:
    coverage = _teach_back_coverage(message)
    gap = str(diagnostic.get("candidate_gap") or "unresolved")
    required = {
        "circular_definition": "definition",
        "missing_prerequisite": "definition",
        "causal_break": "mechanism",
        "mechanism_black_box": "example",
        "boundary_confusion": "boundary",
        "example_mismatch": "example",
        "transfer_failure": "transfer",
        "unresolved": "substantive",
    }.get(gap, "substantive")
    if not coverage.get(required, False):
        return False
    demand = calibration.get("cognitive_demand", "mechanism")
    demand_key = {
        "define": "definition", "mechanism": "mechanism",
        "boundary": "boundary", "transfer": "transfer",
    }.get(demand, "mechanism")
    return bool(coverage.get(demand_key, False))

def _workflow_from_registry(skill_id: str) -> dict[str, Any]:
    runtime = learning_skill_runtime_contract(skill_id)
    if not runtime:
        raise RuntimeError(f"missing_skill_runtime_contract:{skill_id}")
    states = tuple(state.id for state in runtime.states)
    labels = {state.id: state.title for state in runtime.states}
    labels.update({
        "verification_in_progress": "独立验证中",
        "completed": "本轮完成",
        "paused": "已暂停",
    })
    return {
        "turn_budget": runtime.turn_budget,
        "total_steps": len(states),
        "initial_state": runtime.initial_state,
        "states": states,
        "labels": labels,
        "evidence_policy": runtime.evidence_policy,
        "failure_policy": runtime.failure_policy,
    }


WORKFLOWS: dict[str, dict[str, Any]] = {
    skill_id: _workflow_from_registry(skill_id)
    for skill_id in RUNTIME_SKILL_IDS
}


def _compact_goal(value: str) -> str:
    goal = re.sub(r"\s+", " ", str(value or "")).strip()
    return goal[:300]


def _learning_goal(value: str, skill_id: str) -> str:
    """Remove method-selection language while preserving the topic request."""
    original = _compact_goal(value)
    goal = re.sub(
        r"^(?:请|可以|能不能|你能)?\s*(?:带我(?:学习|练习|弄懂|理解|学|做)|教我(?:学会|理解|弄懂)|陪我(?:学|练)|让我练习)\s*",
        "",
        original,
        count=1,
    ).strip()
    goal = re.sub(r"^(?:一下|关于)\s*", "", goal, count=1).strip()
    if skill_id == "guided_explanation":
        prefixes = (
            r"^(?:请)?(?:直接)?(?:给我)?(?:解释|讲清楚|讲清|说明)[，,：:\s]*",
            r"^(?:请)?(?:用一个)?(?:最小)?例子(?:解释|说明)?[，,：:\s]*",
        )
    elif skill_id == "socratic_dialogue":
        prefixes = (
            r"^(?:请)?(?:跟我|给我)?讲讲(?:什么是)?[，,：:\s]*",
            r"^(?:请)?不要直接告诉我(?:答案)?[，,：:\s]*",
            r"^(?:请)?(?:用问题)?引导我[，,：:\s]*",
            r"^(?:我想)?自己推导[，,：:\s]*",
            r"^(?:请)?帮我(?:想清|理解)?[，,：:\s]*",
        )
    elif skill_id == "feynman_dialogue":
        prefixes = (
            r"^我想用自己的话(?:复述|讲清楚|讲清|讲)?[，,：:\s]*",
            r"^让我把?[，,：:\s]*",
            r"^我来用自己的话讲[，,：:\s]*",
            r"^检验我到底懂不懂[，,：:\s]*",
            r"^通过复述帮我查漏[，,：:\s]*",
            r"^我先回忆[，,：:\s]*",
            r"^我讲给一个新手听[，,：:\s]*",
            r"^想确认我到底懂不懂[，,：:\s]*",
        )
    elif skill_id == "worked_example_fading":
        prefixes = (
            r"^(?:请)?(?:先)?带我做一遍[，,：:\s]*",
            r"^(?:请)?先示范(?:一遍)?再让我做[，,：:\s]*",
            r"^(?:请)?(?:用)?示例渐隐(?:来)?(?:学习|讲解)?[，,：:\s]*",
            r"^(?:请)?给我一个完整(?:例题|示例|样例代码)[，,：:\s]*",
        )
    elif skill_id == "learning_file_study":
        prefixes = (
            r"^(?:请)?(?:用)?讲义(?:和练习)?带我学[，,：:\s]*",
            r"^(?:请)?(?:基于|看着)?这份(?:讲义|练习|文件|资料)(?:带我)?(?:学习|练习)?[，,：:\s]*",
            r"^(?:请)?看讲义做练习[，,：:\s]*",
        )
    else:
        prefixes = ()
    for pattern in prefixes:
        goal = re.sub(pattern, "", goal, count=1).strip()
    if skill_id == "feynman_dialogue":
        for pattern in (
            r"讲给别人听$", r"[，,]?再请你检查$", r"[，,]?你帮我找漏洞$", r"[，,]?让我先复述$",
        ):
            goal = re.sub(pattern, "", goal, count=1).strip()
    return goal[:300] if len(goal) >= 2 else original


def _needs_grounded_entry(value: str) -> bool:
    normalized = "".join(str(value or "").casefold().split())
    return any(marker in normalized for marker in (
        "什么是", "跟我讲", "给我讲", "我不了解", "我不懂", "没学过", "第一次学",
    ))


def learner_response_signal(message: str) -> str:
    """Classify only explicit interaction signals; never grade correctness here."""
    normalized = re.sub(r"[\s，,。.!！?？、]", "", str(message or "").casefold())
    if not normalized:
        return "missing"
    if any(marker in normalized for marker in (
        "直接告诉我", "直接解释", "先给我解释", "先讲一下", "别再问了", "不要再问",
        "换一种支架", "换种讲法", "再来一轮",
    )):
        return "direct_explanation_requested"
    if normalized in {"跳过", "先跳过", "略过", "下一步", "先不答", "不想答"}:
        return "skip"
    if normalized in {"嗯", "哦", "好", "好的", "继续", "可以", "明白", "收到"}:
        return "acknowledgement"
    no_knowledge_markers = (
        "我不知道", "不知道", "我不会", "不会", "不清楚", "没概念", "没思路", "想不到",
        "完全不懂", "不太懂", "没学过", "忘了", "答不上来",
    )
    if any(marker in normalized for marker in no_knowledge_markers):
        attempt_markers = ("但我觉得", "但是我觉得", "我猜", "可能是", "是不是", "因为", "所以")
        if not any(marker in normalized for marker in attempt_markers):
            return "no_prior_knowledge"
    return "attempt"


def workflow_blueprint(skill_id: str) -> dict[str, Any] | None:
    workflow = WORKFLOWS.get(skill_id)
    if not workflow:
        return None
    return {
        "skill_id": skill_id,
        "version": SKILL_RUNTIME_VERSION,
        "turn_budget": int(workflow["turn_budget"]),
        "total_steps": int(workflow["total_steps"]),
        "states": list(workflow["states"]),
        "verification_required": True,
        "evidence_policy": str(workflow["evidence_policy"]),
        "failure_policy": str(workflow["failure_policy"]),
    }


def recommend_learning_skill(message: str) -> dict[str, Any] | None:
    """Recommend, but never activate, a registered learner-selectable Skill."""
    normalized = "".join(str(message or "").casefold().split())
    if len(normalized) < 4:
        return None
    # Explicit learning-process requests take precedence over topic words.
    # In particular, "不要直接告诉我" is Socratic while "直接告诉我为什么"
    # asks for an explanation even though it contains "为什么".
    rules = (
        (
            "learning_file_study",
            ("用讲义带我学", "讲义和练习", "看讲义做练习", "基于这份讲义", "基于这份练习", "基于这份文件", "文件驱动学习"),
            "这个目标明确需要以可留存文件承载内容和正式作答，适合由讲义定位阅读、练习提交证据、对话负责引导。",
        ),
        (
            "worked_example_fading",
            ("带我做一遍", "先示范再", "示例渐隐", "渐隐示例", "完整例题", "完整示例", "样例代码再让我", "照着例子"),
            "这个目标包含可分步练习的程序或解题过程，适合先看子目标清楚的示例，再逐步撤掉提示。",
        ),
        (
            "feynman_dialogue",
            ("复述", "讲给别人", "讲给一个", "查漏", "检验我", "我到底懂", "回忆", "用自己的话"),
            "这个目标更适合先用自己的话讲一遍，再定位模糊处。",
        ),
        (
            "socratic_dialogue",
            ("不要直接告诉", "自己推导", "怎么想", "思路", "引导我", "用问题引导", "证明"),
            "这个问题适合保留你的思考过程，用连续小问题逐步推到结论。",
        ),
        (
            "guided_explanation",
            ("是什么", "解释", "讲清", "举例", "直接告诉", "没听懂", "看不懂"),
            "你现在更需要一个短而清楚的解释和最小例子。",
        ),
        (
            "socratic_dialogue",
            ("为什么", "推导", "自己想"),
            "这个问题适合保留你的思考过程，用连续小问题逐步推到结论。",
        ),
    )
    for skill_id, markers, reason in rules:
        matched = [marker for marker in markers if marker in normalized]
        if not matched:
            continue
        skill = selectable_learning_skill(skill_id)
        if not skill:
            continue
        return {
            "skill": {"id": skill.id, "name": skill.name, "description": skill.description},
            "goal": _learning_goal(message, skill_id),
            "reason": reason,
            "matched_signals": matched[:3],
            "requires_confirmation": True,
            "policy_version": "learning-skill-recommendation-v2",
        }
    return None


def _opening_prompt(
    skill_id: str,
    goal: str,
    *,
    grounded_entry: bool = False,
) -> tuple[str, str]:
    if skill_id == "guided_explanation":
        fallback = (
            f"先建立“{goal}”的最小模型：它解决什么问题、核心关系是什么、什么时候不适用。"
            "我会配一个最小例子；看完后请你只指出例子里哪个变化触发了结果。"
        )
        directive = (
            f"SkillRun 刚开始，目标是“{goal}”。直接给出一个分层但精炼的核心解释和一个最小例子；"
            "明确一个边界，最后只留一个检查例子关键关系的问题。不要宣布掌握。"
        )
        return directive, fallback
    if skill_id == "socratic_dialogue":
        if grounded_entry:
            fallback = (
                f"“{goal}”看起来是一个新主题，苏格拉底追问不应该让你凭空猜。"
                "我们先建立一个可回答的起点：依次找出它要解决什么判断、会使用哪些信息、"
                "这些信息怎样改变判断。你先选一个入口：A 先看它解决的问题；B 先看一个具体例子。"
                "只回复 A 或 B 即可。"
            )
            directive = (
                f"SkillRun 刚开始，目标是“{goal}”，学习者的提问显示这可能是首次接触。"
                "先用两三句话给出可靠的最小知识支架：说明它解决的问题、关键对象和一条核心关系，"
                "但不要一次讲完整章内容；随后给一个具体情境，只问一个二选一或可直接预测的问题。"
                "明确告诉学习者不需要凭空猜。不要连续列问题，不要宣布掌握。"
            )
            return directive, fallback
        fallback = (
            f"我们先给“{goal}”一个可回答的起点，而不是让你从空白定义开始。"
            "请回忆一个最接近的例子、现象或已知条件；只说其中一个即可，我会据此补一层支架。"
        )
        directive = (
            f"SkillRun 刚开始，目标是“{goal}”。先用一句话界定正在讨论的对象或情境，"
            "再只问一个用于暴露学习者当前直觉的具体问题；不要要求学习者从空白说出关键关系，"
            "不要给完整答案，不要连续列问题。"
        )
        return directive, fallback
    if skill_id == "feynman_dialogue":
        if grounded_entry:
            fallback = (
                f"“{goal}”像是第一次接触，现在直接要求复述并不合适。"
                "我会先给一个不超过三点的最小解释和一个具体例子；之后你只需用一句自己的话重说其中一条关系。"
            )
            directive = (
                f"SkillRun 刚开始，目标是“{goal}”，但学习者的提问显示可能尚未接触主题。"
                "先给一个不超过三点的可靠最小解释和一个具体例子，再只邀请学习者用一句自己的话"
                "重说其中一条关系。不要要求从空白完成完整复述，不要宣布掌握。"
            )
            return directive, fallback
        fallback = (
            f"先不看资料，把“{goal}”讲给一个完全不了解它的人听。"
            "请用 3—5 句话说明它是什么、为什么成立或怎样运作。"
        )
        directive = (
            f"SkillRun 刚开始，目标是“{goal}”。邀请学习者进行第一次自己的话复述；"
            "不要先讲答案，不要宣布掌握。"
        )
        return directive, fallback
    if skill_id == "learning_file_study":
        fallback = (
            f"我们用文件完成“{goal}”：先从已有讲义或资料里选最相关的一份，在纸张中读一个明确位置；"
            "再打开对应练习正式作答。聊天只负责带路和解释卡点，不会把整份文件重复贴出来。"
        )
        directive = (
            f"SkillRun 刚开始，目标是“{goal}”。先自然回应学习者当下问题，再读取正式工作区里的文件引用。"
            "优先建议打开一份已有讲义或资料；没有适合文件时只提出一次讲义/练习生成操作并等待确认。"
            "不要复制整份内容，不要因文件已生成或打开而宣布掌握。"
        )
        return directive, fallback
    fallback = (
        f"我们先把“{goal}”拆成几个有名称的子目标，看一遍完整示例；"
        "接着我会先拿掉最后一步，让你补全，再逐步撤掉更多提示。"
    )
    directive = (
        f"SkillRun 刚开始，目标是“{goal}”。给出一个尽可能小的完整示例，按 2—4 个功能子目标标注步骤；"
        "解释每个子目标为何存在，最后只问学习者哪一步把输入转成了目标输出。"
        "不要把照做或阅读示例当成掌握。"
    )
    return directive, fallback


def _support_step(
    skill_id: str,
    current_state: str,
    step_index: int,
    goal: str,
    signal: str,
    support_count: int,
) -> dict[str, Any]:
    """Keep the learner at the same step while adding bounded instructional support."""
    if signal in {"orientation_problem_choice", "orientation_example_choice"}:
        choice = "它解决的问题" if signal == "orientation_problem_choice" else "具体例子"
        return {
            "state": current_state,
            "step_index": step_index,
            "directive": (
                f"学习者已选择先看{choice}。这只是选择支架入口，不是知识作答，不得推进状态。"
                f"围绕“{goal}”给一个可靠、尽量小的具体例子，先点明问题、输入信息和判断结果，"
                "然后只问一个能从例子直接观察的二选一问题。"
            ),
            "fallback": (
                f"你选择了先看{choice}；这不会被算成已经理解。我们保留在当前步骤，"
                f"接下来用一个最小例子说明“{goal}”的问题、信息和判断结果。"
            ),
            "flow_note": "已选择知识支架入口；这不是作答，当前步骤和有效引导轮次没有推进。",
        }
    if signal == "skip":
        return {
            "state": current_state,
            "step_index": step_index,
            "directive": (
                "学习者选择跳过当前回答。不要把这当作完成或正确尝试，也不要推进教学状态。"
                "简短说明可以暂停或切换方法；如果继续，只给一个更小、可直接选择的动作。"
            ),
            "fallback": "这一步先不算完成，也不会自动跳到下一环。你可以暂停或切换方法；如果继续，我们会把问题缩成一个更小的选择。",
            "flow_note": "已识别为跳过：当前步骤和有效引导轮次都没有推进。",
        }
    if signal == "acknowledgement":
        return {
            "state": current_state,
            "step_index": step_index,
            "directive": (
                "学习者只做了确认，没有给出可检查的尝试。不要推进状态；把当前要求改写成一个具体、"
                "一次只需完成的小动作，必要时给两个选项，但不要暗示他已经答过。"
            ),
            "fallback": "收到，但这还不是一次可检查的尝试，所以我们留在当前步骤。请只完成一个小动作：选出你更倾向的判断，并补一句理由。",
            "flow_note": "确认信息不算作答：系统保留当前步骤，等待一个可检查的小动作。",
        }

    direct = signal == "direct_explanation_requested"
    if skill_id == "socratic_dialogue":
        directive = (
            f"学习者在“{goal}”上明确要求先直接解释。尊重退出通道：先给一个简明、可靠的核心说明，"
            "包含它解决的问题、一条核心关系和一个具体例子；然后只问一个识别或预测问题，"
            "不要继续抽象追问，不要宣布掌握。"
            if direct else
            f"学习者明确表示对“{goal}”没有可调用的先备知识。先说清这不是失败，也不要推进状态。"
            "给两三句话的最小知识支架：它解决的问题、关键对象和一条核心关系；随后放入一个具体情境，"
            "只问一个二选一或可直接观察的问题。不要再让学习者凭空指出关键条件。"
        )
        fallback = (
            f"好，先切到简明说明，不再让你猜。理解“{goal}”时先抓三件事：它解决什么问题、"
            "根据什么信息作判断、这个判断何时会失效。当前步骤会先补齐这三项和一个例子，再回到一个具体问题。"
            if direct else
            f"没关系，这说明现在缺的是知识起点，不该继续让你猜。理解“{goal}”时先抓三件事："
            "它解决什么问题、使用什么信息、这些信息怎样改变判断。我们保留在当前步骤，先用一个具体例子补起点。"
        )
    elif skill_id == "feynman_dialogue":
        directive = (
            f"学习者目前无法复述“{goal}”。不要把空白当作复述，也不要定位并不存在的表达漏洞。"
            "先给一个不超过三点的最小解释和一个例子，再只请学习者用一句自己的话重说其中一条关系。"
        )
        fallback = (
            f"现在还没有足够内容可以复述，所以不会进入“找漏洞”。先为“{goal}”补一个三点以内的"
            "最小解释和例子，再只需要你用一句自己的话重说其中一条关系。"
        )
    elif skill_id == "worked_example_fading":
        directive = (
            f"学习者在“{goal}”的当前示例步骤上没有思路。不要撤掉更多支架，也不要推进状态。"
            "显式展示当前被卡住的一小步及其理由，然后换一个近似输入，只让学习者补相邻的一个动作。"
        )
        fallback = (
            "这说明支架撤得太快了，所以不会进入下一层。我会先恢复当前这一步并说明它为什么存在，"
            "然后只换一个近似输入，请你补相邻的一个动作。"
        )
    elif skill_id == "learning_file_study":
        directive = (
            f"学习者在“{goal}”的文件学习步骤上需要支架。保持当前纸张和当前步骤；"
            "如果是讲义，只指出一个更小的段落锚点并给一个最小解释；如果是练习，只给一层提示，"
            "不泄露答案并让学生回到练习纸张提交。不得重复生成同类文件。"
        )
        fallback = "先不换文件，也不推进。我们把当前阅读或题目缩小到一个关系；我只补一层提示，你仍在原纸张继续。"
    else:
        directive = (
            f"学习者仍未理解“{goal}”的当前解释。不要推进到新例子。改用更短的句子和一个具体类比，"
            "只保留一条核心关系，最后问一个可直接观察的检查问题。"
        )
        fallback = (
            "没关系，这表示当前讲法还没有建立起点，所以不会推进。接下来只保留一条核心关系，"
            "换成一个具体类比，再问一个可以直接从例子观察的问题。"
        )
    return {
        "state": current_state,
        "step_index": step_index,
        "directive": directive,
        "fallback": fallback,
        "flow_note": (
            "已按直接解释请求补充支架；当前步骤和有效引导轮次都没有推进。"
            if direct else
            f"已补充第 {support_count} 次支架；“不会/不知道”没有被当作完成。"
        ),
    }


def _support_budget_exit_step(
    step: dict[str, Any],
    *,
    support_count: int,
) -> dict[str, Any]:
    """Expose deterministic exits when support has reached its hard budget."""
    support_exit = {
        "status": "required",
        "reason": "support_budget_exhausted",
        "support_count": support_count,
        "support_budget": SUPPORT_TURN_BUDGET,
        "mastery_unchanged": True,
        "options": [
            {
                "action": "narrow_goal",
                "label": "缩小目标",
                "description": "只保留当前目标中一个可检查的关系，再开始新的有界回合。",
            },
            {
                "action": "switch_method",
                "label": "换一种方法",
                "description": "暂停当前方法，显式选择另一种已登记学习方法。",
            },
            {
                "action": "pause",
                "label": "暂停",
                "description": "保留当前位置，稍后由学习者主动恢复。",
            },
        ],
    }
    return {
        **step,
        "directive": (
            f"{step['directive']} 本方法的 support 回合已达到确定性上限 "
            f"{SUPPORT_TURN_BUDGET}；保持当前状态，不得自动通过、不得进入验证。"
            "最后必须给出三个结构化出口：缩小目标、换一种方法、暂停，并等待学习者选择。"
        ),
        "fallback": (
            f"{step['fallback']}\n\n当前方法的支架回合已达到上限，状态不会自动通过。"
            "请选择下一步：1）缩小目标；2）换一种方法；3）暂停。"
        ),
        "flow_note": (
            f"support 回合已达到上限 {SUPPORT_TURN_BUDGET}；"
            "当前步骤与掌握状态均未推进，等待学习者选择结构化出口。"
        ),
        "support_exit": support_exit,
    }


def _next_step(skill_id: str, current_state: str, goal: str) -> dict[str, Any]:
    if skill_id == "guided_explanation":
        rows = {
            "presenting_core_model": {
                "state": "checking_minimal_example",
                "step_index": 2,
                "directive": (
                    f"学习者刚回应了“{goal}”的核心解释。只修正一个最关键的偏差或确认一个准确关系，"
                    "随后给一个表面不同但结构相同的最小例子，只问一个预测结果的问题。"
                ),
                "fallback": "换一个表面不同的小例子：如果只改变其中一个关键条件，你预测结果会怎样？为什么？",
            },
            "checking_minimal_example": {
                "state": "repairing_explanation",
                "step_index": 3,
                "directive": (
                    "根据学习者对新例子的判断，用两三句话修补核心模型；然后只要求他不用原句，"
                    "用“条件—机制—结果”重新解释一次。"
                ),
                "fallback": "现在不用刚才的原句，请用“条件—机制—结果”三部分把这个概念重新说一遍。",
            },
            "repairing_explanation": {
                "state": "verification_ready",
                "step_index": 4,
                "directive": (
                    "指出学习者重述中一项可检查的进展，并明确讲解和重述仍不是掌握证据；"
                    "邀请进入一道无提示的独立验证，不再追加讲解问题。"
                ),
                "fallback": "核心关系已经可以独立表述。下一步用一道不复用当前例子的题做无提示验证。",
            },
        }
    elif skill_id == "socratic_dialogue":
        rows = {
            "eliciting_prior_model": {
                "state": "testing_assumption",
                "step_index": 2,
                "directive": (
                    f"学习者刚说出了对“{goal}”的当前直觉。先简短复述其中一个有效点，"
                    "再只问一个能检验关键条件、反例或因果方向的问题。不要给完整答案。"
                ),
                "fallback": (
                    "先抓住你刚才的判断：如果把其中一个关键条件反过来或拿掉，结论还成立吗？"
                    "请选择最关键的那个条件，并说说为什么。"
                ),
            },
            "testing_assumption": {
                "state": "building_explanation",
                "step_index": 3,
                "directive": (
                    "学习者已经检验了一个条件。指出其推理中最有价值的一步，然后只问一个问题，"
                    "让他用“因为—所以—只有当”把条件与结论连起来。"
                ),
                "fallback": "现在把前两步连起来：请用“因为……所以……；只有当……时……”重新说一遍。",
            },
            "building_explanation": {
                "state": "verification_ready",
                "step_index": 4,
                "directive": (
                    "学习者已形成一版推理。用一句话肯定具体进展，同时明确普通对话不是掌握证明；"
                    "邀请他点击独立验证，不要再新增教学问题。"
                ),
                "fallback": (
                    "你的推理框架已经连起来了。下一步需要一道不照搬当前表述的独立题，"
                    "确认你能否把这个关系迁移到新情境。"
                ),
            },
        }
    elif skill_id == "feynman_dialogue":
        rows = {
            "awaiting_teach_back": {
                "state": "locating_gap",
                "step_index": 2,
                "directive": (
                    f"学习者刚完成对“{goal}”的第一次复述。先指出一个讲清楚的具体点，"
                    "再只定位一个最关键的含糊词、跳步或条件，并问它如何连接前后因果。"
                    "不要把复述当作掌握证据。"
                ),
                "fallback": (
                    "你已经给出了一版自己的解释。现在只挑其中最容易含糊的一个词："
                    "它具体指什么，又怎样连接前因和结果？"
                ),
            },
            "locating_gap": {
                "state": "revising_explanation",
                "step_index": 3,
                "directive": (
                    "学习者补充了一个模糊处。先指出补充后更清楚的连接，再只要求一次修订："
                    "不用术语重讲，并加入一个例子和一个边界或反例。"
                ),
                "fallback": "现在不用专业术语再讲一次，并补一个具体例子，以及一个不适用的边界或反例。",
            },
            "revising_explanation": {
                "state": "verification_ready",
                "step_index": 4,
                "directive": (
                    "学习者已完成修订复述。总结一项真实进展，并明确复述只是诊断；"
                    "邀请点击独立验证，不要宣称已经学会。"
                ),
                "fallback": (
                    "这次复述已经比第一版更可检查了，但复述仍只是诊断。"
                    "下一步用一道独立变式题验证，才能留下能力证据。"
                ),
            },
        }
    elif skill_id == "learning_file_study":
        rows = {
            "selecting_learning_artifact": {
                "state": "reading_with_anchor",
                "step_index": 2,
                "directive": (
                    f"学习者已确认“{goal}”要使用的讲义或资料。精确读取当前文件，"
                    "只给一个段落/小节锚点、一条核心关系和一个读后检查问题；正文留在纸张。"
                ),
                "fallback": "文件已经选定。请在纸张中先读我标出的这一小节；读完只回答一个问题：其中哪条关系直接服务当前目标？",
            },
            "reading_with_anchor": {
                "state": "practicing_in_file",
                "step_index": 3,
                "directive": (
                    "先回应学习者对阅读锚点的理解，再打开已有练习；没有对齐练习时只提出一次生成并等待确认。"
                    "答案保持隔离，聊天不代替正式提交。"
                ),
                "fallback": "阅读锚点已经完成。下一步在练习纸张里做一道直接检验这条关系的题；需要帮助时我只给最小提示。",
            },
            "practicing_in_file": {
                "state": "verification_ready",
                "step_index": 4,
                "directive": (
                    "只引用当前作用域中真实存在的 Attempt 和卡点做简短复盘；没有正式提交就明确暂无证据。"
                    "区分独立、提示和阅读，不新增教学问题，交给独立验证或复习。"
                ),
                "fallback": "文件阅读和练习阶段到这里收束；下一步依据正式提交结果进入独立验证或复习，暂无提交时不会宣布掌握。",
            },
        }
    else:
        rows = {
            "studying_worked_example": {
                "state": "completing_last_step",
                "step_index": 2,
                "directive": (
                    f"学习者已看过“{goal}”的完整示例。换一个近似情境，保留前面子目标，"
                    "只隐藏最后一个解题或代码步骤，让学习者补全并说明该步满足哪个子目标。"
                    "不要同时挖掉多个步骤。"
                ),
                "fallback": "现在换一个近似输入，我保留前面的步骤；请只补全最后一步，并说明它完成了哪个子目标。",
            },
            "completing_last_step": {
                "state": "solving_faded_example",
                "step_index": 3,
                "directive": (
                    "先对刚补的步骤给出具体反馈。再提供一个同结构的新情境，只保留子目标标签和起始条件，"
                    "让学习者完成其余关键步骤；每次只要求一个可检查产物。"
                ),
                "fallback": "再来一个同结构的新情境：这次只保留子目标标签和起始条件，请写出其余关键步骤。",
            },
            "solving_faded_example": {
                "state": "verification_ready",
                "step_index": 4,
                "directive": (
                    "总结学习者在撤去支架后实际完成的步骤，并明确这仍属于训练；"
                    "邀请进入一个不显示子目标标签和示例的独立变式验证。"
                ),
                "fallback": "支架已经撤到只剩目标。下一步请进入无示例、无子目标提示的独立变式验证。",
            },
        }
    return rows.get(current_state, {
        "state": "verification_ready",
        "step_index": 4,
        "directive": "当前 SkillRun 已达到追问预算。停止追加讲解，邀请学习者进入独立验证。",
        "fallback": "这段引导已经达到本轮预算。请进入独立验证，确认能否在新情境中使用它。",
    })


def _feynman_repair_step(
    goal: str,
    diagnostic: dict[str, Any],
    calibration: dict[str, str],
    loop_count: int,
) -> dict[str, Any]:
    gap_label = str(diagnostic.get("candidate_gap_label") or FEYNMAN_GAP_LABELS["unresolved"])
    scaffold = calibration.get("scaffold_level", "guided")
    representation = calibration.get("representation_mode", "auto")
    support_instruction = {
        "model": "先示范一段只修补该缺口的两句解释，再让学习者改写同一关系",
        "guided": "给一个半成品句架，只让学习者补上缺失连接",
        "minimal": "只给一个关键词提示，让学习者自行重讲",
        "none": "不提供内容提示，只指出要修订的连接",
    }.get(scaffold, "给一个半成品句架，只让学习者补上缺失连接")
    representation_instruction = {
        "code": "优先用最小代码或输入输出变化承载修订",
        "visual": "优先用可视化位置、箭头或流程关系承载修订",
        "analogy": "允许一个可逐项映射的类比，但必须指出类比边界",
        "formal": "允许公式或形式化关系，但要求逐项解释符号",
        "auto": "选择当前概念最短、最可检查的表征",
    }.get(representation, "选择当前概念最短、最可检查的表征")
    return {
        "state": "revising_explanation",
        "step_index": 3,
        "directive": (
            f"继续围绕“{goal}”的同一个候选缺口“{gap_label}”进行第 {loop_count} 次修订。"
            f"{support_instruction}；{representation_instruction}。一次只处理这一处，不新增第二个缺口，"
            "不判断内容正确或掌握。"
        ),
        "fallback": (
            f"我们仍只修一处：{gap_label}。请把这一个连接重讲一次；完成后会进入无提示验证，"
            "而不是继续扩展新知识。"
        ),
        "flow_note": f"单缺口修订第 {loop_count} 轮：仍停留在同一缺口，不把对话表现当作掌握。",
    }


def transition_learning_skill_turn(
    *,
    skill_id: str,
    current_state: str,
    step_index: int,
    turn_count: int,
    support_count: int,
    goal: str,
    message: str,
    entry_mode: str = "direct",
    calibration: dict[str, Any] | None = None,
    teach_back_diagnostic: dict[str, Any] | None = None,
    gap_loop_count: int = 0,
) -> dict[str, Any]:
    """Pure SkillSpec transition used by runtime tests and multi-turn evals.

    The function classifies interaction shape, never correctness.  Only an
    explicit learner attempt may advance one state; support signals stay put.
    """
    if skill_id not in WORKFLOWS:
        raise ValueError(f"unsupported_skill:{skill_id}")
    if current_state not in WORKFLOWS[skill_id]["states"]:
        raise ValueError(f"unsupported_skill_state:{skill_id}:{current_state}")
    response_signal = learner_response_signal(message)
    normalized_calibration = normalize_feynman_calibration(calibration)
    normalized_choice = re.sub(r"[\s，,。.!！?？、]", "", str(message or "").casefold())
    if (
        entry_mode == "grounded"
        and current_state == WORKFLOWS[skill_id]["initial_state"]
        and re.match(r"^[ab](?:我想|先看|选择|$)", normalized_choice)
    ):
        response_signal = (
            "orientation_problem_choice"
            if normalized_choice.startswith("a") else
            "orientation_example_choice"
        )
    support_only = response_signal != "attempt"
    next_support_count = min(
        SUPPORT_TURN_BUDGET,
        max(0, int(support_count or 0)) + (1 if support_only else 0),
    )
    next_diagnostic = dict(teach_back_diagnostic or {})
    next_gap_loop_count = max(0, int(gap_loop_count or 0))
    if skill_id == "feynman_dialogue" and support_only and response_signal in {
        "no_prior_knowledge", "direct_explanation_requested",
    }:
        normalized_calibration = _increase_scaffold(normalized_calibration)
    if skill_id == "feynman_dialogue" and response_signal == "no_prior_knowledge":
        next_diagnostic = build_teach_back_diagnostic(
            message,
            calibration=normalized_calibration,
        )
        next_diagnostic.update({
            "candidate_gap": "missing_prerequisite",
            "candidate_gap_label": FEYNMAN_GAP_LABELS["missing_prerequisite"],
            "status": "needs_primer",
        })
    next_step = (
        _support_step(
            skill_id,
            current_state,
            step_index,
            goal,
            response_signal,
            next_support_count,
        )
        if support_only else
        _next_step(skill_id, current_state, goal)
    )
    if support_only and next_support_count >= SUPPORT_TURN_BUDGET:
        next_step = _support_budget_exit_step(
            next_step,
            support_count=next_support_count,
        )
    next_turn_count = turn_count + (0 if support_only else 1)
    if skill_id == "feynman_dialogue" and not support_only:
        preserve_gap = current_state != "awaiting_teach_back"
        next_diagnostic = build_teach_back_diagnostic(
            message,
            calibration=normalized_calibration,
            previous=teach_back_diagnostic,
            preserve_gap=preserve_gap,
        )
        if current_state == "revising_explanation":
            addressed = _gap_observably_addressed(
                dict(teach_back_diagnostic or next_diagnostic),
                message,
                normalized_calibration,
            )
            if addressed:
                next_diagnostic["status"] = "ready_for_independent_verification"
                next_diagnostic["support_used"] = normalized_calibration.get("scaffold_level")
            else:
                next_gap_loop_count += 1
                if (
                    next_gap_loop_count <= 2
                    and next_turn_count < int(WORKFLOWS[skill_id]["turn_budget"])
                ):
                    next_step = _feynman_repair_step(
                        goal,
                        next_diagnostic,
                        normalized_calibration,
                        next_gap_loop_count,
                    )
                else:
                    next_step = _next_step(skill_id, "budget_exhausted", goal)
                    next_diagnostic["status"] = "unresolved_before_independent_verification"
                    next_diagnostic["verification_focus"] = next_diagnostic.get("candidate_gap")
    if (
        not support_only
        and next_turn_count >= int(WORKFLOWS[skill_id]["turn_budget"])
        and next_step["state"] != "verification_ready"
    ):
        next_step = _next_step(skill_id, "budget_exhausted", goal)
    return {
        **next_step,
        "response_signal": response_signal,
        "support_only": support_only,
        "support_count": next_support_count,
        "support_budget": SUPPORT_TURN_BUDGET,
        "support_exit": dict(next_step.get("support_exit") or {}),
        "turn_count": next_turn_count,
        "calibration": normalized_calibration,
        "teach_back_diagnostic": next_diagnostic,
        "gap_loop_count": next_gap_loop_count,
        "advanced": str(next_step["state"]) != current_state,
    }


async def active_skill_run(
    db: AsyncSession, session: AgentSession,
) -> LearningSkillRun | None:
    return (await db.execute(
        select(LearningSkillRun).where(
            LearningSkillRun.learner_id == session.learner_id,
            LearningSkillRun.session_id == session.id,
            LearningSkillRun.status.in_(ACTIVE_RUN_STATUSES),
        ).order_by(LearningSkillRun.updated_at.desc(), LearningSkillRun.id.desc()).limit(1)
    )).scalar_one_or_none()


async def latest_skill_run(
    db: AsyncSession, session: AgentSession,
) -> LearningSkillRun | None:
    return (await db.execute(
        select(LearningSkillRun).where(
            LearningSkillRun.learner_id == session.learner_id,
            LearningSkillRun.session_id == session.id,
            LearningSkillRun.status != "canceled",
        ).order_by(LearningSkillRun.updated_at.desc(), LearningSkillRun.id.desc()).limit(1)
    )).scalar_one_or_none()


async def _validate_session_scope(
    db: AsyncSession,
    session: AgentSession,
) -> tuple[Project | None, Checkpoint | None]:
    """Validate the persisted session and its exact learner-owned scope."""
    persisted = (await db.execute(select(AgentSession).where(
        AgentSession.id == session.id,
        AgentSession.learner_id == session.learner_id,
        AgentSession.status == "active",
    ))).scalar_one_or_none()
    if (
        not persisted
        or persisted.session_type != session.session_type
        or persisted.project_id != session.project_id
        or persisted.checkpoint_id != session.checkpoint_id
    ):
        raise RuntimeError("unsupported_scope")

    if session.session_type == "global":
        if session.project_id is not None or session.checkpoint_id is not None:
            raise RuntimeError("unsupported_scope")
        return None, None

    if session.session_type == "project":
        if session.project_id is None or session.checkpoint_id is not None:
            raise RuntimeError("unsupported_scope")
        project = (await db.execute(select(Project).where(
            Project.id == session.project_id,
            Project.learner_id == session.learner_id,
            Project.visibility != "deleted",
        ))).scalar_one_or_none()
        if not project:
            raise RuntimeError("unsupported_scope")
        return project, None

    if session.session_type == "checkpoint":
        if session.project_id is None or session.checkpoint_id is None:
            raise RuntimeError("unsupported_scope")
        row = (await db.execute(
            select(Checkpoint, Roadmap, Project)
            .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
            .join(Project, Project.id == Roadmap.project_id)
            .where(
                Checkpoint.id == session.checkpoint_id,
                Roadmap.project_id == session.project_id,
                Project.id == session.project_id,
                Project.learner_id == session.learner_id,
                Project.visibility != "deleted",
            )
        )).first()
        if not row:
            raise RuntimeError("unsupported_scope")
        return row[2], row[0]

    raise RuntimeError("unsupported_scope")


def _task_matches_session_scope(task: LearningTask, session: AgentSession) -> bool:
    return bool(
        task.learner_id == session.learner_id
        and task.session_id == session.id
        and task.project_id == session.project_id
        and task.checkpoint_id == session.checkpoint_id
    )


async def validate_learning_skill_run_scope(
    db: AsyncSession,
    *,
    session: AgentSession,
    run: LearningSkillRun,
) -> None:
    """Require learner, session, project, checkpoint and linked-task ownership."""
    await _validate_session_scope(db, session)
    if run.learner_id != session.learner_id or run.session_id != session.id:
        raise RuntimeError("unsupported_scope")
    if run.learning_task_id:
        task = await db.get(LearningTask, run.learning_task_id)
        if not task or not _task_matches_session_scope(task, session):
            raise RuntimeError("unsupported_scope")


async def _linked_learning_task(
    db: AsyncSession, run: LearningSkillRun,
) -> LearningTask | None:
    if not run.learning_task_id:
        return None
    task = (await db.execute(select(LearningTask).where(
        LearningTask.id == run.learning_task_id,
        LearningTask.learner_id == run.learner_id,
    ))).scalar_one_or_none()
    session = await db.get(AgentSession, run.session_id)
    if not task or not session or not _task_matches_session_scope(task, session):
        return None
    return task


async def _advance_linked_task(
    db: AsyncSession,
    run: LearningSkillRun,
    *,
    action: str,
    operation_id: str,
) -> LearningTask | None:
    session = await db.get(AgentSession, run.session_id)
    if not session:
        raise RuntimeError("unsupported_scope")
    await validate_learning_skill_run_scope(db, session=session, run=run)
    task = await _linked_learning_task(db, run)
    if run.learning_task_id and not task:
        raise RuntimeError("unsupported_scope")
    if not task:
        return None
    from app.services.learning_tasks import advance_learning_task_from_skill

    return await advance_learning_task_from_skill(
        db,
        task=task,
        skill_run_id=run.id,
        action=action,
        operation_id=operation_id,
    )


async def _ensure_atomic_learning_task(
    db: AsyncSession,
    *,
    session: AgentSession,
    run: LearningSkillRun,
    source: str,
) -> LearningTask:
    """Attach one learner-visible atomic task to the SkillRun."""
    _project, checkpoint = await _validate_session_scope(db, session)
    if run.learner_id != session.learner_id or run.session_id != session.id:
        raise RuntimeError("unsupported_scope")

    task: LearningTask
    if run.learning_task_id:
        linked = await db.get(LearningTask, run.learning_task_id)
        if not linked or not _task_matches_session_scope(linked, session):
            raise RuntimeError("unsupported_scope")
        task = linked
    elif checkpoint:
        from app.services.learning_tasks import ensure_checkpoint_learning_task

        task = await ensure_checkpoint_learning_task(
            db,
            learner_id=run.learner_id,
            checkpoint=checkpoint,
            session_id=session.id,
        )
        if not _task_matches_session_scope(task, session):
            raise RuntimeError("unsupported_scope")
        run.learning_task_id = task.id
    else:
        existing = (await db.execute(select(LearningTask).where(
            LearningTask.learner_id == run.learner_id,
            LearningTask.session_id == session.id,
            LearningTask.project_id == session.project_id,
            LearningTask.checkpoint_id == session.checkpoint_id,
            LearningTask.objective == run.goal,
            LearningTask.status.in_({"queued", "active", "paused"}),
        ).order_by(LearningTask.id.desc()).limit(1))).scalar_one_or_none()
        if existing:
            task = existing
            run.learning_task_id = existing.id
        else:
            from app.services.learning_tasks import create_learning_task

            skill = selectable_learning_skill(run.skill_id)
            source_refs = [{"type": "learning_skill_run", "id": run.id}]
            origin_message_id = int(dict(run.run_data or {}).get("origin_message_id") or 0)
            if origin_message_id:
                source_refs.append({"type": "conversation_message", "id": origin_message_id})
            task, _ = await create_learning_task(
                db,
                learner_id=run.learner_id,
                session_id=session.id,
                project_id=session.project_id,
                checkpoint_id=session.checkpoint_id,
                title=f"{skill.name if skill else '学习方法'}：{run.goal}"[:255],
                objective=run.goal,
                client_request_id=f"skill-task:{run.id}",
                origin_kind="skill",
                created_by=source,
                status="active",
                estimated_minutes=20,
                preferred_skills=[run.skill_id],
                success_criteria=[
                    "完成本方法的有界引导",
                    "完成至少一次无提示独立验证",
                    "把合格评估转交复习队列",
                ],
                source_refs=source_refs,
            )
            if not _task_matches_session_scope(task, session):
                raise RuntimeError("unsupported_scope")
            run.learning_task_id = task.id
    if task.status == "queued":
        await _advance_linked_task(
            db, run, action="start", operation_id=f"attach-{run.id}",
        )
    elif task.status == "paused":
        await _advance_linked_task(
            db, run, action="resume", operation_id=f"attach-{run.id}",
        )
    run.run_data = {
        **dict(run.run_data or {}),
        "learning_task_id": task.id,
        "task_contract": "learn -> practice -> verify -> consolidate",
    }
    return task


async def _attach_skill_domain_context(
    db: AsyncSession,
    *,
    run: LearningSkillRun,
    message_id: int,
) -> None:
    """Bind the real prompt and a scoped domain packet to the formal task."""
    task = await _linked_learning_task(db, run)
    if not task:
        return
    refs = [dict(item) for item in list(task.source_refs or []) if isinstance(item, dict)]
    message_ref = {"type": "conversation_message", "id": message_id}
    if message_id and message_ref not in refs:
        refs.append(message_ref)
    message = await db.get(AgentMessage, message_id) if message_id else None
    message_source_ids = [
        int(item) for item in list(dict(message.meta_data or {}).get("domain_source_ids") or [])
        if str(item).isdigit() and int(item) > 0
    ] if message else []
    run_source_ids = [
        int(item) for item in list(dict(run.run_data or {}).get("domain_source_ids") or [])
        if str(item).isdigit() and int(item) > 0
    ]
    source_ids = list(dict.fromkeys([*message_source_ids, *run_source_ids]))
    from app.services.domain_knowledge import compile_domain_knowledge_packet
    packet = await compile_domain_knowledge_packet(
        db,
        learner_id=run.learner_id,
        query=run.goal,
        kind="guided_skill",
        source_ids=source_ids or None,
        project_id=task.project_id,
        checkpoint_id=task.checkpoint_id,
        session_id=task.session_id,
        learning_task_id=task.id,
        skill_id=run.skill_id,
    )
    packet_ref = {"type": "domain_knowledge_packet", "id": packet.id}
    refs = [item for item in refs if item.get("type") != "domain_knowledge_packet"]
    refs.append(packet_ref)
    task.source_refs = refs[:20]
    task.execution_state = {
        **dict(task.execution_state or {}),
        "domain_knowledge_packet_id": packet.id,
        "domain_knowledge_status": packet.status,
        "domain_knowledge_gaps": list(packet.unresolved_gaps or []),
    }
    run.run_data = {
        **dict(run.run_data or {}),
        "origin_message_id": message_id,
        "domain_knowledge_packet_id": packet.id,
        "domain_knowledge_status": packet.status,
    }


async def _record_run_event(
    db: AsyncSession,
    run: LearningSkillRun,
    event_type: str,
    *,
    payload: dict[str, Any] | None = None,
    client_event_id: str,
    source: str = "skill_runtime",
) -> None:
    session = await db.get(AgentSession, run.session_id)
    if not session:
        raise RuntimeError("unsupported_scope")
    await validate_learning_skill_run_scope(db, session=session, run=run)
    await record_event(
        db,
        learner_id=run.learner_id,
        project_id=session.project_id,
        checkpoint_id=session.checkpoint_id,
        session_id=run.session_id,
        event_type=event_type,
        source=source,
        payload={
            "skill_run_id": run.id,
            "learning_task_id": run.learning_task_id,
            "skill_id": run.skill_id,
            "goal": run.goal,
            "state": run.state,
            "runtime_version": run.skill_version,
            **dict(payload or {}),
        },
        provenance={
            "skill_run_id": run.id,
            "runtime_version": run.skill_version,
            "decision_owner": "deterministic_skill_runtime",
        },
        client_event_id=client_event_id,
    )


async def create_learning_skill_run(
    db: AsyncSession,
    *,
    session: AgentSession,
    skill_id: str,
    goal: str,
    client_request_id: str,
    source: str = "user",
    domain_source_ids: list[int] | None = None,
    learning_task_id: int | None = None,
) -> tuple[LearningSkillRun, bool]:
    await _validate_session_scope(db, session)
    if skill_id not in RUNTIME_SKILL_IDS or not selectable_learning_skill(skill_id):
        raise RuntimeError("unsupported_skill")
    normalized_goal = _learning_goal(goal, skill_id)
    if len(normalized_goal) < 2:
        raise RuntimeError("missing_goal")
    requested_task: LearningTask | None = None
    if learning_task_id:
        requested_task = (await db.execute(select(LearningTask).where(
            LearningTask.id == learning_task_id,
            LearningTask.learner_id == session.learner_id,
            LearningTask.status.in_({"queued", "active", "paused"}),
        ))).scalar_one_or_none()
        if (
            not requested_task
            or requested_task.project_id != session.project_id
            or requested_task.checkpoint_id != session.checkpoint_id
            or requested_task.session_id not in {None, session.id}
        ):
            raise RuntimeError("unsupported_scope")
        if requested_task.session_id is None:
            requested_task.session_id = session.id
    request_key = f"skill-run:{session.id}:{client_request_id}"
    existing = (await db.execute(select(LearningSkillRun).where(
        LearningSkillRun.learner_id == session.learner_id,
        LearningSkillRun.client_request_id == request_key,
    ))).scalar_one_or_none()
    if existing:
        await validate_learning_skill_run_scope(db, session=session, run=existing)
        if requested_task and existing.learning_task_id not in {None, requested_task.id}:
            raise RuntimeError("unsupported_scope")
        if requested_task and not existing.learning_task_id:
            existing.learning_task_id = requested_task.id
        await _ensure_atomic_learning_task(
            db, session=session, run=existing, source=source,
        )
        await validate_learning_skill_run_scope(db, session=session, run=existing)
        return existing, False

    current = await active_skill_run(db, session)
    if (
        current
        and current.skill_id == skill_id
        and current.goal == normalized_goal
        and (not requested_task or current.learning_task_id == requested_task.id)
    ):
        await validate_learning_skill_run_scope(db, session=session, run=current)
        if not current.learning_task_id:
            await _ensure_atomic_learning_task(
                db, session=session, run=current, source=source,
            )
        await validate_learning_skill_run_scope(db, session=session, run=current)
        return current, False
    if current:
        await validate_learning_skill_run_scope(db, session=session, run=current)
        previous_state = current.state
        current.status = "paused"
        current.state = "paused"
        current.run_data = {
            **dict(current.run_data or {}),
            "resume_state": previous_state,
            "paused_reason": "skill_switched",
        }
        current.version += 1
        current.updated_at = datetime.utcnow()
        await _record_run_event(
            db, current, "learning_skill_run_paused",
            payload={"resume_state": previous_state, "reason": "skill_switched"},
            client_event_id=f"learning-skill-run:{current.id}:switched:{current.version}",
        )
        await _advance_linked_task(
            db,
            current,
            action="pause",
            operation_id=f"skill-switched-{current.version}",
        )

    workflow = WORKFLOWS[skill_id]
    grounded_entry = skill_id in {"socratic_dialogue", "feynman_dialogue"} and _needs_grounded_entry(goal)
    directive, fallback = _opening_prompt(
        skill_id,
        normalized_goal,
        grounded_entry=grounded_entry,
    )
    profile = await db.get(LearnerProfile, session.learner_id)
    calibration = (
        normalize_feynman_calibration(
            None,
            education_stage=profile.education_stage if profile else "",
        )
        if skill_id == "feynman_dialogue" else None
    )
    initial_data: dict[str, Any] = {
        "responses": [],
        "next_directive": directive,
        "next_prompt": fallback,
        "verification_required": True,
        "mastery_claim": "none",
        "entry_mode": "grounded" if grounded_entry else "standard",
        "support_count": 0,
        "support_budget": SUPPORT_TURN_BUDGET,
        "support_exit": {},
        "last_response_signal": "opening",
        "domain_source_ids": list(domain_source_ids or [])[:20],
        "flow_note": (
            "先建立可回答的知识起点，再进入单步追问。"
            if grounded_entry else
            "每次只推进一个可检查的学习动作。"
        ),
    }
    if calibration is not None:
        initial_data.update({
            "calibration": calibration,
            "teach_back_diagnostic": {},
            "gap_loop_count": 0,
        })
    run = LearningSkillRun(
        learner_id=session.learner_id,
        session_id=session.id,
        skill_id=skill_id,
        skill_version=SKILL_RUNTIME_VERSION,
        goal=normalized_goal,
        status="active",
        state=str(workflow["initial_state"]),
        step_index=1,
        turn_count=0,
        turn_budget=int(workflow["turn_budget"]),
        run_data=initial_data,
        action_log=[],
        client_request_id=request_key,
        learning_task_id=requested_task.id if requested_task else None,
        version=1,
    )
    db.add(run)
    await db.flush()
    await _ensure_atomic_learning_task(
        db, session=session, run=run, source=source,
    )
    await _attach_skill_domain_context(db, run=run, message_id=0)
    await _record_run_event(
        db, run, "learning_skill_run_started",
        payload={"source": source, "turn_budget": run.turn_budget},
        client_event_id=f"learning-skill-run:{run.id}:started",
        source=source,
    )
    if calibration is not None:
        await _record_run_event(
            db, run, "learning_skill_calibration_updated",
            payload={
                "calibration": calibration,
                "reason": "profile_seeded_default",
                "mastery_unchanged": True,
            },
            client_event_id=f"learning-skill-run:{run.id}:calibration:initial",
            source="runtime",
        )
    return run, True


async def pause_active_skill_run_for_selection(
    db: AsyncSession,
    *,
    session: AgentSession,
    selected_skill_id: str | None,
) -> LearningSkillRun | None:
    current = await active_skill_run(db, session)
    if not current or selected_skill_id == current.skill_id:
        return current
    await validate_learning_skill_run_scope(db, session=session, run=current)
    previous_state = current.state
    current.status = "paused"
    current.state = "paused"
    current.run_data = {
        **dict(current.run_data or {}),
        "resume_state": previous_state,
        "paused_reason": "skill_selection_changed",
    }
    current.version += 1
    current.updated_at = datetime.utcnow()
    await _record_run_event(
        db, current, "learning_skill_run_paused",
        payload={"resume_state": previous_state, "reason": "skill_selection_changed"},
        client_event_id=f"learning-skill-run:{current.id}:selection-paused:{current.version}",
    )
    await _advance_linked_task(
        db,
        current,
        action="pause",
        operation_id=f"selection-paused-{current.version}",
    )
    return current


def current_learning_skill_turn_plan(
    run: LearningSkillRun,
    *,
    started: bool = False,
) -> dict[str, Any]:
    """Project the already-decided render plan without advancing the run."""
    data = dict(run.run_data or {})
    response_signal = str(data.get("last_response_signal") or "")
    return {
        "started": started,
        "directive": str(data.get("next_directive") or ""),
        "fallback": str(data.get("next_prompt") or ""),
        "response_signal": response_signal,
        "support_only": response_signal not in {"", "opening", "attempt"},
        "support_count": int(data.get("support_count") or 0),
        "support_budget": int(data.get("support_budget") or SUPPORT_TURN_BUDGET),
        "support_exit": dict(data.get("support_exit") or {}),
        "run_version": run.version,
    }


def is_learning_skill_opening_turn(run: LearningSkillRun, message: str) -> bool:
    """Recognize the learner message that only opened an already-created run."""
    data = dict(run.run_data or {})
    return bool(
        run.status == "active"
        and run.turn_count == 0
        and not list(data.get("responses") or [])
        and _learning_goal(message, run.skill_id) == run.goal
    )


async def prepare_learning_skill_turn(
    db: AsyncSession,
    *,
    session: AgentSession,
    skill_id: str,
    message: str,
    message_id: int,
    client_turn_id: str | None,
    expected_run_id: int | None = None,
    domain_source_ids: list[int] | None = None,
) -> tuple[LearningSkillRun, dict[str, Any]]:
    await _validate_session_scope(db, session)
    current = await active_skill_run(db, session)
    if expected_run_id is not None and (
        not current or current.id != expected_run_id or current.skill_id != skill_id
    ):
        raise RuntimeError("invalid_state")
    if not current or current.skill_id != skill_id:
        run, _ = await create_learning_skill_run(
            db,
            session=session,
            skill_id=skill_id,
            goal=message,
            client_request_id=client_turn_id or f"message-{message_id}",
            source="user",
            domain_source_ids=domain_source_ids,
        )
        await _attach_skill_domain_context(db, run=run, message_id=message_id)
        return run, current_learning_skill_turn_plan(run, started=True)

    await validate_learning_skill_run_scope(db, session=session, run=current)
    await _attach_skill_domain_context(db, run=current, message_id=message_id)

    if current.status == "verification":
        return current, {
            **current_learning_skill_turn_plan(current),
            "directive": "独立验证已经创建。回答当前问题前，提醒学习者打开或继续验证附件。",
            "fallback": "独立验证已经准备好。请打开下方验证卡继续；完成后这里会自动记录本轮结果。",
        }

    if current.status == "paused":
        resume_state = str((current.run_data or {}).get("resume_state") or WORKFLOWS[skill_id]["initial_state"])
        current.status = "active"
        current.state = resume_state
        current.version += 1
        current.updated_at = datetime.utcnow()
        await _record_run_event(
            db, current, "learning_skill_run_resumed",
            payload={"resume_state": resume_state, "reason": "learner_returned"},
            client_event_id=f"learning-skill-run:{current.id}:auto-resumed:{current.version}",
        )
        await _advance_linked_task(
            db,
            current,
            action="resume",
            operation_id=f"auto-resumed-{current.version}",
        )

    turn_key = f"turn:{session.id}:{client_turn_id or message_id}"
    history = list(current.action_log or [])
    if turn_key in history:
        return current, current_learning_skill_turn_plan(current)
    if current.state in {"verification_ready", "verification_in_progress", "completed"}:
        if current.state == "verification_ready":
            await _advance_linked_task(
                db,
                current,
                action="complete_learn",
                operation_id="verification-ready",
            )
        return current, {
            **current_learning_skill_turn_plan(current),
            "directive": str((current.run_data or {}).get(
                "next_directive", "停止追加教学问题，邀请学习者进入独立验证。",
            )),
            "fallback": str((current.run_data or {}).get(
                "next_prompt", "请开始独立验证，完成后再继续讨论。",
            )),
        }

    data = dict(current.run_data or {})
    if (
        int(data.get("support_count") or 0) >= SUPPORT_TURN_BUDGET
        and learner_response_signal(message) != "attempt"
    ):
        # The learner message and its EvidenceEvent still exist, but the formal
        # support loop is closed: reuse the persisted exit plan without another
        # SkillRun transition, version bump, or model-owned state decision.
        return current, current_learning_skill_turn_plan(current)
    previous_state = current.state
    transition = transition_learning_skill_turn(
        skill_id=current.skill_id,
        current_state=previous_state,
        step_index=current.step_index,
        turn_count=current.turn_count,
        support_count=int(data.get("support_count") or 0),
        goal=current.goal,
        message=message,
        entry_mode=str(data.get("entry_mode") or "direct"),
        calibration=dict(data.get("calibration") or {}),
        teach_back_diagnostic=dict(data.get("teach_back_diagnostic") or {}),
        gap_loop_count=int(data.get("gap_loop_count") or 0),
    )
    response_signal = str(transition["response_signal"])
    support_only = bool(transition["support_only"])
    support_count = int(transition["support_count"])
    responses = list(data.get("responses") or [])
    responses.append({
        "message_id": message_id,
        "text": str(message or "")[:4000],
        "state": previous_state,
        "response_signal": response_signal,
        "recorded_at": datetime.utcnow().isoformat(),
    })
    current.turn_count = int(transition["turn_count"])
    current.state = str(transition["state"])
    current.step_index = int(transition["step_index"])
    next_run_data = {
        **data,
        "responses": responses[-12:],
        "next_directive": transition["directive"],
        "next_prompt": transition["fallback"],
        "mastery_claim": "none",
        "support_count": support_count,
        "support_budget": int(transition["support_budget"]),
        "support_exit": dict(transition.get("support_exit") or {}),
        "last_response_signal": response_signal,
        "flow_note": transition.get(
            "flow_note",
            "已收到一个可检查的尝试，流程只推进了一步。",
        ),
    }
    if current.skill_id == "feynman_dialogue":
        next_run_data.update({
            "calibration": dict(transition.get("calibration") or {}),
            "teach_back_diagnostic": dict(transition.get("teach_back_diagnostic") or {}),
            "gap_loop_count": int(transition.get("gap_loop_count") or 0),
        })
    current.run_data = next_run_data
    current.action_log = [*history, turn_key][-80:]
    current.version += 1
    current.updated_at = datetime.utcnow()
    await _record_run_event(
        db, current, "learning_skill_run_advanced",
        payload={
            "from_state": previous_state,
            "to_state": current.state,
            "turn_count": current.turn_count,
            "message_id": message_id,
            "response_signal": response_signal,
            "support_only": support_only,
            "support_count": support_count,
            "support_budget": int(transition["support_budget"]),
            "support_exit": dict(transition.get("support_exit") or {}),
            "mastery_unchanged": True,
        },
        client_event_id=f"learning-skill-run:{current.id}:{turn_key}:advanced",
        source="user",
    )
    if current.skill_id == "feynman_dialogue":
        previous_calibration = dict(data.get("calibration") or {})
        next_calibration = dict(transition.get("calibration") or {})
        if next_calibration != previous_calibration:
            await _record_run_event(
                db, current, "learning_skill_calibration_updated",
                payload={
                    "calibration": next_calibration,
                    "reason": "bounded_support_adjustment",
                    "mastery_unchanged": True,
                },
                client_event_id=f"learning-skill-run:{current.id}:{turn_key}:calibration",
                source="runtime",
            )
        previous_diagnostic = dict(data.get("teach_back_diagnostic") or {})
        next_diagnostic = dict(transition.get("teach_back_diagnostic") or {})
        if next_diagnostic and next_diagnostic != previous_diagnostic:
            await _record_run_event(
                db, current, "learning_skill_teach_back_diagnostic_updated",
                payload={
                    "diagnostic": next_diagnostic,
                    "mastery_unchanged": True,
                    "kernel_write": "none_until_independent_verification",
                },
                client_event_id=f"learning-skill-run:{current.id}:{turn_key}:diagnostic",
                source="runtime",
            )
    if current.state == "verification_ready":
        await _advance_linked_task(
            db,
            current,
            action="complete_learn",
            operation_id=f"turn-{current.turn_count}",
        )
    return current, current_learning_skill_turn_plan(current)


async def reconcile_learning_skill_run(
    db: AsyncSession, run: LearningSkillRun,
) -> bool:
    if not run.micro_learning_run_id or run.status == "completed":
        return False
    micro = await db.get(MicroLearningRun, run.micro_learning_run_id)
    if not micro or micro.learner_id != run.learner_id or micro.status != "completed":
        return False
    run.status = "completed"
    run.state = "completed"
    run.step_index = int(WORKFLOWS[run.skill_id]["total_steps"])
    run.completed_at = run.completed_at or datetime.utcnow()
    run.run_data = {
        **dict(run.run_data or {}),
        "verified_summary": dict(micro.summary or {}),
        "mastery_claim": "not_stable_yet",
        "next_prompt": "本轮已有独立验证记录；稳定掌握仍需要后续跨时间复习。",
    }
    run.version += 1
    run.updated_at = datetime.utcnow()
    await _record_run_event(
        db, run, "learning_skill_run_completed",
        payload={
            "micro_learning_run_id": micro.id,
            "mastery_claim": "not_stable_yet",
            "review_schedule_ids": list((micro.summary or {}).get("review_schedule_ids") or []),
        },
        client_event_id=f"learning-skill-run:{run.id}:completed",
        source="runtime",
    )
    task = await _linked_learning_task(db, run)
    if task:
        from app.services.learning_tasks import reconcile_learning_task

        await reconcile_learning_task(db, task)
    return True


def _workflow_stage_projection(
    run: LearningSkillRun,
    workflow: dict[str, Any],
    data: dict[str, Any],
) -> list[dict[str, Any]]:
    states = list(workflow.get("states") or [])
    labels = dict(workflow.get("labels") or {})
    if not states:
        return []
    active_state = run.state
    if run.state == "paused":
        active_state = str(data.get("resume_state") or states[0])
    elif run.state == "verification_in_progress":
        active_state = states[-1]
    try:
        active_index = states.index(active_state)
    except ValueError:
        active_index = len(states) - 1 if run.state == "completed" else 0
    result = []
    for index, state in enumerate(states):
        if run.state == "completed" or index < active_index:
            status = "completed"
        elif index == active_index:
            status = "current"
        else:
            status = "locked"
        result.append({
            "id": state,
            "label": str(labels.get(state) or state),
            "status": status,
        })
    return result


async def learning_skill_run_view(
    db: AsyncSession, run: LearningSkillRun | None,
) -> dict[str, Any] | None:
    if not run:
        return None
    await reconcile_learning_skill_run(db, run)
    skill = selectable_learning_skill(run.skill_id)
    workflow = WORKFLOWS.get(run.skill_id, {})
    data = dict(run.run_data or {})
    session = await db.get(AgentSession, run.session_id)
    micro = await db.get(MicroLearningRun, run.micro_learning_run_id) if run.micro_learning_run_id else None
    task = await _linked_learning_task(db, run)
    total_steps = int(workflow.get("total_steps") or 4)
    runtime_contract = learning_skill_runtime_contract(run.skill_id)
    calibration_axes = [
        {
            "id": axis.id,
            "title": axis.title,
            "description": axis.description,
            "default": axis.default,
            "options": [{"id": option_id, "label": label} for option_id, label in axis.options],
        }
        for axis in (runtime_contract.calibration_axes if runtime_contract else ())
    ]
    calibration = (
        normalize_feynman_calibration(data.get("calibration"))
        if run.skill_id == "feynman_dialogue" else
        dict(data.get("calibration") or {})
    )
    return {
        "id": run.id,
        "skill": {
            "id": run.skill_id,
            "name": skill.name if skill else run.skill_id,
            "description": skill.description if skill else "",
        },
        "runtime_version": run.skill_version,
        "scope": {
            "session_id": run.session_id,
            "project_id": session.project_id if session and session.learner_id == run.learner_id else None,
            "checkpoint_id": session.checkpoint_id if session and session.learner_id == run.learner_id else None,
        },
        "goal": run.goal,
        "status": run.status,
        "state": run.state,
        "stage_label": dict(workflow.get("labels") or {}).get(run.state, run.state),
        "step_index": run.step_index,
        "total_steps": total_steps,
        "turn_count": run.turn_count,
        "turn_budget": run.turn_budget,
        "support_count": int(data.get("support_count") or 0),
        "support_budget": int(data.get("support_budget") or SUPPORT_TURN_BUDGET),
        "support_exit": dict(data.get("support_exit") or {}),
        "gap_loop_count": int(data.get("gap_loop_count") or 0),
        "calibration": calibration,
        "calibration_axes": calibration_axes,
        "teach_back_diagnostic": dict(data.get("teach_back_diagnostic") or {}),
        "last_response_signal": str(data.get("last_response_signal") or ""),
        "flow_note": str(data.get("flow_note") or "每次只推进一个可检查的学习动作。"),
        "stages": _workflow_stage_projection(run, workflow, data),
        "version": run.version,
        "next_prompt": str(data.get("next_prompt") or ""),
        "can_start_verification": run.state == "verification_ready" and not run.micro_learning_run_id,
        "can_pause": run.status in {"active", "verification"},
        "can_resume": run.status == "paused",
        "verification_required": True,
        "evidence_note": (
            "本轮已有独立验证；稳定掌握仍需跨时间复习。"
            if run.status == "completed"
            else "对话只用于引导；只有独立题、纠错和复习会形成能力证据。"
        ),
        "learning_task": ({
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "current_phase_id": task.current_phase_id,
            "plan_version": task.plan_version,
            "version": task.version,
            "path": (
                f"/projects/{task.project_id}/checkpoints/{task.checkpoint_id}"
                if task.project_id and task.checkpoint_id else
                f"/agent/{task.session_id}" if task.session_id else
                f"/tasks?task={task.id}"
            ),
            "management_path": f"/tasks?task={task.id}",
            "artifact_path": (
                f"/learn/{task.micro_learning_run_id}"
                if task.micro_learning_run_id else None
            ),
        } if task else None),
        "micro_learning_run": ({
            "id": micro.id,
            "goal": micro.goal,
            "status": micro.status,
            "state": micro.state,
            "version": micro.version,
            "summary": dict(micro.summary or {}),
        } if micro else None),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
    }


async def latest_learning_skill_run_view(
    db: AsyncSession, session: AgentSession,
) -> dict[str, Any] | None:
    return await learning_skill_run_view(db, await latest_skill_run(db, session))


async def _materialize_skill_verification(
    db: AsyncSession,
    *,
    task: LearningTask,
    run: LearningSkillRun,
    client_action_id: str,
    education_stage: str,
    background: str,
) -> MicroLearningRun:
    """Create a verification artifact without moving the origin task's scope."""
    from app.services.learning_tasks import RUNTIME_VERSION as LEARNING_TASK_RUNTIME_VERSION
    from app.services.micro_learning import create_micro_learning_run

    request_id = f"skill-run-{run.id}-{client_action_id}"
    micro = await create_micro_learning_run(
        db,
        learner_id=task.learner_id,
        goal=task.objective,
        source_text="",
        client_request_id=request_id,
        education_stage=education_stage,
        background=background,
        source="learning_task",
        attach_learning_task=False,
        learning_task_id=task.id,
    )
    if micro.learner_id != task.learner_id:
        raise RuntimeError("unsupported_scope")

    task.micro_learning_run_id = micro.id
    state = dict(task.execution_state or {})
    state["verification_handoff"] = {
        "micro_learning_run_id": micro.id,
        "project_id": micro.project_id,
        "checkpoint_id": micro.checkpoint_id,
        "session_id": micro.session_id,
        "status": "in_progress",
    }
    task.execution_state = state
    task.action_log = [
        *list(task.action_log or []),
        {
            "client_action_id": request_id,
            "action": "materialize",
            "at": datetime.utcnow().isoformat(),
            "micro_learning_run_id": micro.id,
        },
    ][-200:]
    task.version += 1
    await record_event(
        db,
        learner_id=task.learner_id,
        project_id=task.project_id,
        checkpoint_id=task.checkpoint_id,
        session_id=task.session_id,
        event_type="learning_task_materialized",
        source="learning_task",
        payload={
            "learning_task_id": task.id,
            "runtime_version": LEARNING_TASK_RUNTIME_VERSION,
            "micro_learning_run_id": micro.id,
            "source_mode": "topic",
            "verification_scope": state["verification_handoff"],
            "mastery_unchanged": True,
        },
        provenance={
            "learning_task_id": task.id,
            "skill_run_id": run.id,
            "decision_owner": "deterministic_skill_runtime",
        },
        artifact_refs=[{"type": "micro_learning_run", "id": micro.id}],
        client_event_id=f"learning-task:{task.id}:materialized:{request_id}",
    )
    return micro


async def act_on_learning_skill_run(
    db: AsyncSession,
    *,
    run: LearningSkillRun,
    action: str,
    expected_version: int,
    client_action_id: str,
    education_stage: str = "",
    background: str = "",
    calibration_patch: dict[str, Any] | None = None,
) -> tuple[LearningSkillRun, MicroLearningRun | None]:
    session = await db.get(AgentSession, run.session_id)
    if not session:
        raise RuntimeError("unsupported_scope")
    await validate_learning_skill_run_scope(db, session=session, run=run)
    history = list(run.action_log or [])
    action_key = f"action:{client_action_id}"
    if action_key in history:
        micro = await db.get(MicroLearningRun, run.micro_learning_run_id) if run.micro_learning_run_id else None
        return run, micro
    if run.version != expected_version:
        raise RuntimeError("version_conflict")
    micro: MicroLearningRun | None = None
    if action == "calibrate":
        if run.skill_id != "feynman_dialogue" or run.status not in {"active", "paused"}:
            raise RuntimeError("invalid_state")
        options = feynman_calibration_options()
        patch = {
            key: str(value)
            for key, value in dict(calibration_patch or {}).items()
            if key in options and str(value) in options[key]
        }
        if not patch:
            raise RuntimeError("invalid_state")
        data = dict(run.run_data or {})
        calibration = normalize_feynman_calibration({
            **dict(data.get("calibration") or {}),
            **patch,
        })
        run.run_data = {
            **data,
            "calibration": calibration,
            "flow_note": "费曼复述的难度、支架或表征已更新；流程位置没有改变。",
        }
        event_type = "learning_skill_calibration_updated"
        event_payload = {
            "calibration": calibration,
            "changed_fields": sorted(patch),
            "reason": "learner_control",
            "mastery_unchanged": True,
        }
    elif action == "pause" and run.status in {"active", "verification"}:
        resume_state = run.state
        run.status = "paused"
        run.state = "paused"
        run.run_data = {**dict(run.run_data or {}), "resume_state": resume_state, "paused_reason": "learner"}
        event_type = "learning_skill_run_paused"
        event_payload = {"resume_state": resume_state, "reason": "learner"}
    elif action == "resume" and run.status == "paused":
        resume_state = str((run.run_data or {}).get("resume_state") or WORKFLOWS[run.skill_id]["initial_state"])
        run.status = "verification" if run.micro_learning_run_id else "active"
        run.state = "verification_in_progress" if run.micro_learning_run_id else resume_state
        event_type = "learning_skill_run_resumed"
        event_payload = {"resume_state": run.state, "reason": "learner"}
    elif action == "start_verification" and run.status == "active" and run.state == "verification_ready":
        task = await _ensure_atomic_learning_task(
            db, session=session, run=run, source="user",
        )
        if task.status == "paused":
            await _advance_linked_task(
                db, run, action="resume", operation_id=f"verify-{client_action_id}",
            )
        await _advance_linked_task(
            db, run, action="complete_learn", operation_id="verification-handoff",
        )
        micro = await _materialize_skill_verification(
            db,
            task=task,
            run=run,
            client_action_id=client_action_id,
            education_stage=education_stage,
            background=background,
        )
        run.micro_learning_run_id = micro.id
        run.status = "verification"
        run.state = "verification_in_progress"
        run.run_data = {
            **dict(run.run_data or {}),
            "next_prompt": "独立验证已经创建。完成复述、题目与必要纠错后，本轮才会结束。",
        }
        event_type = "learning_skill_verification_started"
        event_payload = {"micro_learning_run_id": micro.id}
    else:
        raise RuntimeError("invalid_state")
    run.action_log = [*history, action_key][-80:]
    run.version += 1
    run.updated_at = datetime.utcnow()
    await _record_run_event(
        db, run, event_type,
        payload=event_payload,
        client_event_id=f"learning-skill-run:{run.id}:{action_key}",
        source="user",
    )
    if action == "pause":
        await _advance_linked_task(
            db, run, action="pause", operation_id=client_action_id,
        )
    elif action == "resume":
        await _advance_linked_task(
            db, run, action="resume", operation_id=client_action_id,
        )
    return run, micro
