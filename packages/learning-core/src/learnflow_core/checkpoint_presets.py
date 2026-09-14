"""Scoped entry design over existing checkpoints; never a grader or file writer."""
from typing import Literal
from pathlib import PurePosixPath
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PRESET_VERSION = "learnflow.checkpoint-entry.v1"


class RequiredFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=240)
    purpose: str = Field(min_length=2, max_length=600)

    @field_validator("path")
    @classmethod
    def relative_file(cls, value):
        parts = value.split("/")
        if (value != value.strip() or "\\" in value or ":" in value or any(ord(c) < 32 for c in value)
                or PurePosixPath(value).is_absolute() or any(p in {"", ".", "..", ".learnflow", ".git"} for p in parts)
                or any(p == ".env" or p.startswith(".env.") for p in parts)):
            raise ValueError("文件必须是普通项目文件的相对路径，不能包含保护目录或凭据文件")
        return value


class CheckpointPreset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["knowledge", "overview", "setup", "implementation", "workflow", "deployment", "review"]
    lecture_focus: str = Field(min_length=2, max_length=1200)
    practice_focus: str = Field(default="", max_length=800)
    workflow_step: str = Field(default="", max_length=300)
    required_files: list[RequiredFile] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def file_contract(self):
        if self.kind == "implementation" and not self.required_files:
            raise ValueError("实现关卡需要明确待完成文件及各自职责")
        paths = [item.path.casefold() for item in self.required_files]
        if len(paths) != len(set(paths)):
            raise ValueError("同一关卡的文件路径不能重复")
        if self.kind in {"knowledge", "overview"} and not self.practice_focus.strip():
            raise ValueError("知识与综述关卡需要明确习题或小练习目标")
        if self.kind == "workflow" and not self.workflow_step.strip():
            raise ValueError("实践关卡需要明确对应的工作流程步骤")
        return self


class PlannedCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    title: str = Field(min_length=2, max_length=255)
    objective: str = Field(min_length=2, max_length=1200)
    entry_preset: CheckpointPreset


def validate_mode_preset(mode, preset, order):
    if preset is None:  # Existing clients and confirmed routes remain readable.
        return
    if mode == "learning" and preset.kind != "knowledge":
        raise ValueError("学习型项目按知识递进规划，每关配讲义与一份习题")
    if mode == "practice" and order == 1 and preset.kind != "overview":
        raise ValueError("实践型项目第一关必须是综述，包含总纲讲义与小练习")
    if mode == "practice" and order > 1 and preset.kind not in {"workflow", "review"}:
        raise ValueError("实践型后续关卡应对应一个工作流程步骤")
    if mode == "experiment" and preset.kind not in {"setup", "implementation", "deployment", "review"}:
        raise ValueError("实验型项目以实现关卡组成交付，可包含环境、部署和复核关卡")


def checkpoint_entry_preset(project, checkpoint, stage=None, *, workflow_titles=()):
    stage = stage or {}
    mode = project.project_mode or "learning"
    raw = (checkpoint.brief or {}).get("entry_preset") or stage.get("entry_preset")
    title = checkpoint.title
    objective = checkpoint.description or title
    if raw:
        preset = CheckpointPreset.model_validate(raw).model_dump()
    else:
        key = str((checkpoint.brief or {}).get("checkpoint_key") or stage.get("key") or "")
        kind = ("knowledge" if mode == "learning" else "overview" if mode == "practice" and checkpoint.order == 1
                else "workflow" if mode == "practice" else "setup" if key in {"define", "setup", "environment"}
                else "review" if key in {"reflect", "review"} else "deployment" if key == "deploy" else "implementation")
        files = [{"path": f["path"], "purpose": f.get("reason") or objective} for f in stage.get("related_files", [])
                 if f.get("role") in {"implementation", "test", "docs"}]
        preset = {"kind": kind, "lecture_focus": objective,
                  "practice_focus": ("围绕本关知识完成一份习题，先理解再应用。" if mode == "learning" else
                                     "用少量小练习检查工作目标、整体流程、输入输出与关键风险。" if kind == "overview" else ""),
                  "workflow_step": title if mode == "practice" else "", "required_files": files}
    overview = preset["kind"] == "overview"
    return {"schema_version": PRESET_VERSION, **preset, "configured": bool(raw),
            "overview_outline": " → ".join(workflow_titles)[:2000] if overview else "",
            "lecture_title": f"{project.name} · 工作总纲" if overview else f"{title} · 讲义",
            "practice_title": "综述小练习" if overview else f"{title} · 习题",
            "file_kinds": ["lecture", "practice"] if preset["practice_focus"] else ["lecture"],
            "help_surface": "code_paper", "desktop_guidance": mode in {"experiment", "practice"},
            "needs_file_plan": preset["kind"] == "implementation" and not preset["required_files"]}


def generation_focus(preset):
    return (f"本关类型：{preset['kind']}。讲义重点：{preset['lecture_focus']}。\n"
            + (f"习题集目标：{preset['practice_focus']}。\n" if preset["practice_focus"] else "")
            + (f"总纲需覆盖完整工作流程：{preset['overview_outline']}。\n" if preset.get("overview_outline") else "")
            + (f"工作流程步骤：{preset['workflow_step']}。\n" if preset["workflow_step"] else "")
            + "待完成文件（仅作为任务约束，不生成完整答案）："
            + "；".join(f"{f['path']}：{f['purpose']}" for f in preset["required_files"]))
