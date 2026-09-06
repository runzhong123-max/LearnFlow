from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class AgentSessionCreate(BaseModel):
    session_type: Literal["global", "project", "checkpoint"] = "global"
    project_id: Optional[int] = None
    checkpoint_id: Optional[int] = None
    create_new: bool = False
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    client_conversation_id: Optional[str] = Field(default=None, min_length=8, max_length=120)

    @field_validator("title", "client_conversation_id", mode="before")
    @classmethod
    def normalize_session_identity(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class RolePackageLaunchConsumeRequest(BaseModel):
    token: str = Field(min_length=80, max_length=8_192)
    client_conversation_id: str = Field(min_length=8, max_length=120)

    @field_validator("token", "client_conversation_id", mode="before")
    @classmethod
    def normalize_launch_identity(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class VNextSessionMessage(BaseModel):
    client_message_id: str = Field(min_length=8, max_length=120)
    role: Literal["assistant", "user", "system"]
    content: str = Field(min_length=1, max_length=120_000)
    created_at_ms: int = Field(ge=0)
    meta_data: dict[str, Any] = Field(default_factory=dict)

    @field_validator("client_message_id", "content", mode="before")
    @classmethod
    def normalize_vnext_message(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class VNextSessionSyncRequest(BaseModel):
    client_conversation_id: str = Field(min_length=8, max_length=120)
    title: str = Field(min_length=1, max_length=255)
    mode: Literal["free", "simple_explain", "guided_learning", "learning_plan"] = "free"
    messages: list[VNextSessionMessage] = Field(default_factory=list, max_length=500)

    @field_validator("client_conversation_id", "title", mode="before")
    @classmethod
    def normalize_vnext_session(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class TutorTurnRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    # None supports legacy clients; an explicit empty value excludes control/reference text.
    direct_user_text: Optional[str] = Field(default=None, max_length=20000)
    project_id: Optional[int] = None
    checkpoint_id: Optional[int] = None
    selected_action_id: Optional[int] = None
    selected_skill_id: Optional[str] = Field(default=None, max_length=80)
    client_turn_id: Optional[str] = Field(default=None, min_length=3, max_length=160)
    prepared_skill_turn_id: Optional[int] = Field(default=None, ge=1)
    context: dict[str, Any] = Field(default_factory=dict)
    context_refs: list[str] = Field(default_factory=list, max_length=3)


class VisualPlannerRequest(BaseModel):
    instructions: str = Field(min_length=20, max_length=24_000)
    input: str = Field(min_length=1, max_length=100_000)
    timeout_ms: int = Field(default=180_000, ge=1_000, le=900_000)
    max_tokens: int = Field(default=2_200, ge=400, le=32_768)
    response_format: Literal["json_object"] = "json_object"


class LearningSkillRunCreateRequest(BaseModel):
    skill_id: Literal[
        "guided_explanation",
        "socratic_dialogue",
        "feynman_dialogue",
        "worked_example_fading",
        "learning_file_study",
    ]
    goal: str = Field(min_length=2, max_length=300)
    client_request_id: str = Field(min_length=8, max_length=120)
    domain_source_ids: list[int] = Field(default_factory=list, max_length=20)
    learning_task_id: Optional[int] = Field(default=None, ge=1)

    @field_validator("goal", "client_request_id", mode="before")
    @classmethod
    def normalize_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class LearningSkillRunActionRequest(BaseModel):
    action: Literal["pause", "resume", "start_verification", "calibrate"]
    expected_version: int = Field(ge=1)
    client_action_id: str = Field(min_length=8, max_length=120)
    audience_level: Optional[Literal[
        "beginner", "high_school", "vocational", "undergraduate", "graduate", "professional",
    ]] = None
    cognitive_demand: Optional[Literal["define", "mechanism", "boundary", "transfer"]] = None
    scaffold_level: Optional[Literal["model", "guided", "minimal", "none"]] = None
    representation_mode: Optional[Literal["auto", "code", "visual", "analogy", "formal"]] = None

    @field_validator("client_action_id", mode="before")
    @classmethod
    def normalize_client_action_id(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class LearningSkillRunTurnRequest(BaseModel):
    """Advance the deterministic SkillRun without invoking a second Tutor LLM."""

    message: str = Field(min_length=1, max_length=12000)
    # None supports legacy clients; an explicit empty value excludes control/reference text.
    direct_user_text: Optional[str] = Field(default=None, max_length=20000)
    expected_version: int = Field(ge=1)
    client_turn_id: str = Field(min_length=8, max_length=120)
    domain_source_ids: list[int] = Field(default_factory=list, max_length=20)

    @field_validator("message", "client_turn_id", mode="before")
    @classmethod
    def normalize_turn_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class LearningEventRequest(BaseModel):
    client_event_id: str = Field(min_length=3, max_length=160)
    event_type: str = Field(min_length=2, max_length=80)
    project_id: Optional[int] = None
    checkpoint_id: Optional[int] = None
    session_id: Optional[int] = None
    payload: dict[str, Any] = Field(default_factory=dict)


class TutorObservation(BaseModel):
    kernel: Literal["structure", "knowledge", "human", "value", "practice"] = Field(
        description=(
            "structure 只表示路径位置、依赖、转向与返回线索；knowledge 只表示具体概念的"
            "理解、知识缺口、已诊断误解与验证状态；目标归 value，能力产物归 practice。"
        )
    )
    short_term: dict[str, Any] = Field(
        default_factory=dict,
        description="只写本轮证据直接支持的短期字段，不复制其他维度内容。",
    )
    reason: str = ""


class ProjectOpportunity(BaseModel):
    should_propose: bool = False
    title: str = ""
    description: str = ""
    reason: str = ""
    initial_concepts: list[str] = Field(default_factory=list)
    practice_artifact: str = ""
    proposal_type: Literal["build", "mastery", "exam", "research"] = "build"
    learning_goal: str = ""
    practice_goal: str = ""
    learner_start: list[str] = Field(default_factory=list)
    estimated_effort: str = ""
    milestones: list[dict[str, Any]] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    source_search_query: str = ""


class LearningIntent(BaseModel):
    immediate_need: str = ""
    long_term_goal: str = ""
    artifact_intent: str = ""
    relevant_proposal_key: str = ""
    horizon: Literal["short", "long", "unclear"] = "unclear"


class LearningTaskOpportunity(BaseModel):
    """A bounded task suggestion; creation stays proposed until learner accepts."""

    should_propose: bool = False
    consent_basis: Literal["explicit_user_request", "tutor_recommendation"] = "tutor_recommendation"
    title: str = Field(default="", max_length=255)
    objective: str = Field(default="", max_length=2000)
    reason: str = Field(default="", max_length=500)
    estimated_minutes: int = Field(default=20, ge=5, le=1440)
    priority: int = Field(default=0, ge=-10, le=10)
    suggested_skills: list[str] = Field(default_factory=list, max_length=6)
    success_criteria: list[str] = Field(default_factory=list, max_length=8)


class MajorEventCandidate(BaseModel):
    event_type: Literal["career_goal_confirmed"]
    career_goal: str = Field(min_length=2, max_length=200)
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_text: str = Field(default="", max_length=500)


class LocalAgentTaskProposal(BaseModel):
    should_delegate: bool = False
    task_type: Literal["code_change", "bug_fix", "refactor", "test", "documentation"] = "code_change"
    goal: str = Field(default="", max_length=2000)
    constraints: list[str] = Field(default_factory=list)
    required_capabilities: list[str] = Field(default_factory=lambda: ["code_edit"])
    reason: str = Field(default="", max_length=500)


class TutorModelOutput(BaseModel):
    reply: str
    observations: list[TutorObservation] = Field(default_factory=list)
    project_opportunity: Optional[ProjectOpportunity] = None
    learning_task_opportunity: Optional[LearningTaskOpportunity] = None
    learning_intent: Optional[LearningIntent] = None
    major_event_candidates: list[MajorEventCandidate] = Field(default_factory=list)
    local_agent_task: Optional[LocalAgentTaskProposal] = None


class ProjectProposalUpdateRequest(BaseModel):
    patch: dict[str, Any] = Field(default_factory=dict)
    lock_fields: list[str] = Field(default_factory=list)
    unlock_fields: list[str] = Field(default_factory=list)
    client_event_id: Optional[str] = Field(default=None, min_length=3, max_length=160)


class ProjectProposalAcceptRequest(BaseModel):
    client_event_id: str = Field(min_length=3, max_length=160)
