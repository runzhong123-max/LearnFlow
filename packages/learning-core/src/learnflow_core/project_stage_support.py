"""Versioned teaching support overlay; immutable case bundles stay unchanged.

These templates describe student/mentor responsibility, never grading policy or
file existence. Device services resolve recommended paths against real files.
"""
from copy import deepcopy
from typing import get_args
from learnflow_core.project_workflow_schema import HelpMode

SUPPORT_VERSION = "learnflow.stage-support.v1"
HELP_MODES = get_args(HelpMode)


def assistance_view(mode: str = "direction", revision: int = 0) -> dict:
    if mode not in HELP_MODES:
        mode = "direction"
    return {"mode": mode, "revision": revision,
            "execution_mode": "workspace_write" if mode == "implementation" else "read_only"}


def _support(student, mentor, shared, files=()):
    return {"support_version": SUPPORT_VERSION, "student_tasks": student,
            "mentor_support": mentor, "shared_tasks": shared, "related_files": list(files)}


def _file(path, role, reason):
    return {"path": path, "role": role, "reason": reason}


_TEMPLATES = {
    ("experiment", "define"): _support(
        ["用自己的话说明输入、预期输出和最小交付物。", "先写预测与理由，再列一个可能失败的边界。"],
        ["帮助识别前置知识和输入约束。", "把验收要求拆成可观察的检查项，不代写预测。"],
        ["固定本轮变量、基线和最小成功标准。"]),
    ("experiment", "implement"): _support(
        ["完成当前要练习的核心逻辑，先验证最小输入。", "亲自运行并比较实际结果与预测，解释失败原因。"],
        ["检查调用关系、错误清理和测试接线。", "按所选帮助档位分析；需要修改时先展示方案并确认。"],
        ["核对受影响文件和边界用例，保留可复现运行。"]),
    ("experiment", "reflect"): _support(
        ["解释产物如何满足目标，并指出尚未覆盖的边界。", "提出只改变一个条件的下一步实验。"],
        ["核对运行依据与结论是否一致，不把运行通过视为掌握。"],
        ["整理复现步骤、环境、风险与下一实验。"]),
    ("learning", "orient"): _support(
        ["选择资料并说明要解决的问题和已有基础。"],
        ["核对资料范围，帮助定位前置知识。"], ["固定来源版本与本轮学习目标。"]),
    ("learning", "read"): _support(
        ["带着问题阅读，保存位置，再合上材料用自己的话复述。"],
        ["围绕当前不清楚的机制给提示，不替代学生复述。"], ["把解释不清的地方整理为下一步验证问题。"]),
    ("learning", "verify"): _support(
        ["进入正式任务独立应用，并说明依据与边界。"],
        ["提供练习入口和有界反馈，不代做正式验证。"], ["按正式结果安排复习；阅读与自述不替代掌握证据。"]),
    ("practice", "clarify"): _support(
        ["读工单并复述重复记录、状态、邮箱的处理约定。", "先预测哪些输入容易出错，写出需要确认的边界。"],
        ["帮助定位契约与原始输入，追问学生判断的依据。"],
        ["把业务约定写成可检查的输入输出标准。"],
        [_file("README.md", "docs", "先了解初始工程与运行方式。"), _file("input.csv", "input", "用实际记录检查边界预测。")]),
    ("practice", "implement"): _support(
        ["实现当前数据转换核心逻辑，分开检查规范化、拒绝和去重。", "运行初始批次，提交实际输出并解释修改原因。"],
        ["分析失败位置、检查测试与工程支撑；不提前完成后续批次。"],
        ["比较预测与观察，核对最小改动和回归用例。"],
        [_file("importer.c", "implementation", "当前核心逻辑与输入输出入口。"), _file("input.csv", "input", "本阶段已提供的运行输入。")]),
    ("practice", "handoff"): _support(
        ["保持原契约，用当前开放的新批次亲自复测。", "说明运行方法、剩余风险和下一步实验。"],
        ["审查交接是否可复现，区分程序输出正确与解释质量。"],
        ["整理交付记录，说明哪些部分独立完成、哪些获得了帮助。"],
        [_file("README.md", "docs", "补充可复现的工作交接说明。"), _file("importer.c", "implementation", "对照最终实现解释边界与风险。")]),
}


def stage_support(mode: str, key: str, *, bundled_case: bool = False) -> dict:
    # Practice-specific paths only belong to the known authored case.
    template = _TEMPLATES.get((mode, key)) if mode != "practice" or bundled_case else None
    return deepcopy(template or _support(
        ["复述当前阶段输入与交付要求，先做最小尝试并说明依据。"],
        ["围绕当前问题提供提示、审查和工程支撑。"],
        ["核对边界、实际结果与复现方式，保留帮助记录。"]))


def help_guidance(stage: dict, mode: str) -> str:
    hints = stage.get("hints") or [
        "先把本关的目标、输入、预期输出和限制逐项写清楚。对照材料，提出一个最小的可检查问题。",
        "把预测、实际观察、解释和下一步分开。每次只改一个条件，保存可复现依据；正式独立验证仍需在本关学习任务中完成。",
    ]
    if mode in {"direction", "steps"}:
        return hints[0 if mode == "direction" else min(1, len(hints) - 1)]
    if mode == "pseudocode":
        return ("先用伪代码表达当前阶段，不直接生成实现代码：\n"
                "读取当前输入 → 核对约定与边界 → 写出每一步判断和变化 → 输出可检查的结果 → 比较预测与实际。\n"
                "请把每个箭头替换为本阶段的具体动作，再让导师检查遗漏的分支。工程助手此档只做只读分析。")
    return ("已允许为当前阶段提出实现修改。请先说明需要协助的工程部分，保留自己要练习的核心逻辑。"
            "工程助手仍需先预览任务、确认运行，再由你核对差异并确认写回；选择本档不代表代码已生成或已应用。")
