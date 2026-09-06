"""Versioned project workflow input; notes never replace AgentMessage authority."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

ProjectMode = Literal["learning", "experiment", "practice"]


class ProjectBrief(BaseModel):
    deliverables: list[str] = Field(default_factory=list, max_length=12)
    constraints: list[str] = Field(default_factory=list, max_length=12)
    success_criteria: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("deliverables", "constraints", "success_criteria")
    @classmethod
    def bounded_lines(cls, values: list[str]) -> list[str]:
        if any(len(value) > 1200 for value in values):
            raise ValueError("每条内容不能超过 1200 字符")
        return [value.strip() for value in values if value.strip()]


class ArtifactRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["source_version", "experiment_run", "workspace_file", "learning_file"]
    ref: str = Field(min_length=1, max_length=500)
    revision: str | None = Field(default=None, max_length=128)


class WorkflowPaper(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    kind: Literal["note", "question", "hypothesis", "reflection"] = "note"
    body: str = Field(default="", max_length=30000)
    artifact_ref: ArtifactRef | None = None


class DeliveryDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answers: dict[str, str] = Field(default_factory=dict, max_length=20)
    artifact_refs: list[ArtifactRef] = Field(default_factory=list, max_length=20)
    assistance_level: Literal["independent", "hint", "together", "demonstrated"] = "independent"

    @field_validator("answers")
    @classmethod
    def bounded_answers(cls, values: dict[str, str]) -> dict[str, str]:
        if any(len(key) > 80 or len(value) > 30000 for key, value in values.items()):
            raise ValueError("交付草稿字段超出长度限制")
        return values


class WorkbenchState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    active_tab: str = Field(default="overview", max_length=100)
    active_checkpoint_id: int | None = Field(default=None, ge=1)
    active_file: str | None = Field(default=None, max_length=500)
    active_paper_id: str | None = Field(default=None, max_length=100)
    papers: list[WorkflowPaper] = Field(default_factory=list, max_length=60)
    open_files: list[str] = Field(default_factory=list, max_length=40)
    delivery_drafts: dict[str, DeliveryDraft] = Field(default_factory=dict, max_length=64)

    @field_validator("open_files")
    @classmethod
    def relative_paths(cls, values: list[str]) -> list[str]:
        if any(len(value) > 500 or value.startswith(("/", "\\")) or ".." in value.replace("\\", "/").split("/") for value in values):
            raise ValueError("文件标签只保存项目内相对路径")
        return list(dict.fromkeys(values))


class WorkbenchSaveRequest(BaseModel):
    expected_revision: int = Field(ge=0)
    client_action_id: str = Field(min_length=4, max_length=120)
    workbench: WorkbenchState


class WorkflowInitializeRequest(BaseModel):
    client_action_id: str = Field(min_length=4, max_length=120)
    case_id: str | None = Field(default=None, max_length=100)
    case_version: str | None = Field(default=None, max_length=50)
    case_root_hash: str | None = Field(default=None, max_length=64)


class DeliveryRequest(BaseModel):
    client_action_id: str = Field(min_length=4, max_length=120)
    answers: dict[str, str] = Field(default_factory=dict, max_length=20)
    artifact_refs: list[ArtifactRef] = Field(default_factory=list, max_length=20)
    assistance_level: Literal["independent", "hint", "together", "demonstrated"] = "independent"

    @field_validator("answers")
    @classmethod
    def bound_answers(cls, values: dict[str, str]) -> dict[str, str]:
        if any(len(key) > 80 or len(value) > 30000 for key, value in values.items()):
            raise ValueError("交付字段超出长度限制")
        return values


class ReadingRecordRequest(BaseModel):
    client_action_id: str = Field(min_length=4, max_length=120)
    source_id: int = Field(ge=1)
    source_version_id: int = Field(ge=1)
    locator: str = Field(min_length=1, max_length=500)
    notes: str = Field(default="", max_length=10000)


class CaseValidationRequest(BaseModel):
    version: str = Field(min_length=1, max_length=50)
    root_hash: str = Field(min_length=64, max_length=64)


class WorkflowHintRequest(BaseModel):
    client_action_id: str = Field(min_length=4, max_length=120)
    level: Literal[1, 2]
