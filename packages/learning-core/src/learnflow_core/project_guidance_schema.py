"""Closed, bounded inputs for project preparation and operational device reports."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_serializer, model_validator
from learnflow_core.project_workflow_schema import HelpMode, ProjectBrief
from learnflow_core.project_stage_support import assistance_view


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


class ReportAssistancePolicy(ClosedModel):
    mode: HelpMode
    revision: int = Field(strict=True, ge=0, le=2**53 - 1)
    execution_mode: Literal["read_only", "workspace_write"]

    @model_validator(mode="after")
    def coherent(self):
        if self.execution_mode != assistance_view(self.mode)["execution_mode"]:
            raise ValueError("帮助档位与运行权限不一致")
        return self


class EngineeringProvenanceRun(ClosedModel):
    run_id: int = Field(strict=True, gt=0, le=2**53 - 1)
    checkpoint_id: int | None = Field(strict=True, gt=0, le=2**53 - 1)
    status: Literal["completed", "applied"]
    snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    result_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    assistance_policy: ReportAssistancePolicy | None
    association: Literal["exact_files", "applied_project_history"]
    matching_paths: list[str] = Field(max_length=100)

    @field_validator("matching_paths")
    @classmethod
    def relative_paths(cls, paths):
        if len(paths) != len(set(paths)):
            raise ValueError("辅助来源文件路径重复")
        for path in paths:
            if not path or len(path) > 500 or "\\" in path or any(part in {"", ".", ".."} for part in path.split("/")):
                raise ValueError("辅助来源只允许规范项目相对路径")
            ManifestFile.relative_path(path)
        return paths

    @model_validator(mode="after")
    def coherent(self):
        if self.association == "exact_files" and not self.matching_paths:
            raise ValueError("精确文件关联必须包含匹配路径")
        if self.association == "applied_project_history" and (self.status != "applied" or self.matching_paths):
            raise ValueError("项目历史关联必须为已应用运行且无精确匹配路径")
        if self.assistance_policy and self.assistance_policy.execution_mode != "workspace_write":
            raise ValueError("只读运行不能报告文件修改来源")
        return self


class EngineeringProvenance(ClosedModel):
    schema_version: Literal["learnflow.engineering-provenance.v1"]
    authority: Literal["device_reported"]
    independent_completion_verified: Literal[False]
    assisted: bool = Field(strict=True)
    runs: list[EngineeringProvenanceRun] = Field(max_length=20)
    truncated: bool = Field(strict=True)

    @field_validator("independent_completion_verified", mode="before")
    @classmethod
    def never_verified(cls, value):
        if value is not False:
            raise ValueError("设备来源不能声明独立完成已验证")
        return value

    @model_validator(mode="after")
    def coherent(self):
        if len({run.run_id for run in self.runs}) != len(self.runs):
            raise ValueError("辅助来源运行编号重复")
        if self.assisted != bool(self.runs) or (self.truncated and len(self.runs) != 20):
            raise ValueError("辅助来源标记与运行记录不一致")
        return self


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
    engineering_provenance: EngineeringProvenance | None = None

    @model_serializer(mode="wrap")
    def preserve_legacy_hash(self, handler):
        data = handler(self)
        # Older persisted reports were hashed without this optional field. A
        # missing source remains unknown and must not become a new false claim.
        if self.engineering_provenance is None:
            data.pop("engineering_provenance", None)
        return data

    @model_validator(mode="after")
    def coherent(self):
        if len({item.path for item in self.manifest}) != len(self.manifest):
            raise ValueError("文件清单路径重复")
        if self.engineering_provenance:
            paths = {item.path for item in self.manifest}
            if any(not set(run.matching_paths) <= paths for run in self.engineering_provenance.runs):
                raise ValueError("辅助来源精确文件必须属于本次报告清单")
        if self.action == "files":
            if self.status != "completed" or self.exit_code is not None or self.steps:
                raise ValueError("文件摘要报告必须 completed、无退出码且无运行步骤")
            return self
        if self.exit_code is None:
            raise ValueError("运行报告必须包含退出码")
        if self.status == "completed" and (self.exit_code != 0 or any(item.exit_code != 0 for item in self.steps)):
            raise ValueError("完成报告不能包含失败退出码")
        return self
