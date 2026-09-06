"""Focused micro-learning orchestration for the stage-one learning loop.

The run is a resumable UI/workflow projection.  It deliberately reuses the
existing checkpoint, LearningAttempt, remediation, review, and evidence
contracts instead of creating a parallel mastery system.
"""

from __future__ import annotations

from datetime import datetime
import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.learning import (
    LearningAttempt, LearningTask, MicroLearningRun, RemediationCase, ReviewSchedule,
)
from app.models.project import (
    Checkpoint, ConceptQuestion, DomainKnowledgePacket, Lecture, LectureVersion, Project, Roadmap,
)
from app.services.learning_runtime import create_attempt, record_event
from app.services.model_latency import (
    InteractiveModelBudgetExceeded,
    invoke_with_budget,
)
from app.services.remediation import serialize_case
from app.services.topic_primers import deterministic_topic_primer
from app.services.tutor_service import get_or_create_session


WORKFLOW_VERSION = "verified-micro-learning-v1"
logger = logging.getLogger(__name__)
ACTIVE_STATES = {
    "learning_card", "teach_back", "teach_back_feedback",
    "verification", "remediation",
}

GENERATION_PROMPT = """你是 LearnFlow 的学习设计 Agent。请为一次 15 分钟微学习生成一张学习卡和 2-3 道形成性概念题。

学习目标：{goal}
学习者阶段：{education_stage}
学习者自述基础：{background}
材料模式：{source_mode}
材料：
{source_text}

要求：
1. 有材料时只依据材料；没有材料时使用稳定、基础的通识解释，不伪造来源。
2. 学习卡包含 3-5 个关键点、一个具体例子、一个常见混淆和可观察的成功标准。
3. target_concepts 只列 2-5 个短概念词，用于检查学生是否覆盖关键概念。
4. 每道题先写 learning_target 和 evidence_claim，再选择 single/multi/judge 响应形式。
5. 题目不能把答案写在题干里；选项 2-5 个，answer_indexes 必须有效。
6. 每题提供一个经过校验的变式契约，不能只交换选项顺序。
7. 只考查跨版本稳定、可由讲义直接支持的概念；禁止使用解释器私有属性、运行时魔改、
   版本特例、未定义/非标准行为或“某些实现可能如此”的争议细节出题。

只输出一个 JSON 对象：
{{
  "card": {{
    "title": "标题",
    "objective": "本次可观察目标",
    "key_points": ["关键点"],
    "target_concepts": ["概念词"],
    "example": "具体例子",
    "common_confusion": "常见混淆",
    "success_criteria": "学生结束时应该能做什么"
  }},
  "questions": [
    {{
      "q_type": "single",
      "difficulty": "easy",
      "learning_target": "细粒度目标",
      "evidence_claim": "回答如何支持判断",
      "question": "题干",
      "options": ["A", "B", "C"],
      "answer_indexes": [0],
      "explanation": "解析",
      "variant": {{
        "type": "concept_choice",
        "validated": true,
        "prompt": "换一个情境后的变式题",
        "options": ["A", "B", "C"],
        "answer_indexes": [1]
      }}
    }}
  ]
}}"""


def _clean(value: Any, limit: int = 2_000) -> str:
    return " ".join(str(value or "").split())[:limit]


def _sentences(source_text: str) -> list[str]:
    rows = [
        _clean(item, 360)
        for item in re.split(r"(?<=[。！？.!?])\s*|[\r\n]+", source_text)
    ]
    return [item for item in rows if len(item) >= 8]


def _fallback_artifact(goal: str, source_text: str) -> dict[str, Any]:
    primer = deterministic_topic_primer(goal)
    if primer:
        artifact, source_id = primer
        artifact["_generation_source"] = source_id
        return artifact
    source_rows = _sentences(source_text)
    if source_rows:
        points = source_rows[:4]
        example = source_rows[4] if len(source_rows) > 4 else source_rows[0]
        confusion = "不要只记住原句；需要能说明这些要点之间的关系，并在问题中辨认它们。"
    else:
        points = [
            f"先说明“{goal}”指的是什么，以及它不包含什么。",
            f"识别“{goal}”最关键的组成、条件或因果关系。",
            f"用一个具体情境说明“{goal}”如何发挥作用。",
        ]
        example = f"尝试从你熟悉的学习、生活或工作场景中，为“{goal}”找一个具体例子。"
        confusion = "看过解释或记住术语不等于理解；还需要独立复述并回答新问题。"

    target_concepts = [part for part in re.split(r"[、，,：:\s/]+", goal) if len(part) >= 2][:4]
    if not target_concepts:
        target_concepts = [goal[:24]]

    generic = [
        "能用自己的话说明关键关系，并在新情境中作出判断",
        "只要读过材料并记住标题即可",
        "只复述一个术语，不需要解释条件",
        "等待系统直接宣布已经掌握",
    ]
    first_options = [points[0], *[item for item in points[1:3]], "材料中的任何句子都同样重要"]
    first_options = list(dict.fromkeys(first_options))
    if len(first_options) < 2:
        first_options.append("只记住标题即可")
    return {
        "_generation_source": "provided_material_extract" if source_rows else "generic_goal_scaffold",
        "card": {
            "title": f"15 分钟弄懂：{goal}",
            "objective": f"能够用自己的话解释“{goal}”的关键关系，并完成独立验证。",
            "key_points": points,
            "target_concepts": target_concepts,
            "example": example,
            "common_confusion": confusion,
            "success_criteria": "完成一次独立复述和至少两道不泄露答案的概念验证。",
        },
        "questions": [
            {
                "q_type": "single",
                "difficulty": "easy",
                "learning_target": f"识别“{goal}”的首要关键点",
                "evidence_claim": "能够从相近陈述中选出材料实际支持的关键点",
                "question": "下面哪一项最符合本次材料首先要求理解的内容？",
                "options": first_options,
                "answer_indexes": [0],
                "explanation": f"材料首先强调：{points[0]}",
                "variant": {
                    "type": "concept_choice",
                    "validated": True,
                    "prompt": "换一个表达方式后，哪种学习结果最能说明你理解了这个关键点？",
                    "options": generic,
                    "answer_indexes": [0],
                },
            },
            {
                "q_type": "single",
                "difficulty": "medium",
                "learning_target": f"区分接触“{goal}”与可验证理解",
                "evidence_claim": "能够选择需要独立解释和应用的验证方式",
                "question": "以下哪种表现最能为本次理解提供有效证据？",
                "options": generic,
                "answer_indexes": [0],
                "explanation": "独立解释关键关系并在新情境中判断，比阅读或自我确认提供更强证据。",
                "variant": {
                    "type": "concept_choice",
                    "validated": True,
                    "prompt": "如果题目换了情境，哪一种表现仍然能支持理解判断？",
                    "options": [generic[2], generic[0], generic[1]],
                    "answer_indexes": [1],
                },
            },
        ],
    }


