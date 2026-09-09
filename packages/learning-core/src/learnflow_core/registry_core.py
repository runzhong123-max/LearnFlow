"""Shared architecture declarations; host registries compose local bindings."""
from __future__ import annotations
from dataclasses import dataclass

SHARED_CORE_VERSION = "0.2.5"
CONCEPT_EVIDENCE_POLICY_VERSION = "concept-evidence.v2"
PLANNING_GUIDANCE_POLICY_VERSION = "learning-plan-guidance.v2"
MEMORY_RETRIEVAL_VERSION = "relevance-budget.v3"

EVENT_SCHEMA_VERSION = "learnflow.evidence.v1"


SKILL_SPEC_VERSION = "learnflow.skill.v3"


FRONTEND_SKILL_MANIFEST_REGISTRY_VERSION = "2026-09-07.4"


KERNEL_NAMES = ("structure", "knowledge", "human", "value", "practice")

# These are learner policies, not source-data import contracts or new tools.
EDUCATION_MEMORY_POLICIES = {
    "ordinary_concept": {
        "version": CONCEPT_EVIDENCE_POLICY_VERSION, "owner": "practice_agent",
        "event": "concept_attempt_evaluated", "ordinary_success_is_stable": False,
        "stable_review_policy": "review-policy-v1", "historical_backfill": False,
        "write_path": "EvidenceEvent -> reducer -> KernelMutation -> KernelState",
    },
    "planning_guidance": {
        "version": PLANNING_GUIDANCE_POLICY_VERSION, "owner": "learning_design_agent",
        "tool": "learning_task_planner", "kernel_reads": KERNEL_NAMES,
        "kernel_write_path": "none", "enforce_after_model": True, "decision_trace_is_evidence": False,
        "authority_path": "docs/implementation/EDUCATION_MEMORY_POLICY.md",
    },
    "teaching_controls": {
        "version": "teaching-guidance.v2", "reads_versions": ("teaching-guidance.v1", "teaching-guidance.v2"),
        "owner": "tutor_agent", "event": "vnext_teaching_input_received",
        "parser": "clause-local-explicit-controls", "default_lifetime": "session",
        "default_window_hours": 8, "max_explicit_window_hours": 168,
        "cross_session_requires_explicit_deadline": True,
        "write_path": "EvidenceEvent -> reducer -> KernelMutation -> KernelState",
        "source_scope_immutable": True, "historical_backfill": False,
        "expiry_bases": ("explicit_timezone_iso", "inherited_cancelled_window"),
    },
    "learning_episode": {
        "version": "learnflow.learning-episode.v1", "owner": "tutor_agent",
        "tool": "five_kernel_retriever", "kernel_reads": KERNEL_NAMES,
        "kernel_write_path": "none", "authority": "Fact -> KernelMutation -> EvidenceEvent -> owned Attempt",
        "events": ("concept_attempt_evaluated", "exercise_attempt_evaluated"),
        "unknown_assistance_is_independent": False, "contains_answers": False,
        "max_episodes": 3, "max_facts_per_episode": 6,
    },
    "retrieval_components": {
        "version": MEMORY_RETRIEVAL_VERSION, "owner": "tutor_agent",
        "tool": "context_packet_assembler", "kernel_reads": KERNEL_NAMES, "kernel_write_path": "none",
        "switches": ("enable_episodes", "enable_bm25", "enable_aliases", "enable_fuzzy",
                     "enable_temporal", "enable_summary_boost"),
        "semantic_embeddings": False, "diagnostics_are_evidence": False,
        "budget_includes_episode_and_diagnostics": True,
    },
}


LIFECYCLE_STATES = ("implemented", "optional_unimplemented", "deprecated")


SEMANTIC_MEMORY_KEYS = {
    "structure": {
        "path_position", "path_dependencies", "resume_anchor",
        "focus_transition", "deferred_threads", "navigation_blocker",
    },
    "knowledge": {
        "concept_understanding", "knowledge_gap", "pending_question",
        "misconceptions", "active_concepts", "recent_errors", "retention_status",
    },
    "human": {
        "affect", "cognitive_load", "attention", "frustration",
        "pace_preference", "format_preference", "pace_adjustment",
        "format_request", "support_need",
    },
    "value": {
        "current_priority", "current_motivation", "goal_candidate",
        "interest_signal", "relevance_reason",
    },
    "practice": {
        "current_attempt", "assistance_level", "artifact_state",
        "recent_feedback", "transfer_readiness", "review_history",
    },
}


