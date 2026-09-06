from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class MicroLearningRunCreate(BaseModel):
    goal: str = Field(min_length=2, max_length=300)
    source_text: str = Field(default="", max_length=20_000)
    client_request_id: str = Field(min_length=8, max_length=120)

    @field_validator("goal", "source_text", "client_request_id", mode="before")
    @classmethod
    def normalize_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class MicroLearningAdvanceRequest(BaseModel):
    action: Literal[
        "complete_card", "continue_after_feedback", "pause", "resume",
    ]
    expected_version: int = Field(ge=1)
    client_action_id: str = Field(min_length=8, max_length=120)

    @field_validator("client_action_id", mode="before")
    @classmethod
    def normalize_client_action_id(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class TeachBackSubmitRequest(BaseModel):
    response: str = Field(min_length=20, max_length=6_000)
    expected_version: int = Field(ge=1)
    client_submission_id: str = Field(min_length=8, max_length=120)

    @field_validator("response", "client_submission_id", mode="before")
    @classmethod
    def normalize_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class MicroLearningSyncRequest(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    client_action_id: str = Field(min_length=8, max_length=120)

    @field_validator("client_action_id", mode="before")
    @classmethod
    def normalize_client_action_id(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class MicroLearningRegenerateRequest(BaseModel):
    expected_version: int = Field(ge=1)
    client_request_id: str = Field(min_length=8, max_length=120)

    @field_validator("client_request_id", mode="before")
    @classmethod
    def normalize_client_request_id(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value
