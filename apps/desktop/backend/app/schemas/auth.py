from datetime import datetime
import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator


EducationStage = Literal[
    "middle_school", "high_school", "undergraduate", "graduate", "working", "other",
]
CareerGoalStatus = Literal["exploring", "confirmed"]
AccountRole = Literal["user", "admin"]


PASSWORD_MIN_LENGTH = 8
PASSWORD_POLICY_MESSAGE = (
    "密码至少 8 位，并包含大写字母、小写字母、数字、特殊字符中的至少两类"
)
_PASSWORD_CATEGORY_PATTERNS = (
    re.compile(r"[A-Z]"),
    re.compile(r"[a-z]"),
    re.compile(r"[0-9]"),
    re.compile(r"[^A-Za-z0-9\s]"),
)


def validate_new_password(password: str) -> str:
    if len(password) < PASSWORD_MIN_LENGTH:
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    category_count = sum(bool(pattern.search(password)) for pattern in _PASSWORD_CATEGORY_PATTERNS)
    if category_count < 2:
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    return password


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=128)
    display_name: str = Field(min_length=1, max_length=40)
    education_stage: EducationStage
    background: str = Field(min_length=1, max_length=500)
    focus_areas: list[str] = Field(min_length=1, max_length=5)
    weekly_hours: int = Field(ge=1, le=80)
    preferred_modes: list[str] = Field(min_length=1, max_length=6)
    career_goal: str = Field(default="", max_length=200)
    career_goal_status: CareerGoalStatus = "exploring"

    @field_validator("password")
    @classmethod
    def strong_password(cls, value: str) -> str:
        return validate_new_password(value)

    @field_validator("focus_areas", "preferred_modes")
    @classmethod
    def clean_list(cls, values: list[str]) -> list[str]:
        cleaned = [str(value).strip()[:50] for value in values if str(value).strip()]
        return list(dict.fromkeys(cleaned))

    @field_validator("career_goal_status")
    @classmethod
    def valid_career_status(cls, value: str, info):
        career_goal = str(info.data.get("career_goal") or "").strip()
        if value == "confirmed" and not career_goal:
            raise ValueError("确认职业理想前需要填写目标")
        return value


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class AuthenticatedProfileResponse(BaseModel):
    education_stage: str
    background: str
    focus_areas: list[str]
    weekly_hours: int
    preferred_modes: list[str]
    career_goal: str
    career_goal_status: str


class AuthenticatedAccountResponse(BaseModel):
    id: int
    account_number: int
    username: str
    display_name: str
    learner_id: int
    role: AccountRole
    status: str
    must_change_password: bool
    is_legacy_demo: bool
    profile: AuthenticatedProfileResponse
    dev_test_login_enabled: bool
    is_dev_login: bool
    desktop_auth_token: str | None = None
    desktop_pet_capability_token: str | None = None


class DesktopPetCapabilityRefreshResponse(BaseModel):
    desktop_pet_capability_token: str


class LogoutResponse(BaseModel):
    status: Literal["ok"]


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=128)

    @field_validator("new_password")
    @classmethod
    def strong_new_password(cls, value: str) -> str:
        return validate_new_password(value)


class CsrfTokenResponse(BaseModel):
    csrf_token: str


class ModelCredentialUpdateRequest(BaseModel):
    # Empty/whitespace means "keep the current encrypted key". Deletion is an
    # explicit DELETE so masked form submissions cannot erase a credential.
    api_key: str = Field(default="", max_length=4096)
    base_url: str = Field(default="", max_length=2048)
    model: str = Field(default="", max_length=200)


class ModelCredentialMetadata(BaseModel):
    configured: bool
    key_hint: str = ""
    updated_at: datetime | None = None
    base_url: str = ""
    model: str = ""


class VisionCredentialUpdateRequest(BaseModel):
    # Empty keys retain a dedicated vision credential. Explicit tutor-key
    # reuse clears only that dedicated envelope.
    api_key: str = Field(default="", max_length=4096)
    base_url: str = Field(default="", max_length=2048)
    model: str = Field(default="", max_length=200)
    use_tutor_key: bool = False


class VisionCredentialMetadata(BaseModel):
    configured: bool
    uses_tutor_key: bool
    key_hint: str = ""
    updated_at: datetime | None = None
    base_url: str = ""
    model: str = ""


class ModelCredentialTestRequest(BaseModel):
    base_url: str = Field(default="", max_length=2048)
    model: str = Field(default="", max_length=200)


class ModelCredentialTestResponse(BaseModel):
    status: Literal["ok"]
    model: str
    latency_ms: int


class ModelCredentialResolveResponse(BaseModel):
    api_key: str
    key_hint: str
    version: int
    base_url: str = ""
    model: str = ""


class AdminAccountProjection(BaseModel):
    account_number: int
    username: str
    display_name: str
    role: AccountRole
    status: str
    created_at: datetime | None = None
    updated_at: datetime | None = None
    last_login_at: datetime | None = None
    project_count: int = 0
    api_key_configured: bool = False


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=40)
    education_stage: EducationStage | None = None
    background: str | None = Field(default=None, min_length=1, max_length=500)
    focus_areas: list[str] | None = Field(default=None, min_length=1, max_length=5)
    weekly_hours: int | None = Field(default=None, ge=1, le=80)
    preferred_modes: list[str] | None = Field(default=None, min_length=1, max_length=6)
    career_goal: str | None = Field(default=None, max_length=200)
    career_goal_status: CareerGoalStatus | None = None


class MemoryArchiveRequest(BaseModel):
    reason: str = Field(default="", max_length=500)