@dataclass(frozen=True)
class AgentContract:
    id: str
    name: str
    plane: str
    components: tuple[str, ...]
    input_contract: tuple[str, ...]
    output_contract: tuple[str, ...]
    kernel_access: str
    must_not: tuple[str, ...]


@dataclass(frozen=True)
class ChatModeContract:
    id: str
    name: str
    owner_agent: str
    skills: tuple[str, ...]
    boundary: str
    completion: str


@dataclass(frozen=True)
class KernelContract:
    id: str
    question: str
    short_term_keys: tuple[str, ...]
    long_term_rule: str
    fact_role: str
    module_role: str
    claim_role: str
    claim_mode: str
    shared_subjects: tuple[str, ...]
    hard_boundaries: tuple[str, ...]
    writer: str = "five_kernel_reducer"


@dataclass(frozen=True)
class ToolContract:
    id: str
    name: str
    owner: str
    origin: str
    mode: str
    reads_kernels: tuple[str, ...] = ()
    writes_kernels: tuple[str, ...] = ()
    write_path: str = "none"


@dataclass(frozen=True)
class SkillStateContract:
    id: str
    title: str
    short_title: str
    substate_id: str
    substate_label: str
    instructional_objective: str
    tutor_instruction: str
    next_action: str
    accepted_signals: tuple[str, ...] = ("attempt",)
    can_loop: bool = True
    requires_learner_reply: bool = True
    loop_instruction: str = "缩小当前动作并补一层支架；不得把提示后的回应当作独立完成。"


@dataclass(frozen=True)
class SkillCalibrationAxisContract:
    id: str
    title: str
    description: str
    options: tuple[tuple[str, str], ...]
    default: str


@dataclass(frozen=True)
class SkillRuntimeContract:
    version: str
    bound_chat_modes: tuple[str, ...]
    initial_state: str
    states: tuple[SkillStateContract, ...]
    turn_budget: int
    verification_required: bool
    required_context: tuple[str, ...]
    input_objects: tuple[str, ...]
    output_objects: tuple[str, ...]
    allowed_event_types: tuple[str, ...]
    evidence_policy: str
    failure_policy: str
    eval_suite: str
    knowledge_requirements: dict[str, Any]
    calibration_axes: tuple[SkillCalibrationAxisContract, ...] = ()
    maturity: str = "production_candidate"


@dataclass(frozen=True)
class SkillContract:
    id: str
    name: str
    owner_agent: str
    tools: tuple[str, ...]
    output_contract: str
    strategy_authority: str
    origin: str = "learnflow"
    learner_selectable: bool = False
    description: str = ""
    invocation_prompt: str = ""
    aliases: tuple[str, ...] = ()
    best_for: tuple[str, ...] = ()
    avoid_when: tuple[str, ...] = ()
    atomic_task_capable: bool = False
    spec_version: str = SKILL_SPEC_VERSION
    runtime: SkillRuntimeContract | None = None


@dataclass(frozen=True)
class WorkbenchContract:
    id: str
    name: str
    surface: str
    owner_agent: str
    capabilities: tuple[str, ...]
    origin: str = "learnflow"


@dataclass(frozen=True)
class EventContract:
    id: str
    owner_agent: str
    capability: str
    tool: str
    workbench: str
    kernel_targets: tuple[str, ...]
    evidence_role: str
    origin: str = "learnflow"
    payload_version: str | None = None
    reducer_binding: str | None = None


@dataclass(frozen=True)
class ImplementationBinding:
    id: str
    kind: str
    module: str = ""
    symbol: str = ""
    path: str = ""
    method: str = ""
    route: str = ""
    endpoint: str = ""
    member: str = ""


@dataclass(frozen=True)
class PublicationContract:
    lifecycle: str
    bindings: tuple[str, ...] = ()
    note: str = ""


@dataclass(frozen=True)
class PluginExtensionPointContract:
    id: str
    contribution: str
    runtime_owner: str
    namespace_rule: str
    authority: str
    restrictions: tuple[str, ...]
    bindings: tuple[str, ...]


