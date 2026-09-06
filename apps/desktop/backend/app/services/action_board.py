from dataclasses import dataclass


@dataclass(frozen=True)
class ActionDefinition:
    capability: str
    title: str
    side_effect: str
    confirmation_policy: str
    evidence_target: dict
    next_affordances: tuple[str, ...]


ACTION_BOARD = {
    item.capability: item for item in (
        ActionDefinition("read_project_workflow", "读取三类项目的当前流程", "none", "none", {}, ("initialize_project_workflow", "submit_project_delivery")),
        ActionDefinition("request_project_hint", "请求当前阶段的分档提示", "context", "explicit_or_click", {}, ("submit_project_delivery",)),
        ActionDefinition("prepare_local_work_case", "校验固定版本实践案例候选", "proposal", "explicit_or_click", {}, ("initialize_project_workflow",)),
        ActionDefinition("initialize_project_workflow", "确认项目路线与正式关卡任务", "write", "explicit_or_click", {}, ("read_project_workflow",)),
        ActionDefinition("save_project_workbench", "保存工作台纸张与布局", "write", "explicit_or_click", {}, ()),
        ActionDefinition("submit_project_delivery", "提交交付物并读取有界反馈", "write", "explicit_or_click", {}, ("read_project_workflow",)),
        ActionDefinition("record_project_reading", "记录资料阅读位置与复述", "write", "explicit_or_click", {}, ("read_project_workflow",)),
        ActionDefinition(
            "search_projects", "匹配已有学习项目", "none", "none",
            {"structure": "project_match"},
            ("enter_project", "draft_learning_project"),
        ),
        ActionDefinition(
            "use_learning_skill", "在当前对话中使用学习方法", "none", "none",
            {},
            ("start_learning_skill_run", "start_micro_learning", "draft_learning_project"),
        ),
        ActionDefinition(
            "coordinate_chat_mode", "协调当前 Chat 学习形态", "context", "none",
            {},
            ("use_learning_skill", "run_learning_task", "draft_learning_project"),
        ),
        ActionDefinition(
            "coordinate_vnext_agent_turn", "编排 vNext 有界观察—行动—观察循环", "context", "none",
            {},
            ("read_vnext_five_kernel_profile", "read_vnext_learning_workspace",
             "lookup_vnext_learning_path_node", "search_vnext_learning_path_graph", "read_review_context",
             "search_computer_knowledge", "read_web_evidence", "search_learning_videos", "inspect_learning_video", "generate_learning_diagram", "generate_learning_animation"),
        ),
        ActionDefinition(
            "desktop_pet_companion", "读取正式会话、任务、复习和学习文件陪伴摘要", "none", "none",
            {},
            ("desktop_pet_task_control", "desktop_pet_main_navigation", "desktop_pet_context_attachment"),
        ),
        ActionDefinition(
            "desktop_pet_task_control", "开始、暂停或恢复已存在的学习任务", "context", "explicit_or_click",
            {},
            ("desktop_pet_main_navigation",),
        ),
        ActionDefinition(
            "desktop_pet_main_navigation", "在主窗口定位正式项目、任务、复习或学习文件", "context", "click_or_explicit",
            {},
            (),
        ),
        ActionDefinition(
            "desktop_pet_context_attachment", "确认并临时附加外部参考到当前 Tutor 回合", "context", "explicit_or_click",
            {},
            ("coordinate_vnext_agent_turn",),
        ),
        ActionDefinition(
            "search_computer_knowledge", "检索计算机知识来源", "none", "explicit_or_auto",
            {},
            ("read_web_evidence",),
        ),
        ActionDefinition(
            "read_web_evidence", "读取本轮搜索候选网页证据", "none", "none",
            {},
            (),
        ),
        ActionDefinition(
            "search_learning_videos", "搜索与学习目标匹配的视频候选", "none", "none",
            {},
            ("inspect_learning_video",),
        ),
        ActionDefinition(
            "inspect_learning_video", "核验本轮视频候选的字幕与目标覆盖", "none", "none",
            {},
            (),
        ),
        ActionDefinition(
            "validate_teaching_contract", "校验关卡教学契约并保证最小交付", "none", "none",
            {},
            ("read_checkpoint_delivery_readiness",),
        ),
        ActionDefinition(
            "read_checkpoint_delivery_readiness", "读取教学包与原子任务就绪度", "none", "none",
            {},
            ("generate_learning_files", "design_assessment_blueprint", "run_vnext_learning_task"),
        ),
        ActionDefinition(
            "generate_learning_diagram", "生成安全学习图解", "artifact", "explicit_or_click",
            {},
            (),
        ),
        ActionDefinition(
            "generate_learning_animation", "生成安全学习动画", "artifact", "explicit_or_click",
            {},
            (),
        ),
        ActionDefinition(
            "open_selection_followup", "从选中文字打开追问纸张", "context", "explicit_or_click",
            {},
            (),
        ),
        ActionDefinition(
            "run_vnext_learning_task", "在 vNext 对话中编排原子学习任务", "context", "explicit_or_click",
            {},
            ("search_computer_knowledge", "read_web_evidence", "generate_learning_diagram", "generate_learning_animation"),
        ),
        ActionDefinition(
            "run_vnext_learning_plan", "在 vNext 对话中形成项目雏形或发展方向草案", "proposal", "explicit_or_auto",
            {},
            (),
        ),
        ActionDefinition(
            "draft_learning_task_candidate", "把真实工作任务转为学习型任务候选", "artifact", "explicit_or_auto",
            {},
            ("plan_learning_task",),
        ),
        ActionDefinition(
            "read_vnext_five_kernel_profile", "为 vNext Tutor 读取正式五核上下文", "none", "none",
            {},
            (),
        ),
        ActionDefinition(
            "read_vnext_learning_workspace", "读取当前任务、规划与项目知识领域", "none", "none",
            {},
            ("run_vnext_learning_task", "run_vnext_learning_plan"),
        ),
        ActionDefinition(
            "manage_domain_knowledge_sources", "维护当前对话资料来源", "write", "explicit_or_click",
            {},
            ("read_domain_knowledge", "recommend_learning_resources"),
        ),
        ActionDefinition(
            "read_domain_knowledge", "读取当前对话附加资料", "none", "none",
            {},
            ("recommend_learning_resources", "run_vnext_learning_plan"),
        ),
        ActionDefinition(
            "read_active_learning_file", "读取当前纸张中的学习文件", "none", "none",
            {},
            ("open_selection_followup", "attach_learning_file_to_chat"),
        ),
        ActionDefinition(
            "read_project_roadmap", "读取当前项目关卡图", "none", "none",
            {},
            ("revise_project_roadmap", "navigate_checkpoint"),
        ),
        ActionDefinition(
            "revise_project_roadmap", "修订当前项目未开始关卡", "write", "explicit_or_click",
            {"structure": "confirmed_project_roadmap_revision"},
            ("read_project_roadmap", "navigate_checkpoint"),
        ),
        ActionDefinition(
            "recommend_learning_resources", "为学习规划筛选候选资源", "proposal", "explicit_or_auto",
            {},
            ("manage_domain_knowledge_sources", "run_vnext_learning_plan"),
        ),
        ActionDefinition(
            "generate_learning_files", "为学习任务生成正式讲义与练习文件", "artifact", "explicit_or_click",
            {},
            ("open_learning_file", "attach_learning_file_to_chat"),
        ),
        ActionDefinition(
            "design_assessment_blueprint", "设计练习蓝图与评分量表", "proposal", "explicit_or_auto",
            {},
            ("generate_dynamic_practice", "generate_similar_practice"),
        ),
        ActionDefinition(
            "generate_dynamic_practice", "按能力蓝图生成动态练习文件", "artifact", "explicit_or_auto",
            {},
            ("inspect_practice_quality", "open_learning_file", "attach_learning_file_to_chat", "evaluate_attempt"),
        ),
        ActionDefinition(
            "generate_similar_practice", "生成保持目标能力的同构变式", "artifact", "explicit_or_auto",
            {},
            ("inspect_practice_quality", "open_learning_file", "attach_learning_file_to_chat", "evaluate_attempt"),
        ),
        ActionDefinition(
            "inspect_practice_quality", "检查生成习题的静态质量", "none", "none",
            {},
            ("open_learning_file", "evaluate_attempt"),
        ),
        ActionDefinition(
            "open_learning_file", "打开正式讲义或练习文件", "context", "explicit_or_click",
            {},
            ("attach_learning_file_to_chat", "evaluate_attempt"),
        ),
        ActionDefinition(
            "attach_learning_file_to_chat", "把正式学习文件接入对话纸张", "context", "explicit_or_click",
            {},
            ("open_selection_followup", "evaluate_attempt"),
        ),
        ActionDefinition(
            "read_vnext_learning_path_graph", "为规划态读取官方与个人学习路径图", "none", "none",
            {},
            ("lookup_vnext_learning_path_node",),
        ),
        ActionDefinition(
            "lookup_vnext_learning_path_node", "精确读取学习路径节点", "none", "none",
            {},
            ("search_vnext_learning_path_graph", "plan_vnext_learning_path"),
        ),
        ActionDefinition(
            "search_vnext_learning_path_graph", "在精确未命中后模糊检索学习路径", "none", "none",
            {},
            ("search_computer_knowledge", "plan_vnext_learning_path", "propose_vnext_personal_path_node"),
        ),
        ActionDefinition(
            "propose_vnext_personal_path_node", "形成有来源的个人路径节点提案", "proposal", "explicit_or_auto",
            {},
            ("manage_vnext_personal_path_node",),
        ),
        ActionDefinition(
            "plan_vnext_learning_path", "根据目标与五核上下文生成长期学习路径提案", "proposal", "explicit_or_auto",
            {},
            ("manage_vnext_learning_path_plan",),
        ),
        ActionDefinition(
            "manage_vnext_learning_path_plan", "确认、修订或归档个人长期学习路径", "write", "explicit_or_click",
            {"structure": "confirmed_learning_path_plan", "value": "confirmed_long_term_goal"},
            ("read_vnext_learning_path_graph", "run_vnext_learning_plan"),
        ),
        ActionDefinition(
            "read_personal_concept_graph", "读取个人概念学习图", "none", "none",
            {},
            ("record_concept_self_report",),
        ),
        ActionDefinition(
            "record_concept_self_report", "记录学习者明确提交的概念自述", "write", "explicit_or_click",
            {"knowledge": "concept_history_self_report", "structure": "concept_relation_self_report"},
            ("read_personal_concept_graph", "manage_learner_memory"),
        ),
        ActionDefinition(
            "manage_vnext_personal_path_node", "标记路径状态或确认管理个人节点", "write", "explicit_or_click",
            {"structure": "learning_path_overlay", "knowledge": "self_reported_exposure", "value": "learning_interest_candidate"},
            ("read_vnext_learning_path_graph",),
        ),
        ActionDefinition(
            "manage_learner_memory", "确认、纠正、撤回或归档五核记忆", "write", "explicit_or_click",
            {"structure": "learner_correction", "knowledge": "learner_correction",
             "human": "learner_correction", "value": "learner_confirmation",
             "practice": "learner_correction"},
            ("read_vnext_five_kernel_profile",),
        ),
        ActionDefinition(
            "edit_vnext_five_kernel_profile", "按核更新学习者明确资料与长期方向", "write", "explicit_or_click",
            {"knowledge": "declared_background_only", "human": "explicit_learning_preferences",
             "value": "explicit_focus_or_confirmed_direction"},
            ("read_vnext_five_kernel_profile", "manage_learner_memory"),
        ),
        ActionDefinition(
            "delete_conversation", "从工作区删除独立学习对话", "write", "explicit_or_click",
            {},
            (),
        ),
        ActionDefinition(
            "manage_learning_tasks", "管理学习任务队列", "write", "explicit_or_click",
            {},
            ("plan_learning_task", "run_learning_task"),
        ),
        ActionDefinition(
            "plan_learning_task", "生成或调整学习任务计划", "proposal", "explicit_or_click",
            {},
            ("run_learning_task",),
        ),
        ActionDefinition(
            "run_learning_task", "开始、暂停或推进学习任务", "context", "explicit_or_click",
            {},
            ("use_learning_skill", "start_micro_learning", "evaluate_attempt", "plan_review_queue"),
        ),
        ActionDefinition(
            "start_learning_skill_run", "开始对话内学习方法", "context", "explicit_or_click",
            {},
            ("advance_learning_skill_run", "start_skill_verification"),
        ),
        ActionDefinition(
            "advance_learning_skill_run", "推进、暂停或恢复对话内学习方法", "context", "explicit_or_click",
            {},
            ("start_skill_verification",),
        ),
        ActionDefinition(
            "start_skill_verification", "为当前学习方法开始独立验证", "write", "explicit_or_click",
            {"structure": "focused_learning_started", "value": "goal_confirmation"},
            ("continue_micro_learning", "analyze_teach_back"),
        ),
        ActionDefinition(
            "start_micro_learning", "开始一次可验证微学习", "write", "explicit",
            {"structure": "focused_learning_started", "value": "goal_confirmation"},
            ("continue_micro_learning", "analyze_teach_back"),
        ),
        ActionDefinition(
            "continue_micro_learning", "继续或暂停微学习", "context", "explicit_or_click",
            {"structure": "focused_learning_position"},
            ("analyze_teach_back", "evaluate_attempt", "plan_review_queue"),
        ),
        ActionDefinition(
            "analyze_teach_back", "分析费曼复述", "evidence", "explicit",
            {"knowledge": "teach_back_diagnosis", "practice": "diagnostic_attempt"},
            ("evaluate_attempt",),
        ),
        ActionDefinition(
            "draft_learning_project", "起草学习项目", "none", "none",
            {"value": "goal_draft", "practice": "artifact_draft"},
            ("create_project",),
        ),
        ActionDefinition(
            "revise_learning_project_proposal", "更新项目提案", "none", "none",
            {"structure": "proposal_revision", "knowledge": "prerequisite_draft",
             "human": "learning_pace_draft", "value": "goal_draft",
             "practice": "artifact_draft"},
            ("create_project", "search_learning_resources"),
        ),
        ActionDefinition(
            "search_learning_resources", "寻找候选学习来源", "none", "none",
            {"structure": "source_candidates", "practice": "resource_candidates"},
            ("add_source",),
        ),
        ActionDefinition(
            "create_project", "建立学习项目", "write", "explicit_or_card",
            {"structure": "project_selection", "value": "goal_confirmation"},
            ("add_source", "plan_learning_path"),
        ),
        ActionDefinition(
            "delete_project", "从工作区删除学习项目", "write", "explicit_or_click",
            {},
            (),
        ),
        ActionDefinition(
            "bootstrap_project", "建立项目并接入来源", "write", "explicit",
            {"structure": "project_selection", "practice": "source_ingested"},
            ("plan_learning_path",),
        ),
        ActionDefinition(
            "enter_project", "进入学习项目", "context", "click_or_explicit",
            {"structure": "project_selection"},
            ("add_source", "plan_learning_path", "navigate_checkpoint"),
        ),
        ActionDefinition(
            "add_source", "添加并处理来源", "write", "explicit_or_card",
            {"structure": "source_added", "practice": "source_processed"},
            ("plan_learning_path",),
        ),
        ActionDefinition(
            "plan_learning_path", "规划学习路线", "proposal", "explicit_or_card",
            {"structure": "roadmap_proposal"},
            ("apply_learning_path",),
        ),
        ActionDefinition(
            "apply_learning_path", "应用学习路线", "write", "explicit_or_card",
            {"structure": "roadmap_applied"},
            ("navigate_checkpoint",),
        ),
        ActionDefinition(
            "manage_project_conversations", "管理项目 Tutor、关卡与自由对话", "context", "explicit_or_click",
            {},
            ("plan_learning_path", "navigate_checkpoint", "run_learning_task"),
        ),
        ActionDefinition(
            "navigate_checkpoint", "进入检查点", "context", "click_or_explicit",
            {"structure": "checkpoint_entered"},
            ("generate_lecture", "generate_assessment"),
        ),
        ActionDefinition(
            "generate_lecture", "生成本关讲义", "artifact", "explicit_or_card",
            {"knowledge": "content_exposure"},
            ("generate_assessment",),
        ),
        ActionDefinition(
            "generate_assessment", "生成验证任务", "artifact", "explicit_or_card",
            {"knowledge": "assessment_attempt", "practice": "independent_attempt"},
            ("evaluate_attempt",),
        ),
        ActionDefinition(
            "evaluate_attempt", "评估本次尝试", "evidence", "explicit",
            {"knowledge": "graded_attempt", "practice": "verified_artifact"},
            ("request_remediation_explanation", "advance_checkpoint"),
        ),
        ActionDefinition(
            "request_remediation_explanation", "请求确定性纠错讲解", "evidence", "explicit",
            {"knowledge": "error_evidence", "human": "explanation_effect"},
            ("retry_attempt",),
        ),
        ActionDefinition(
            "retry_attempt", "重做原任务", "evidence", "explicit",
            {"knowledge": "retry_result", "practice": "assisted_attempt"},
            ("evaluate_transfer_variant", "advance_checkpoint"),
        ),
        ActionDefinition(
            "evaluate_transfer_variant", "完成变式验证", "evidence", "explicit",
            {"knowledge": "transfer_result", "practice": "transfer_attempt"},
            ("advance_checkpoint",),
        ),
        ActionDefinition(
            "plan_review_queue", "读取并编排复习队列", "none", "none",
            {},
            ("read_review_context", "evaluate_review_attempt", "manage_review_item"),
        ),
        ActionDefinition(
            "read_review_context", "读取复习证据与可解释熟练度", "none", "none",
            {},
            ("evaluate_review_attempt", "manage_review_item", "record_review_reflection"),
        ),
        ActionDefinition(
            "record_review_reflection", "记录学习者的复习反思", "write", "explicit_or_click",
            {"knowledge": "unverified_correctable_reflection"},
            ("read_review_context", "manage_learner_memory"),
        ),
        ActionDefinition(
            "evaluate_review_attempt", "评估间隔复习尝试", "evidence", "explicit",
            {"knowledge": "spaced_retrieval", "practice": "review_attempt"},
            ("request_remediation_explanation", "plan_review_queue"),
        ),
        ActionDefinition(
            "manage_review_item", "延期、暂停或恢复复习题", "context", "explicit_or_click",
            {},
            ("plan_review_queue",),
        ),
        ActionDefinition(
            "explain_selection", "解释选中内容", "none", "explicit",
            {"knowledge": "explanation_exposure"},
            ("generate_assessment",),
        ),
        ActionDefinition(
            "advance_checkpoint", "推进下一关", "context", "explicit_or_click",
            {"structure": "checkpoint_entered"},
            ("generate_lecture", "generate_assessment"),
        ),
        ActionDefinition(
            "record_task_outcome", "记录异步任务结果", "none", "none",
            {},
            (),
        ),
        ActionDefinition(
            "link_project_workspace", "关联本地项目目录", "write", "explicit",
            {},
            ("inspect_workspace_files",),
        ),
        ActionDefinition("inspect_experiment_environment", "检查实验工具链", "none", "none", {}, ("propose_experiment_run",)),
        ActionDefinition("propose_experiment_run", "预览实验执行", "proposal", "explicit_or_click", {}, ("execute_experiment_run",)),
        ActionDefinition("execute_experiment_run", "确认实验编译与运行", "execution", "explicit", {}, ("inspect_experiment_run",)),
        ActionDefinition("inspect_experiment_run", "读取真实实验结果", "none", "none", {}, ()),
        ActionDefinition(
            "inspect_workspace_files", "查看项目文件", "none", "none",
            {},
            ("propose_workspace_change",),
        ),
        ActionDefinition(
            "propose_workspace_change", "提出项目文件修改", "proposal", "none",
            {},
            ("apply_workspace_change",),
        ),
        ActionDefinition(
            "apply_workspace_change", "确认并应用项目文件修改", "write", "explicit",
            {},
            ("inspect_workspace_files",),
        ),
        ActionDefinition(
            "open_managed_learning_artifact", "打开讲义/练习播放器", "none", "none",
            {},
            ("annotate_learning_artifact",),
        ),
        ActionDefinition(
            "edit_managed_lecture", "版本化修改讲义", "write", "explicit_or_click",
            {},
            ("open_managed_learning_artifact",),
        ),
        ActionDefinition(
            "annotate_learning_artifact", "批注讲义或练习", "write", "explicit_or_click",
            {},
            ("open_managed_learning_artifact",),
        ),
        ActionDefinition(
            "delegate_local_agent_task", "委派本地代码 Agent", "execution", "explicit",
            {},
            ("inspect_local_agent_run", "cancel_local_agent_run"),
        ),
        ActionDefinition(
            "inspect_local_agent_run", "查看本地 Agent 结果", "none", "none",
            {},
            ("apply_local_agent_result",),
        ),
        ActionDefinition(
            "cancel_local_agent_run", "取消本地 Agent", "execution", "explicit_or_click",
            {},
            (),
        ),
        ActionDefinition(
            "apply_local_agent_result", "应用本地 Agent 修改", "write", "explicit",
            {},
            ("inspect_workspace_files",),
        ),
    )
}


def definition(capability: str) -> ActionDefinition:
    return ACTION_BOARD[capability]
