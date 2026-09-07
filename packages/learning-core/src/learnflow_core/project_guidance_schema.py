"""Closed, bounded inputs for project preparation and operational device reports."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from learnflow_core.project_workflow_schema import ProjectBrief


class ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConversationSource(ClosedModel):
    type: Literal["conversation"] = "conversation"
    id: str = Field(min_length=1, max_length=160)
    session_id: int = Field(ge=1)
    sheet_id: str | None = Field(default=None, max_length=160)


class GuidancePrepare(ClosedModel):
    client_action_id: str = Field(min_length=4, max_length=120)
    project_mode: Literal["experiment", "practice"]
    name: str = Field(min_length=2, max_length=255)
    objective: str = Field(min_length=2, max_length=2000)
    expected_outcome: str = Field(default="", max_length=1200)
    project_brief: ProjectBrief = Field(default_factory=ProjectBrief)
    source_refs: list[ConversationSource] = Field(default_factory=list, max_length=8)
    case_id: str | None = Field(default=None, max_length=100)
    case_version: str | None = Field(default=None, max_length=50)
    case_root_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @field_validator("name", "objective")
    @classmethod
    def meaningful(cls, value: str) -> str:
        if len(value.strip()) < 2:
            raise ValueError("项目主题与目标不能为空")
        return value.strip()


class GuidanceConfirm(ClosedModel):
    client_action_id: str = Field(min_length=4, max_length=120)
    expected_root_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_boolean(cls, value):
        if value is not True:
            raise ValueError("confirmed 必须为显式 true")
        return value


class ManifestFile(ClosedModel):
    path: str = Field(min_length=1, max_length=500)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    size: int = Field(ge=0, le=32 * 1024 * 1024)

    @field_validator("path")
    @classmethod
    def relative_path(cls, value: str) -> str:
        if value.startswith(("/", "\\")) or ".." in value.replace("\\", "/").split("/") or ":" in value or "\x00" in value:
            raise ValueError("仅允许项目内相对路径")
        return value


class ReportStep(ClosedModel):
    name: str = Field(min_length=1, max_length=120)
    exit_code: int
    stdout: str = Field(default="", max_length=12000)
    stderr: str = Field(default="", max_length=12000)


class DeviceReportInput(ClosedModel):
    schema_version: Literal["learnflow.device-report.v1"]
    client_action_id: str = Field(min_length=4, max_length=120)
    checkpoint_id: int = Field(ge=1)
    action: Literal["run", "verify", "files"]
    status: Literal["completed", "failed"]
    snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    exit_code: int | None
    summary: str = Field(min_length=1, max_length=2000)
    manifest: list[ManifestFile] = Field(min_length=1, max_length=100)
    steps: list[ReportStep] = Field(default_factory=list, max_length=9)

    @model_validator(mode="after")
    def coherent(self):
        if len({item.path for item in self.manifest}) != len(self.manifest):
            raise ValueError("文件清单路径重复")
        if self.action == "files":
            if self.status != "completed" or self.exit_code is not None or self.steps:
                raise ValueError("文件摘要报告必须 completed、无退出码且无运行步骤")
            return self
        if self.exit_code is None:
            raise ValueError("运行报告必须包含退出码")
        if self.status == "completed" and (self.exit_code != 0 or any(item.exit_code != 0 for item in self.steps)):
            raise ValueError("完成报告不能包含失败退出码")
        return self