PLUGIN_EXTENSION_POINTS = {
    item.id: item
    for item in (
        PluginExtensionPointContract(
            "tool", "versioned model-callable schema + trusted in-process handler", "tutor_agent",
            "plugin_id__tool_id", "plugin handler returns observations/candidates or references saved by explicitly granted, scope-checked host artifact services",
            (
                "read_only_or_artifact", "bounded_json_input_output", "no_kernel_write",
                "no_core_object_write", "candidate_cannot_self_approve_or_publish", "host_private_artifact_grants_only", "conversation_sticky_after_first_tool_run",
            ),
            ("frontend:plugin.registry", "frontend:plugin.loader", "frontend:plugin.picker", "frontend:agent_runtime.run"),
        ),
        PluginExtensionPointContract(
            "skill", "routing conditions + bounded Agent instructions + declared tool/object references", "tutor_agent",
            "plugin_id:skill_id", "instructions guide plugin tool use but cannot replace a core pedagogical runtime",
            ("no_fourth_primary_agent", "no_scoring_authority", "no_evidence_or_kernel_authority"),
            ("frontend:plugin.registry", "frontend:plugin.picker", "frontend:agent_runtime.run"),
        ),
        PluginExtensionPointContract(
            "object", "immutable versioned JSON envelope validated by the contributing plugin", "tutor_agent",
            "plugin_id:object_type:object_id", "plugin object is a tool-result fact boundary, not a LearnFlow core-object authority",
            ("json_only", "schema_version_required", "plugin_ownership_required", "no_mastery_inference"),
            ("frontend:plugin.registry",),
        ),
        PluginExtensionPointContract(
            "tool_renderer", "trusted client component selected by a declared renderer id", "tutor_agent",
            "plugin_id:renderer_id", "renderer receives validated refs and draft/paper callbacks; explicit host grants allow owned work reads, parameter runs and private view/feedback persistence",
            ("no_html_injection", "no_script_payload", "generic_fallback_required", "conversation_output_only", "prompt_reference_only", "paper_projection_only", "owned_artifact_host_grants_only"),
            ("frontend:plugin.renderer", "frontend:plugin.picker"),
        ),
    )
}


AGENTS = {
    item.id: item for item in (
        AgentContract(
            "tutor_agent", "Tutor 控制 Agent", "control",
            ("global_main_agent", "project_tutor", "checkpoint_tutor", "learning_task_runtime"),
            ("current_learner", "page_context", "five_kernel_context_packet", "recent_evidence"),
            ("structured_intent", "reply", "action_proposal", "handoff_refs"),
            "read projections; emit events through Action Board",
            ("direct database writes", "claim mastery", "bypass confirmation policy"),
        ),
        AgentContract(
            "learning_design_agent", "学习设计 Agent", "capability",
            ("roadmap_agent", "learning_task_planner", "lecture_agent", "concept_agent", "animation_agent"),
            ("project_brief", "processed_sources", "learner_projection", "provenance"),
            ("roadmap_proposal", "lecture_artifact", "assessment_spec", "visual_artifact"),
            "read scoped projections; artifacts never mutate mastery",
            ("apply roadmap without confirmation", "invent source provenance", "write kernels"),
        ),
        AgentContract(
            "practice_agent", "实践与验证 Agent", "capability",
            ("exercise_agent", "code_agent", "remediation_renderer"),
            ("assessment_spec", "submission", "test_result", "error_evidence"),
            ("practice_artifact", "feedback", "explanation_sections"),
            "read scoped projections; assessed events enter the reducer",
            ("choose remediation policy", "override deterministic grading", "write kernels"),
        ),
    )
}


