from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ExperimentTestCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default="样例", min_length=1, max_length=80)
    stdin: str = Field(default="", max_length=8192)
    expected_stdout: str = Field(max_length=8192)


class ExperimentRunPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: Literal["c11"] = "c11"
    action: Literal["syntax", "build", "run", "verify"]
    files: list[str] = Field(min_length=1, max_length=64)
    stdin: str = Field(default="", max_length=8192)
    args: list[str] = Field(default_factory=list, max_length=16)
    test_cases: list[ExperimentTestCase] = Field(default_factory=list, max_length=8)
    checkpoint_id: int | None = Field(default=None, gt=0)
    client_request_id: str = Field(min_length=1, max_length=100)

    @field_validator("args")
    @classmethod
    def valid_args(cls, value: list[str]) -> list[str]:
        if any(len(arg) > 256 or "\x00" in arg for arg in value):
            raise ValueError("程序参数过长或包含 NUL")
        return value

    @model_validator(mode="after")
    def require_tests(self):
        if self.action == "verify" and not self.test_cases:
            raise ValueError("预设验证需要至少一个可见输入输出样例")
        if self.action != "verify" and self.test_cases:
            raise ValueError("只有预设验证接受测试样例")
        return self


class ExperimentRunConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    acknowledge_trusted_local: Literal[True]

    @field_validator("acknowledge_trusted_local", mode="before")
    @classmethod
    def explicit_acknowledgement(cls, value):
        if value is not True:
            raise ValueError("必须明确确认可信本地执行")
        return value


class ExperimentRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int
    checkpoint_id: int | None = None
    profile_id: str
    action: str
    status: str
    snapshot_hash: str
    manifest: list[dict]
    request: dict
    result: dict
    created_at: datetime
    expires_at: datetime
    confirmed_at: datetime | None = None
    finished_at: datetime | None = None


class ExperimentRunListResponse(BaseModel):
    runs: list[ExperimentRunResponse]