def _extract_json(content: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for index, character in enumerate(content):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(content[index:])
        except (ValueError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("micro-learning generation returned no JSON object")


def _valid_question(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    q_type = str(raw.get("q_type") or "single")
    if q_type not in {"single", "multi", "judge"}:
        return None
    question = _clean(raw.get("question"), 1_200)
    options = [_clean(item, 500) for item in list(raw.get("options") or [])]
    options = [item for item in options if item]
    answers = sorted({
        int(item) for item in list(raw.get("answer_indexes") or [])
        if str(item).lstrip("-").isdigit()
    })
    if not question or not 2 <= len(options) <= 5 or not answers:
        return None
    if any(index < 0 or index >= len(options) for index in answers):
        return None
    if q_type in {"single", "judge"} and len(answers) != 1:
        return None
    variant = dict(raw.get("variant") or {})
    variant_options = [_clean(item, 500) for item in list(variant.get("options") or [])]
    variant_answers = sorted({
        int(item) for item in list(variant.get("answer_indexes") or [])
        if str(item).lstrip("-").isdigit()
    })
    stability_text = " ".join([
        question, *options, _clean(raw.get("explanation"), 1_500),
        _clean(variant.get("prompt"), 1_200), *variant_options,
    ]).casefold()
    if any(marker in stability_text for marker in (
        "__closure__", "cell_contents", "sys.version", "cpython",
        "python 3.", "大多数python环境", "非标准的python", "未定义行为",
    )):
        return None
    valid_variant = (
        variant.get("type") == "concept_choice"
        and bool(variant.get("validated"))
        and bool(_clean(variant.get("prompt"), 1_200))
        and len(variant_options) >= 2
        and bool(variant_answers)
        and all(0 <= index < len(variant_options) for index in variant_answers)
    )
    if not valid_variant:
        return None
    return {
        "q_type": q_type,
        "difficulty": str(raw.get("difficulty") or "medium")
        if str(raw.get("difficulty") or "medium") in {"easy", "medium", "hard"}
        else "medium",
        "learning_target": _clean(raw.get("learning_target"), 500) or question,
        "evidence_claim": _clean(raw.get("evidence_claim"), 700)
        or "独立回答与评分规则一致",
        "question": question,
        "options": options,
        "answer_indexes": answers,
        "explanation": _clean(raw.get("explanation"), 1_500),
        "variant": {
            "type": "concept_choice",
            "validated": True,
            "prompt": _clean(variant.get("prompt"), 1_200),
            "options": variant_options,
            "answer_indexes": variant_answers,
        },
    }


def _validated_artifact(
    raw: dict[str, Any], goal: str, source_text: str,
) -> dict[str, Any]:
    fallback = _fallback_artifact(goal, source_text)
    raw_card = dict(raw.get("card") or {})
    key_points = [_clean(item, 500) for item in list(raw_card.get("key_points") or [])]
    key_points = [item for item in key_points if item][:5]
    if len(key_points) < 3:
        key_points = fallback["card"]["key_points"]
    concepts = [_clean(item, 80) for item in list(raw_card.get("target_concepts") or [])]
    concepts = list(dict.fromkeys(item for item in concepts if len(item) >= 2))[:5]
    card = {
        "title": _clean(raw_card.get("title"), 180) or fallback["card"]["title"],
        "objective": _clean(raw_card.get("objective"), 600) or fallback["card"]["objective"],
        "key_points": key_points,
        "target_concepts": concepts or fallback["card"]["target_concepts"],
        "example": _clean(raw_card.get("example"), 1_500) or fallback["card"]["example"],
        "common_confusion": _clean(raw_card.get("common_confusion"), 900)
        or fallback["card"]["common_confusion"],
        "success_criteria": _clean(raw_card.get("success_criteria"), 700)
        or fallback["card"]["success_criteria"],
    }
    questions = [
        question for question in (_valid_question(item) for item in list(raw.get("questions") or []))
        if question
    ][:3]
    for fallback_question in fallback["questions"]:
        if len(questions) >= 2:
            break
        questions.append(fallback_question)
    return {"card": card, "questions": questions}


async def generate_micro_learning_artifact(
    *, goal: str, source_text: str, education_stage: str, background: str,
) -> dict[str, Any]:
    fallback = _fallback_artifact(goal, source_text)
    fallback_source = fallback.pop("_generation_source", "generic_goal_scaffold")
    fallback["generation"] = {
        "mode": "deterministic_fallback",
        "reason": "model_not_configured",
        "source": fallback_source,
    }
    if not settings.llm_api_key or settings.llm_api_key in {
        "", "***", "sk-your-key-here",
    }:
        return fallback
    llm = ChatOpenAI(
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        temperature=0.35,
        timeout=max(1.0, settings.micro_learning_artifact_model_budget_seconds),
        max_retries=0,
        max_tokens=6_000,
        model_kwargs={"response_format": {"type": "json_object"}},
    )
    try:
        messages = [HumanMessage(content=GENERATION_PROMPT.format(
            goal=goal,
            education_stage=education_stage or "未说明",
            background=background or "未说明",
            source_mode="用户材料" if source_text else "主题生成",
            source_text=source_text[:14_000] if source_text else "（没有外部材料）",
        ))]
        response = await invoke_with_budget(
            lambda: llm.ainvoke(messages),
            settings.micro_learning_artifact_model_budget_seconds,
        )
        artifact = _validated_artifact(
            _extract_json(str(response.content)), goal, source_text,
        )
        artifact["generation"] = {"mode": "model_enhanced", "reason": ""}
        return artifact
    except Exception as error:
        reason = (
            "budget_exceeded"
            if isinstance(error, InteractiveModelBudgetExceeded)
            else "provider_or_validation_failure"
        )
        fallback["generation"] = {
            "mode": "deterministic_fallback",
            "reason": reason,
            "source": fallback_source,
        }
        logger.info(
            "micro-learning artifact used deterministic fallback: %s",
            type(error).__name__,
        )
        return fallback


def _lecture_sections(
    card: dict[str, Any], domain_packet: DomainKnowledgePacket | None = None,
) -> list[dict[str, Any]]:
    key_points = "\n".join(
        f"{index}. {point}" for index, point in enumerate(card.get("key_points") or [], start=1)
    )
    content = (
        f"## 本次目标\n\n{card.get('objective', '')}\n\n"
        f"## 关键点\n\n{key_points}\n\n"
        f"## 例子\n\n{card.get('example', '')}\n\n"
        f"## 容易混淆\n\n{card.get('common_confusion', '')}\n\n"
        f"## 完成标准\n\n{card.get('success_criteria', '')}"
    )
    citations = [] if not domain_packet else [
        dict(item) for item in list(domain_packet.source_version_refs or [])[:20]
    ]
    return [{
        "title": card.get("title") or "微学习卡",
        "content": content,
        "keywords": list(card.get("target_concepts") or []),
        "questions": [],
        "domain_knowledge_packet_id": domain_packet.id if domain_packet else None,
        "domain_knowledge_fingerprint": domain_packet.input_fingerprint if domain_packet else "",
        "source_refs": citations,
    }]


def _ground_artifact_in_packet(
    artifact: dict[str, Any], goal: str, packet: DomainKnowledgePacket,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Make the teachable content a deterministic projection of cited units."""
    units = dict(packet.knowledge_units or {})
    claims = [
        _clean(item.get("statement"), 700) for item in list(units.get("claims") or [])
        if isinstance(item, dict) and _clean(item.get("statement"), 700)
    ]
    relations = [
        _clean(item.get("statement"), 700) for item in list(units.get("relations") or [])
        if isinstance(item, dict) and _clean(item.get("statement"), 700)
    ]
    examples = [
        _clean(item.get("statement"), 1400) for item in list(units.get("examples") or [])
        if isinstance(item, dict) and _clean(item.get("statement"), 1400)
    ]
    misconceptions = [
        _clean(item.get("statement"), 1000) for item in list(units.get("misconceptions") or [])
        if isinstance(item, dict) and _clean(item.get("statement"), 1000)
    ]
    concepts = [
        _clean(item.get("label"), 80) for item in list(units.get("concepts") or [])
        if isinstance(item, dict) and _clean(item.get("label"), 80)
    ]
    card = dict(artifact.get("card") or {})
    supported_points = list(dict.fromkeys([*relations, *claims]))[:5]
    if len(supported_points) >= 3:
        card["key_points"] = supported_points
    if examples:
        card["example"] = examples[0]
    if misconceptions:
        card["common_confusion"] = misconceptions[0]
    if concepts:
        card["target_concepts"] = concepts[:5]
    card["title"] = _clean(card.get("title"), 180) or f"15 分钟弄懂：{packet.subject_key}"
    card["objective"] = f"能够解释“{packet.subject_key or goal}”的机制与边界，并在新情境中独立判断。"
    card["success_criteria"] = "独立复述核心因果、完成一个完整例子，并通过不泄露答案的变式验证。"
    # A model-free generic shell may supply the JSON shape, but once a ready
    # Packet exists both the teaching text and assessment targets must be
    # rebuilt from cited claims.  This prevents the old command-shaped
    # scaffold from leaking into a published lecture or practice set.
    assessment_claims = list(dict.fromkeys([*relations, *claims]))[:3]
    if len(assessment_claims) >= 2:
        first, second = assessment_claims[:2]
        artifact["questions"] = [
            {
                "q_type": "single",
                "difficulty": "easy",
                "learning_target": concepts[0] if concepts else packet.subject_key,
                "evidence_claim": first,
                "question": "根据本次讲义，下面哪一项是来源直接支持的关键结论？",
                "options": [
                    first,
                    "只要记住主题名称，就等同于理解了其中的机制。",
                    "这个结论在任何条件和边界下都不会改变。",
                    "无需阅读来源或完成例子，也可以直接宣布掌握。",
                ],
                "answer_indexes": [0],
                "explanation": first,
                "variant": {
                    "type": "concept_choice",
                    "validated": True,
                    "prompt": "换一个情境后，哪项关系仍与讲义中的机制一致？",
                    "options": [second, "只有原句的措辞可以作为判断依据。", "条件变化不会影响结论。"],
                    "answer_indexes": [0],
                },
            },
            {
                "q_type": "single",
                "difficulty": "medium",
                "learning_target": concepts[1] if len(concepts) > 1 else packet.subject_key,
                "evidence_claim": second,
                "question": "哪一项最准确地补全了讲义中的机制或条件关系？",
                "options": [
                    second,
                    "它只是一个术语定义，与条件、因果和例子都无关。",
                    "出现一个反例也不会改变它的适用范围。",
                    "模型生成过答案本身就是独立验证证据。",
                ],
                "answer_indexes": [0],
                "explanation": second,
                "variant": {
                    "type": "concept_choice",
                    "validated": True,
                    "prompt": "如果适用条件发生变化，应该如何判断？",
                    "options": ["重新检查讲义给出的边界与机制。", "仍机械套用原结论。", "只比较关键词是否相同。"],
                    "answer_indexes": [0],
                },
            },
        ]
    artifact = {
        **artifact,
        "card": card,
        "generation": {
            "mode": "packet_grounded",
            "reason": "compiled_from_cited_domain_knowledge",
            "source": f"domain_knowledge_packet:{packet.id}",
        },
    }
    brief = {
        "schema_version": "learnflow.teaching-content-brief.v1",
        "domain_knowledge_packet_id": packet.id,
        "domain_knowledge_fingerprint": packet.input_fingerprint,
        "subject": packet.subject_key,
        "objective": card["objective"],
        "taught_claims": supported_points,
        "example": card.get("example", ""),
        "misconception": card.get("common_confusion", ""),
        "assessment_targets": list(card.get("target_concepts") or []),
        "source_version_refs": list(packet.source_version_refs or [])[:20],
    }
    return artifact, brief


async def create_micro_learning_run(
    db: AsyncSession,
    *,
    learner_id: int,
    goal: str,
    source_text: str,
    client_request_id: str,
    education_stage: str = "",
    background: str = "",
    source: str = "ui",
    attach_learning_task: bool = True,
    learning_task_id: int | None = None,
    domain_packet: DomainKnowledgePacket | None = None,
) -> MicroLearningRun:
    existing = (await db.execute(select(MicroLearningRun).where(
        MicroLearningRun.learner_id == learner_id,
        MicroLearningRun.client_request_id == client_request_id,
    ))).scalar_one_or_none()
    if existing:
        if attach_learning_task:
            from app.services.learning_tasks import attach_micro_learning_task
            await attach_micro_learning_task(db, run=existing)
        return existing

    if domain_packet is None:
        from app.services.domain_knowledge import compile_domain_knowledge_packet
        domain_packet = await compile_domain_knowledge_packet(
            db, learner_id=learner_id, query=goal, kind="teaching_artifact",
            learning_task_id=learning_task_id,
        )
    if domain_packet.learner_id != learner_id or domain_packet.status not in {"ready", "ready_with_gaps"}:
        raise RuntimeError("domain_knowledge_blocked")
    artifact = await generate_micro_learning_artifact(
        goal=goal, source_text=source_text,
        education_stage=education_stage, background=background,
    )
    artifact, teaching_content_brief = _ground_artifact_in_packet(
        artifact, goal, domain_packet,
    )
    card = artifact["card"]
    project = Project(
        learner_id=learner_id,
        name=f"快速学习 · {goal[:48]}",
        description="由可验证微学习工作流创建的单关卡学习空间。",
        user_level="beginner",
        project_kind="task_artifact",
        visibility="internal",
    )
    db.add(project)
    await db.flush()
    roadmap = Roadmap(
        project_id=project.id,
        raw_json={
            "mode": "verified_micro_learning",
            "workflow_version": WORKFLOW_VERSION,
            "goal": goal,
        },
    )
    db.add(roadmap)
    await db.flush()
    from app.services.teaching_contract import normalize_teaching_contract
    teaching_contract = normalize_teaching_contract({
        "version": WORKFLOW_VERSION,
        "objective": card["objective"],
        "outcomes": [card["success_criteria"]],
        "must_preserve": list(card.get("key_points") or [])[:8],
        "source_refs": [
            {"type": "source_version", "id": item.get("source_version_id")}
            for item in list(domain_packet.source_version_refs or [])
            if item.get("source_version_id")
        ],
        "knowledge_input_contract": {
            "domain_packet": {
                "id": domain_packet.id,
                "status": domain_packet.status,
                "input_fingerprint": domain_packet.input_fingerprint,
                "coverage": domain_packet.coverage,
                "source_version_refs": domain_packet.source_version_refs,
                "unresolved_gaps": domain_packet.unresolved_gaps,
            },
        },
        "completion": "workflow completion is not stable mastery",
        "verification": "independent graded concept attempts plus remediation when needed",
    }, objective=card["objective"])
    if teaching_contract["teaching_gate"]["status"] == "blocked_knowledge":
        raise RuntimeError("domain_knowledge_blocked")
    checkpoint = Checkpoint(
        roadmap_id=roadmap.id,
        title=card["title"],
        description=card["objective"],
        order=1,
        learning_status="in_progress",
        brief={
            "goal": goal,
            "mode": "verified_micro_learning",
            "source_type": "provided_text" if source_text else "topic",
            "teaching_content_brief": teaching_content_brief,
        },
        learning_contract=teaching_contract,
    )
    db.add(checkpoint)
    await db.flush()
    db.add(Lecture(
        checkpoint_id=checkpoint.id,
        sections=_lecture_sections(card, domain_packet),
        status="published",
        version=1,
    ))
    await db.flush()

    question_ids: list[int] = []
    for order, question in enumerate(artifact["questions"], start=1):
        row = ConceptQuestion(
            checkpoint_id=checkpoint.id,
            question=question["question"],
            options=question["options"],
            answer_indexes=question["answer_indexes"],
            q_type=question["q_type"],
            difficulty=question["difficulty"],
            explanation=question["explanation"],
            source_chunk_ids=[],
            assessment_meta={
                "mode": "verified_micro_learning",
                "learning_target": question["learning_target"],
                "evidence_claim": question["evidence_claim"],
                "targets": list(card.get("target_concepts") or []),
                "variant": question["variant"],
                "domain_knowledge_packet_id": domain_packet.id,
                "domain_knowledge_fingerprint": domain_packet.input_fingerprint,
                "source_refs": list(domain_packet.source_version_refs or [])[:20],
                "teaching_content_brief": teaching_content_brief,
            },
            order=order,
        )
        db.add(row)
        await db.flush()
        question_ids.append(row.id)

    session = await get_or_create_session(
        db,
        learner_id=learner_id,
        session_type="checkpoint",
        project_id=project.id,
        checkpoint_id=checkpoint.id,
    )
    run = MicroLearningRun(
        learner_id=learner_id,
        project_id=project.id,
        checkpoint_id=checkpoint.id,
        session_id=session.id,
        goal=goal,
        source_text=source_text,
        source_type="provided_text" if source_text else "topic",
        status="active",
        state="learning_card",
        skill_plan={
            "id": "verified_micro_learning",
            "version": WORKFLOW_VERSION,
            "estimated_minutes": 15,
            "steps": ["learning_card", "feynman_teach_back", "retrieval_practice", "spaced_review"],
            "learning_task_id": learning_task_id,
        },
        learning_card={
            **card,
            "source_mode": "provided_text" if source_text else "topic",
            "generation_mode": (artifact.get("generation") or {}).get("mode", "unknown"),
            "generation_reason": (artifact.get("generation") or {}).get("reason", ""),
            "generation_source": (artifact.get("generation") or {}).get("source", "model"),
        },
        teach_back={},
        verification={
            "question_ids": question_ids,
            "completed_question_ids": [],
            "results": {},
            "current_question_id": question_ids[0] if question_ids else None,
        },
        summary={},
        action_log=[],
        client_request_id=client_request_id,
        version=1,
    )
    db.add(run)
    await db.flush()

    await record_event(
        db, learner_id=learner_id, project_id=project.id,
        checkpoint_id=checkpoint.id, session_id=session.id,
        event_type="micro_learning_started", source=source,
        payload={
            "run_id": run.id,
            "goal": goal,
            "workflow_version": WORKFLOW_VERSION,
            "learning_task_id": learning_task_id,
        },
        client_event_id=f"micro-learning:{run.id}:started",
    )
    await record_event(
        db, learner_id=learner_id, project_id=project.id,
        checkpoint_id=checkpoint.id, session_id=session.id,
        event_type="checkpoint_entered", source="micro_learning",
        payload={
            "run_id": run.id,
            "title": checkpoint.title,
            "mode": "verified_micro_learning",
            "learning_task_id": learning_task_id,
        },
        client_event_id=f"micro-learning:{run.id}:checkpoint-entered",
    )
    await record_event(
        db, learner_id=learner_id, project_id=project.id,
        checkpoint_id=checkpoint.id, session_id=session.id,
        event_type="learning_card_generated", source="learning_design",
        payload={
            "run_id": run.id,
            "question_ids": question_ids,
            "learning_task_id": learning_task_id,
        },
        client_event_id=f"micro-learning:{run.id}:card-generated",
    )
    if attach_learning_task:
        from app.services.learning_tasks import attach_micro_learning_task
        await attach_micro_learning_task(db, run=run)
    return run


async def load_owned_run(
    db: AsyncSession, learner_id: int, run_id: int,
) -> MicroLearningRun | None:
    return (await db.execute(select(MicroLearningRun).where(
        MicroLearningRun.id == run_id,
        MicroLearningRun.learner_id == learner_id,
    ))).scalar_one_or_none()


def _learning_task_id(run: MicroLearningRun) -> int | None:
    value = (run.skill_plan or {}).get("learning_task_id")
    return int(value) if str(value or "").isdigit() else None


def _bigrams(value: str) -> set[str]:
    compact = "".join(character.casefold() for character in value if character.isalnum() or "\u4e00" <= character <= "\u9fff")
    if len(compact) < 2:
        return {compact} if compact else set()
    return {compact[index:index + 2] for index in range(len(compact) - 1)}


def analyze_teach_back(response: str, card: dict[str, Any]) -> dict[str, Any]:
    reference_rows = list(card.get("key_points") or [])
    covered: list[str] = []
    missing: list[str] = []
    response_pairs = _bigrams(response)
    target_pairs: set[str] = set()
    for concept in list(card.get("target_concepts") or []):
        target_pairs.update(_bigrams(str(concept)))
    for point in reference_rows:
        point_pairs = _bigrams(str(point))
        # Repeating the topic name must not make every templated point appear
        # covered.  Score the point-specific relationship after removing the
        # shared target-concept fragments.
        diagnostic_pairs = point_pairs - target_pairs
        overlap = len(response_pairs & diagnostic_pairs) / max(1, len(diagnostic_pairs))
        (covered if overlap >= 0.16 else missing).append(str(point))
    ratio = round(len(covered) / max(1, len(reference_rows)), 3)
    focus = missing[0] if missing else str(card.get("common_confusion") or reference_rows[-1])
    return {
        "analysis_role": "diagnostic_only",
        "mastery_unchanged": True,
        "coverage_ratio": ratio,
        "covered_points": covered,
        "missing_points": missing,
        "status": "ready_for_verification" if ratio >= 0.6 else "needs_clarification",
        "diagnostic_question": f"不看学习卡，你能再说明这一点为什么成立、在什么条件下成立吗？——{focus}",
    }


async def submit_teach_back(
    db: AsyncSession,
    *,
    run: MicroLearningRun,
    response: str,
    expected_version: int,
    client_submission_id: str,
) -> MicroLearningRun:
    submission_key = f"teach-back:{run.learner_id}:{run.id}:{client_submission_id}"
    existing = (await db.execute(select(LearningAttempt).where(
        LearningAttempt.learner_id == run.learner_id,
        LearningAttempt.client_submission_id == submission_key,
    ))).scalar_one_or_none()
    if existing:
        return run
    if run.version != expected_version:
        raise RuntimeError("version_conflict")
    if run.status != "active" or run.state != "teach_back":
        raise RuntimeError("invalid_state")

    analysis = analyze_teach_back(response, dict(run.learning_card or {}))
    attempt = await create_attempt(
        db,
        learner_id=run.learner_id,
        checkpoint_id=run.checkpoint_id,
        item_type="teach_back",
        item_id=run.id,
        submission={"response": response},
        result=analysis,
        assistance_level="none",
        attempt_role="diagnostic",
        client_submission_id=submission_key,
    )
    event = await record_event(
        db, learner_id=run.learner_id, project_id=run.project_id,
        checkpoint_id=run.checkpoint_id, session_id=run.session_id,
        event_type="teach_back_analyzed", source="assessment",
        payload={
            "run_id": run.id,
            "learning_task_id": _learning_task_id(run),
            "attempt_id": attempt.id,
            "coverage_ratio": analysis["coverage_ratio"],
            "covered_points": analysis["covered_points"],
            "missing_points": analysis["missing_points"],
            "mastery_unchanged": True,
        },
        provenance={"analyzer": "deterministic_concept_coverage_v1", "decision_role": "diagnosis_only"},
        client_event_id=f"teach-back:{run.id}:attempt:{attempt.id}:analyzed",
    )
    run.teach_back = {
        "attempt_id": attempt.id,
        "evidence_event_id": event.id,
        "response": response,
        **analysis,
    }
    run.state = "teach_back_feedback"
    run.version += 1
    run.updated_at = datetime.utcnow()
    return run


def _remember_action(run: MicroLearningRun, action_id: str) -> bool:
    history = list(run.action_log or [])
    if action_id in history:
        return False
    run.action_log = [*history, action_id][-60:]
    return True


def learning_card_quality_status(card: dict[str, Any]) -> str:
    """Block generic scaffolds from entering the evidence-bearing workflow."""
    generation_mode = str(card.get("generation_mode") or "unknown")
    generation_source = str(card.get("generation_source") or "")
    if (
        generation_mode == "deterministic_fallback"
        and generation_source == "generic_goal_scaffold"
    ):
        return "blocked"
    return "ready"


async def regenerate_learning_artifact(
    db: AsyncSession,
    *,
    run: MicroLearningRun,
    expected_version: int,
    client_request_id: str,
    education_stage: str = "",
    background: str = "",
) -> MicroLearningRun:
    """Replace a not-yet-used learning card without changing task identity.

    Regeneration is intentionally frozen after the learner leaves the card or
    submits any question.  That preserves the exact content behind subsequent
    evidence while still letting old or degraded cards be repaired in place.
    """
    action_key = f"regenerate:{client_request_id}"
    if action_key in list(run.action_log or []):
        return run
    if run.version != expected_version:
        raise RuntimeError("version_conflict")
    if run.status != "active" or run.state != "learning_card":
        raise RuntimeError("invalid_state")

    old_question_ids = [
        int(item) for item in (run.verification or {}).get("question_ids") or []
    ]
    attempt_count = int((await db.execute(select(func.count(LearningAttempt.id)).where(
        LearningAttempt.learner_id == run.learner_id,
        LearningAttempt.checkpoint_id == run.checkpoint_id,
        LearningAttempt.item_type == "concept",
        LearningAttempt.item_id.in_(old_question_ids),
    ))).scalar_one()) if old_question_ids else 0
    if attempt_count:
        raise RuntimeError("invalid_state")

    artifact = await generate_micro_learning_artifact(
        goal=run.goal,
        source_text=run.source_text or "",
        education_stage=education_stage,
        background=background,
    )
    card = dict(artifact["card"])
    generation = dict(artifact.get("generation") or {})
    run.learning_card = {
        **card,
        "source_mode": run.source_type,
        "generation_mode": generation.get("mode", "unknown"),
        "generation_reason": generation.get("reason", ""),
        "generation_source": generation.get("source", "model"),
    }

    checkpoint = await db.get(Checkpoint, run.checkpoint_id)
    domain_packet = None
    if checkpoint:
        checkpoint.title = _clean(card.get("title"), 255)
        checkpoint.description = _clean(card.get("objective"), 2_000)
        packet_id = int(dict(
            dict(checkpoint.learning_contract or {}).get("knowledge_input_contract") or {}
        ).get("domain_packet", {}).get("id") or 0)
        domain_packet = await db.get(DomainKnowledgePacket, packet_id) if packet_id else None
        if domain_packet and domain_packet.status in {"ready", "ready_with_gaps"}:
            artifact, teaching_content_brief = _ground_artifact_in_packet(
                artifact, run.goal, domain_packet,
            )
            card = artifact["card"]
            checkpoint.brief = {
                **dict(checkpoint.brief or {}),
                "teaching_content_brief": teaching_content_brief,
            }
    lecture = (await db.execute(select(Lecture).where(
        Lecture.checkpoint_id == run.checkpoint_id,
    ))).scalar_one_or_none()
    if lecture:
        db.add(LectureVersion(
            checkpoint_id=run.checkpoint_id,
            sections=list(lecture.sections or []),
            source_version=int(lecture.version or 1),
            reason="micro_learning_regenerate_before",
            idempotency_key=f"micro-learning:{run.id}:regenerate:{client_request_id}",
        ))
        lecture.sections = _lecture_sections(card, domain_packet)
        lecture.status = "published"
        lecture.version = int(lecture.version or 1) + 1
    else:
        db.add(Lecture(
            checkpoint_id=run.checkpoint_id,
            sections=_lecture_sections(card, domain_packet),
            status="published",
            version=1,
        ))

    existing_questions = list((await db.execute(select(ConceptQuestion).where(
        ConceptQuestion.checkpoint_id == run.checkpoint_id,
        ConceptQuestion.id.in_(old_question_ids),
    ).order_by(ConceptQuestion.order, ConceptQuestion.id))).scalars().all()) if old_question_ids else []
    question_ids: list[int] = []
    for order, question in enumerate(artifact["questions"], start=1):
        row = existing_questions[order - 1] if order <= len(existing_questions) else ConceptQuestion(
            checkpoint_id=run.checkpoint_id,
        )
        row.question = question["question"]
        row.options = question["options"]
        row.answer_indexes = question["answer_indexes"]
        row.q_type = question["q_type"]
        row.difficulty = question["difficulty"]
        row.explanation = question["explanation"]
        row.source_chunk_ids = []
        row.assessment_meta = {
            "mode": "verified_micro_learning",
            "learning_target": question["learning_target"],
            "evidence_claim": question["evidence_claim"],
            "targets": list(card.get("target_concepts") or []),
            "variant": question["variant"],
            **({
                "domain_knowledge_packet_id": domain_packet.id,
                "domain_knowledge_fingerprint": domain_packet.input_fingerprint,
                "source_refs": list(domain_packet.source_version_refs or [])[:20],
            } if domain_packet else {}),
        }
        row.order = order
        if row.id is None:
            db.add(row)
            await db.flush()
        question_ids.append(row.id)

    run.verification = {
        "question_ids": question_ids,
        "completed_question_ids": [],
        "results": {},
        "current_question_id": question_ids[0] if question_ids else None,
    }
    run.action_log = [*list(run.action_log or []), action_key][-60:]
    run.version += 1
    run.updated_at = datetime.utcnow()
    await record_event(
        db,
        learner_id=run.learner_id,
        project_id=run.project_id,
        checkpoint_id=run.checkpoint_id,
        session_id=run.session_id,
        event_type="learning_card_generated",
        source="learning_design",
        payload={
            "run_id": run.id,
            "question_ids": question_ids,
            "learning_task_id": _learning_task_id(run),
            "regenerated": True,
            "generation_source": generation.get("source", "model"),
        },
        client_event_id=f"micro-learning:{run.id}:regenerated:{client_request_id}",
    )
    return run


async def advance_run(
    db: AsyncSession,
    *,
    run: MicroLearningRun,
    action: str,
    expected_version: int,
    client_action_id: str,
) -> MicroLearningRun:
    if client_action_id in list(run.action_log or []):
        return run
    if run.version != expected_version:
        raise RuntimeError("version_conflict")
    if (
        action == "complete_card"
        and learning_card_quality_status(dict(run.learning_card or {})) == "blocked"
    ):
        raise RuntimeError("quality_gate")
    if not _remember_action(run, client_action_id):
        return run

    event_type: str | None = None
    if action == "complete_card" and run.status == "active" and run.state == "learning_card":
        run.state = "teach_back"
        event_type = "micro_learning_card_viewed"
    elif action == "continue_after_feedback" and run.status == "active" and run.state == "teach_back_feedback":
        run.state = "verification"
    elif action == "pause" and run.status == "active" and run.state in ACTIVE_STATES:
        skill_plan = dict(run.skill_plan or {})
        skill_plan["resume_state"] = run.state
        run.skill_plan = skill_plan
        run.status = "paused"
        run.state = "paused"
        event_type = "micro_learning_paused"
    elif action == "resume" and run.status == "paused" and run.state == "paused":
        run.status = "active"
        run.state = str((run.skill_plan or {}).get("resume_state") or "learning_card")
        event_type = "micro_learning_resumed"
    else:
        raise RuntimeError("invalid_state")

    run.version += 1
    run.updated_at = datetime.utcnow()
    if event_type:
        event_payload = {
            "run_id": run.id,
            "learning_task_id": _learning_task_id(run),
            "state": run.state,
        }
        if event_type == "micro_learning_card_viewed":
            event_payload["concepts"] = list(
                (run.learning_card or {}).get("target_concepts") or []
            )
        await record_event(
            db, learner_id=run.learner_id, project_id=run.project_id,
            checkpoint_id=run.checkpoint_id, session_id=run.session_id,
            event_type=event_type, source="ui",
            payload=event_payload,
            client_event_id=f"micro-learning:{run.id}:action:{client_action_id}",
        )
    return run


async def reconcile_run(
    db: AsyncSession, run: MicroLearningRun,
) -> MicroLearningRun:
    if run.state not in {"verification", "remediation", "completed"}:
        return run
    question_ids = [int(item) for item in (run.verification or {}).get("question_ids") or []]
    attempts = list((await db.execute(select(LearningAttempt).where(
        LearningAttempt.learner_id == run.learner_id,
        LearningAttempt.checkpoint_id == run.checkpoint_id,
        LearningAttempt.item_type == "concept",
        LearningAttempt.item_id.in_(question_ids),
    ).order_by(LearningAttempt.id.asc()))).scalars().all()) if question_ids else []
    cases = list((await db.execute(select(RemediationCase).where(
        RemediationCase.learner_id == run.learner_id,
        RemediationCase.checkpoint_id == run.checkpoint_id,
        RemediationCase.item_type == "concept",
        RemediationCase.item_id.in_(question_ids),
    ).order_by(RemediationCase.id.asc()))).scalars().all()) if question_ids else []
    attempts_by_item: dict[int, list[LearningAttempt]] = {}
    cases_by_item: dict[int, list[RemediationCase]] = {}
    for attempt in attempts:
        attempts_by_item.setdefault(int(attempt.item_id), []).append(attempt)
    for remediation in cases:
        cases_by_item.setdefault(int(remediation.item_id), []).append(remediation)

    completed: list[int] = []
    results: dict[str, Any] = {}
    current_question_id: int | None = None
    active_remediation: RemediationCase | None = None
    for question_id in question_ids:
        question_attempts = attempts_by_item.get(question_id, [])
        latest_attempt = question_attempts[-1] if question_attempts else None
        latest_case = cases_by_item.get(question_id, [])[-1] if cases_by_item.get(question_id) else None
        if latest_case and latest_case.status == "completed":
            completed.append(question_id)
            results[str(question_id)] = {
                "status": "remediated",
                "attempt_id": latest_case.retry_attempt_id,
                "remediation_case_id": latest_case.id,
                "variant_attempt_id": latest_case.variant_attempt_id,
            }
            continue
        if latest_case:
            current_question_id = question_id
            active_remediation = latest_case
            results[str(question_id)] = {
                "status": "remediation",
                "attempt_id": latest_attempt.id if latest_attempt else None,
                "remediation_case_id": latest_case.id,
            }
            break
        if latest_attempt and bool((latest_attempt.result or {}).get("correct")):
            completed.append(question_id)
            results[str(question_id)] = {
                "status": "verified_once",
                "attempt_id": latest_attempt.id,
                "assistance_level": latest_attempt.assistance_level,
            }
            continue
        current_question_id = question_id
        break

    previous = dict(run.verification or {})
    verification = {
        **previous,
        "question_ids": question_ids,
        "completed_question_ids": completed,
        "results": results,
        "current_question_id": current_question_id,
        "active_remediation_case_id": active_remediation.id if active_remediation else None,
    }
    state = "remediation" if active_remediation else "verification"
    status = run.status
    summary = dict(run.summary or {})
    completed_at = run.completed_at
    if question_ids and len(completed) == len(question_ids):
        schedules = list((await db.execute(select(ReviewSchedule).where(
            ReviewSchedule.learner_id == run.learner_id,
            ReviewSchedule.item_type == "concept",
            ReviewSchedule.item_id.in_(question_ids),
        ).order_by(ReviewSchedule.due_at.asc()))).scalars().all())
        independent = [
            question_id for question_id in question_ids
            if results.get(str(question_id), {}).get("status") == "verified_once"
            and results.get(str(question_id), {}).get("assistance_level") == "none"
        ]
        remediated = [
            question_id for question_id in question_ids
            if results.get(str(question_id), {}).get("status") == "remediated"
        ]
        summary = {
            "outcome": "learning_loop_completed",
            "mastery_claim": "not_stable_yet",
            "independently_verified_question_ids": independent,
            "remediated_question_ids": remediated,
            "review_schedule_ids": [item.id for item in schedules],
            "review_due_at": schedules[0].due_at.isoformat() if schedules else None,
            "next_step": "按计划完成间隔复习，稳定掌握需要跨时间的独立与变式证据。",
        }
        state = "completed"
        status = "completed"
        current_question_id = None
        verification["current_question_id"] = None
        completed_at = run.completed_at or datetime.utcnow()

    changed = (
        verification != dict(run.verification or {})
        or state != run.state
        or status != run.status
        or summary != dict(run.summary or {})
    )
    if not changed:
        return run
    was_completed = run.status == "completed"
    run.verification = verification
    run.state = state
    run.status = status
    run.summary = summary
    run.completed_at = completed_at
    run.version += 1
    run.updated_at = datetime.utcnow()
    if status == "completed" and not was_completed:
        await record_event(
            db, learner_id=run.learner_id, project_id=run.project_id,
            checkpoint_id=run.checkpoint_id, session_id=run.session_id,
            event_type="micro_learning_completed", source="runtime",
            payload={
                "run_id": run.id,
                "learning_task_id": _learning_task_id(run),
                "question_ids": question_ids,
                "independently_verified_question_ids": summary["independently_verified_question_ids"],
                "remediated_question_ids": summary["remediated_question_ids"],
                "mastery_claim": "not_stable_yet",
            },
            client_event_id=f"micro-learning:{run.id}:completed",
        )
    return run


async def sync_run(
    db: AsyncSession,
    *,
    run: MicroLearningRun,
    expected_version: int | None,
    client_action_id: str,
) -> MicroLearningRun:
    """Idempotently project authoritative attempts/remediation into the run."""
    if client_action_id in list(run.action_log or []):
        return run
    if expected_version is not None and run.version != expected_version:
        raise RuntimeError("version_conflict")
    _remember_action(run, client_action_id)
    version_before_reconcile = run.version
    await reconcile_run(db, run)
    if run.version == version_before_reconcile:
        run.version += 1
        run.updated_at = datetime.utcnow()
    return run


def _public_question(question: ConceptQuestion | None) -> dict[str, Any] | None:
    if not question:
        return None
    meta = dict(question.assessment_meta or {})
    return {
        "id": question.id,
        "question": question.question,
        "options": list(question.options or []),
        "q_type": question.q_type,
        "difficulty": question.difficulty,
        "order": question.order,
        "learning_target": meta.get("learning_target", ""),
        "evidence_claim": meta.get("evidence_claim", ""),
    }


async def run_view(db: AsyncSession, run: MicroLearningRun) -> dict[str, Any]:
    learning_card = dict(run.learning_card or {})
    learning_card["quality_status"] = learning_card_quality_status(learning_card)
    question_ids = [int(item) for item in (run.verification or {}).get("question_ids") or []]
    questions = list((await db.execute(select(ConceptQuestion).where(
        ConceptQuestion.id.in_(question_ids),
        ConceptQuestion.checkpoint_id == run.checkpoint_id,
    ).order_by(ConceptQuestion.order.asc()))).scalars().all()) if question_ids else []
    question_map = {item.id: item for item in questions}
    current_question_id = (run.verification or {}).get("current_question_id")
    remediation = None
    case_id = (run.verification or {}).get("active_remediation_case_id")
    if case_id:
        owned = (await db.execute(select(RemediationCase).where(
            RemediationCase.id == int(case_id),
            RemediationCase.learner_id == run.learner_id,
        ))).scalar_one_or_none()
        remediation = serialize_case(owned) if owned else None
    step_order = {
        "learning_card": 1,
        "teach_back": 2,
        "teach_back_feedback": 3,
        "verification": 4,
        "remediation": 4,
        "completed": 5,
        "paused": 0,
    }
    task = (await db.execute(select(LearningTask).where(
        LearningTask.learner_id == run.learner_id,
        LearningTask.micro_learning_run_id == run.id,
    ))).scalar_one_or_none()
    if task:
        from app.services.learning_tasks import (
            task_execution_navigation,
            task_management_navigation,
            task_origin_navigation,
        )
    return {
        "id": run.id,
        "goal": run.goal,
        "source_type": run.source_type,
        "source_excerpt": _clean(run.source_text, 600),
        "status": run.status,
        "state": run.state,
        "version": run.version,
        "project_id": run.project_id,
        "checkpoint_id": run.checkpoint_id,
        "session_id": run.session_id,
        "skill_plan": dict(run.skill_plan or {}),
        "learning_card": learning_card,
        "teach_back": dict(run.teach_back or {}),
        "verification": dict(run.verification or {}),
        "summary": dict(run.summary or {}),
        "questions": [_public_question(question_map.get(question_id)) for question_id in question_ids],
        "current_question": _public_question(question_map.get(int(current_question_id)))
        if current_question_id else None,
        "remediation": remediation,
        "progress": {
            "current": step_order.get(run.state, 0),
            "total": 5,
            "completed_questions": len((run.verification or {}).get("completed_question_ids") or []),
            "total_questions": len(question_ids),
        },
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
        "learning_task": ({
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "current_phase_id": task.current_phase_id,
            # ``path`` remains the task-management path for older clients.
            "path": task_management_navigation(task)["path"],
            "navigation": task_execution_navigation(task),
            "origin_navigation": task_origin_navigation(task),
            "management_navigation": task_management_navigation(task),
            "artifact_refs": list(task.artifact_refs or []),
        } if task else None),
    }