CHAT_MODES = {
    item.id: item for item in (
        ChatModeContract(
            "free", "自由探索", "tutor_agent", ("intent_and_handoff", "visual_teaching_composition"),
            "直接回应开放问题，并把清楚的短期、深度或长期意图收敛到其他模式",
            "检测到明确意图时塌陷；否则保持自由",
        ),
        ChatModeContract(
            "explain", "简单讲解", "tutor_agent", ("guided_explanation", "visual_teaching_composition"),
            "完成一个边界清楚的定义、区别或最小示例，不自动创建 LearningTask",
            "讲解交付后标记完成，下一轮从自由模式重新判断",
        ),
        ChatModeContract(
            "learn", "学习任务引导", "tutor_agent",
            ("atomic_learning_loop", "guided_explanation", "socratic_dialogue",
             "feynman_dialogue", "worked_example_fading", "visual_teaching_composition"),
            "围绕一个 LearningTask 组合讲解、练习、验证、纠错与复习转交",
            "任务或 SkillRun 结束、退出或明确转向后返回自由",
        ),
        ChatModeContract(
            "plan", "学习规划", "tutor_agent",
            ("intent_and_handoff", "learning_path_planning", "visual_teaching_composition"),
            "澄清跨多个任务、来源、阶段或真实产物的目标，并优先形成项目提案",
            "提案完成、接受、放弃或明确转向后返回自由",
        ),
    )
}


KERNELS = {
    item.id: item for item in (
        KernelContract("structure", "学习者走到哪里，怎样离开与返回",
                       tuple(sorted(SEMANTIC_MEMORY_KEYS["structure"] | {"semantic_candidate", "teaching_directives"})),
                       "Only stable path patterns and confirmed project structure may consolidate.",
                       "Event-backed navigation, dependency and boundary observations.",
                       "A replaceable route or boundary snapshot; it may remain state-first with one compact anchor claim.",
                       "Optional factual anchor about position or dependency, never a mastery statement.",
                       "sparse_anchor", ("course", "concept", "project", "checkpoint", "task"),
                       ("Learning-path self-report never implies knowledge mastery.",)),
        KernelContract("knowledge", "对哪个知识点理解到什么程度",
                       tuple(sorted(SEMANTIC_MEMORY_KEYS["knowledge"] | {"semantic_candidate", "teaching_directives"})),
                       "Two explicit same-concept self-reports may consolidate only as an exposure boundary; mastery and misconception require graded or explicitly correctable evidence.",
                       "Concept attempts, misconceptions, questions, retention and correction facts.",
                       "Concept-scoped evidence synthesis shared by subject key with Structure but independently authoritative.",
                       "Testable concept claim with explicit evidence grade and correction history.",
                       "evidence_claims", ("course", "concept", "checkpoint", "task"),
                       ("Exposure and self-report cannot become mastery.", "Mastery requires repeated verified evidence.")),
        KernelContract("human", "当前怎样教更合适",
                       tuple(sorted(SEMANTIC_MEMORY_KEYS["human"] | {"semantic_candidate", "teaching_directives"})),
                       "Preferences consolidate after explicit confirmation or cross-session evidence.",
                       "Explicit preferences plus bounded, time-sensitive load and support observations.",
                       "A compact adaptation directive; transient sensitive facts normally expire before module synthesis.",
                       "Sparse learner-correctable teaching directive, not a personality or diagnosis label.",
                       "directive_claims", ("preference", "session", "task"),
                       ("No personality, medical or fixed learning-style inference.", "Sensitive content is excluded from ordinary Agent context.")),
        KernelContract("value", "为什么学，什么更值得投入",
                       tuple(sorted(SEMANTIC_MEMORY_KEYS["value"] | {"semantic_candidate", "teaching_directives"})),
                       "Long-term goals require explicit learner confirmation.",
                       "Goal proposals, confirmed goals, interests, relevance and priority observations.",
                       "A learner-visible goal or interest trajectory; proposals remain short-lived until explicit confirmation.",
                       "Confirmed direction or stable relevance claim with the learner's original evidence quote.",
                       "consent_claims", ("goal", "course", "project", "task"),
                       ("Planning tools may propose but never silently confirm a long-term goal.",)),
        KernelContract("practice", "能否独立做出来",
                       tuple(sorted(SEMANTIC_MEMORY_KEYS["practice"] | {"semantic_candidate", "teaching_directives"})),
                       "Independent and transfer attempts outrank assisted completion.",
                       "Attempts, assistance level, artifacts, feedback, transfer and project performance facts.",
                       "Artifact or task scoped performance history; event/fact-first and often richer than a generic summary module.",
                       "Bounded capability claim that states assistance and transfer conditions; optional until evidence is sufficient.",
                       "performance_claims", ("practice", "artifact", "project", "checkpoint", "task"),
                       ("Assisted success and original-item retry never become independent transfer.", "Project evidence may outlive a single learning session.")),
    )
}
