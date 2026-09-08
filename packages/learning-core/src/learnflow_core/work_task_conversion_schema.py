"""Versioned, bounded conversion inputs; identity always comes from authentication."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SourceRef(Input):
    type: Literal["conversation", "user_note"]
    id: str = Field(min_length=1, max_length=160)
    session_id: int | None = Field(default=None, gt=0)
    sheet_id: str | None = Field(default=None, max_length=160)
    label: str | None = Field(default=None, max_length=300)


class Brief(Input):
    task_title: str = Field(default="", max_length=300)
    task_description: str = Field(default="", max_length=5000)
    work_context: str = Field(default="", max_length=2000)
    deliverable: str = Field(default="", max_length=2000)
    acceptance_criteria: list[str] = Field(default_factory=list, max_length=12)
    constraints: list[str] = Field(default_factory=list, max_length=12)
    learner_level: str = Field(default="", max_length=500)
    # Source identities cannot be authored/overwritten in a brief. The server
    # accepts only the exact already-verified refs for roundtrip editing.
    source_refs: list[dict] = Field(default_factory=list, max_length=20)

    @field_validator("acceptance_criteria", "constraints")
    @classmethod
    def bounded_lines(cls, value):
        if any(not item.strip() or len(item) > 1000 for item in value):
            raise ValueError("条目必须为 1 至 1000 字符")
        return list(dict.fromkeys(item.strip() for item in value))


class Action(Input):
    client_action_id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")


class Create(Action):
    original_input: str = Field(min_length=1, max_length=12000)
    source_refs: list[SourceRef] = Field(default_factory=list, max_length=20)
    role_launch_token: str | None = Field(default=None, max_length=8192)


class Message(Action):
    expected_revision: int = Field(gt=0)
    message: str = Field(min_length=1, max_length=5000)


class UpdateBrief(Action):
    expected_revision: int = Field(gt=0)
    brief: Brief


class Generate(Action):
    expected_root_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed: StrictBool
    project_mode: Literal["learning", "experiment", "practice"]
    design_recipe_id: str | None = Field(default=None, max_length=120)


class Handoff(Action):
    expected_root_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed: StrictBool
    action: Literal["discuss", "create_project", "desktop"]
    project_id: int | None = Field(default=None, gt=0)
    selected_step_ids: list[str] | None = Field(default=None, min_length=1, max_length=12)


class Consume(Action):
    expected_root_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed: StrictBool
