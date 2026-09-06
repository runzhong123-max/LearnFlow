from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class LearningTaskCreate(BaseModel):
    title: str = Field(min_length=2, max_length=255)
    objective: str = Field(min_length=2, max_length=2_000)
    session_id: Optional[int] = None
    project_id: Optional[int] = None
    checkpoint_id: Optional[int] = None
    priority: int = Field(default=0, ge=-10, le=10)
    estimated_minutes: int = Field(default=20, ge=5, le=1_440)
    due_at: Optional[datetime] = None
    preferred_skills: list[str] = Field(default_factory=list, max_length=8)
    source_refs: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    success_criteria: list[str] = Field(default_factory=list, max_length=10)
    client_request_id: str = Field(min_length=8, max_length=160)

    @field_validator("title", "objective", "client_request_id", mode="before")
    @classmethod
    def normalize_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class LearningTaskUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=2, max_length=255)
    objective: Optional[str] = Field(default=None, min_length=2, max_length=2_000)
    priority: Optional[int] = Field(default=None, ge=-10, le=10)
    estimated_minutes: Optional[int] = Field(default=None, ge=5, le=1_440)
    due_at: Optional[datetime] = None
    success_criteria: Optional[list[str]] = Field(default=None, max_length=10)
    expected_version: int = Field(ge=1)

    @field_validator("title", "objective", mode="before")
    @classmethod
    def normalize_optional_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class LearningTaskActionRequest(BaseModel):
    action: Literal[
        "accept", "start", "pause", "resume", "cancel", "reopen",
        "complete_phase", "complete_task",
    ]
    expected_version: int = Field(ge=1)
    client_action_id: str = Field(min_length=8, max_length=160)
    phase_id: str = Field(default="", max_length=80)
    evidence_refs: list[dict[str, Any]] = Field(default_factory=list, max_length=30)

    @field_validator("client_action_id", "phase_id", mode="before")
    @classmethod
    def normalize_action_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class LearningTaskReplanRequest(BaseModel):
    reason: str = Field(min_length=2, max_length=1_000)
    learner_direction: str = Field(default="", max_length=1_000)
    preferred_skills: list[str] = Field(default_factory=list, max_length=8)
    expected_version: int = Field(ge=1)
    client_request_id: str = Field(min_length=8, max_length=160)

    @field_validator("reason", "learner_direction", "client_request_id", mode="before")
    @classmethod
    def normalize_replan_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class LearningTaskMaterializeRequest(BaseModel):
    source_text: str = Field(default="", max_length=20_000)
    expected_version: int = Field(ge=1)
    client_request_id: str = Field(min_length=8, max_length=160)

    @field_validator("source_text", "client_request_id", mode="before")
    @classmethod
    def normalize_materialize_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class LearningTaskReorderRequest(BaseModel):
    task_ids: list[int] = Field(min_length=1, max_length=200)
    client_request_id: str = Field(min_length=8, max_length=160)

    @field_validator("client_request_id", mode="before")
    @classmethod
    def normalize_reorder_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value
