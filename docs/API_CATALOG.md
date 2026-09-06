# LearnFlow API 与桌面 IPC 清单

由 `scripts/generate_api_catalog.py` 从当前代码生成。每行按宿主 + 方法 + 路径计数；相同路径在不同宿主属于不同入口，不据此断言行为或鉴权相同。FastAPI 来源为已挂载 APIRoute（含被运行策略限制的接口），不包含框架自动生成的 /docs、/redoc、/openapi.json；Node 为显式 Tutor 中间件；Atlas 为显式 route.ts 方法；IPC 为 generate_handler 注册项。代理转发不重复计数。

本清单是导航索引，不是访问授权或完整 schema 文档；身份、权限、请求响应字段以源代码和各 FastAPI 的 `/openapi.json` 为准。运行中的 registry 提供能力状态，路由存在不等于当前环境可用。

[模块与调用关系总览](PROJECT_MAP.md)

| 宿主 | 方法与路径条目数 |
|---|---:|
| Desktop FastAPI | 255 |
| Desktop Node Tutor (dev/preview) | 3 |
| Desktop Tauri IPC | 16 |
| Role Atlas / Graph Hub | 46 |
| Web FastAPI | 234 |
| Web Node Tutor | 3 |

## Desktop FastAPI

### app.api.agent

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/agent/actions/{action_id}` | [get_action](../apps/desktop/backend/app/api/agent.py#L1088) |
| POST | `/api/agent/actions/{action_id}/cancel` | [cancel_action](../apps/desktop/backend/app/api/agent.py#L1165) |
| POST | `/api/agent/actions/{action_id}/confirm` | [confirm_action](../apps/desktop/backend/app/api/agent.py#L1115) |
| GET | `/api/agent/modes` | [list_chat_modes](../apps/desktop/backend/app/api/agent.py#L212) |
| GET | `/api/agent/project-proposals/{proposal_id}` | [get_project_proposal](../apps/desktop/backend/app/api/agent.py#L929) |
| PATCH | `/api/agent/project-proposals/{proposal_id}` | [patch_project_proposal](../apps/desktop/backend/app/api/agent.py#L959) |
| POST | `/api/agent/project-proposals/{proposal_id}/accept` | [accept_project_proposal](../apps/desktop/backend/app/api/agent.py#L981) |
| POST | `/api/agent/project-proposals/{proposal_id}/dismiss` | [dismiss_project_proposal](../apps/desktop/backend/app/api/agent.py#L1037) |
| POST | `/api/agent/project-proposals/{proposal_id}/refresh-sources` | [refresh_project_proposal_sources](../apps/desktop/backend/app/api/agent.py#L1077) |
| POST | `/api/agent/project-proposals/{proposal_id}/reopen` | [reopen_project_proposal](../apps/desktop/backend/app/api/agent.py#L1062) |
| GET | `/api/agent/projects/{project_id}/accepted-proposal` | [get_accepted_project_proposal](../apps/desktop/backend/app/api/agent.py#L939) |
| POST | `/api/agent/role-package-launches/consume` | [consume_role_package_launch](../apps/desktop/backend/app/api/agent.py#L619) |
| GET | `/api/agent/sessions` | [list_sessions](../apps/desktop/backend/app/api/agent.py#L220) |
| POST | `/api/agent/sessions` | [create_or_resume_session](../apps/desktop/backend/app/api/agent.py#L549) |
| DELETE | `/api/agent/sessions/{session_id}` | [delete_session](../apps/desktop/backend/app/api/agent.py#L263) |
| GET | `/api/agent/sessions/{session_id}` | [get_session](../apps/desktop/backend/app/api/agent.py#L803) |
| POST | `/api/agent/sessions/{session_id}/skill-runs` | [start_learning_skill_run](../apps/desktop/backend/app/api/agent.py#L301) |
| POST | `/api/agent/sessions/{session_id}/skill-runs/{run_id}/actions` | [update_learning_skill_run](../apps/desktop/backend/app/api/agent.py#L376) |
| POST | `/api/agent/sessions/{session_id}/skill-runs/{run_id}/turns` | [advance_learning_skill_turn](../apps/desktop/backend/app/api/agent.py#L429) |
| POST | `/api/agent/sessions/{session_id}/turns` | [tutor_turn](../apps/desktop/backend/app/api/agent.py#L813) |
| POST | `/api/agent/sessions/{session_id}/visual-plans` | [plan_visual_for_desktop](../apps/desktop/backend/app/api/agent.py#L894) |
| PUT | `/api/agent/sessions/{session_id}/vnext` | [sync_vnext_session](../apps/desktop/backend/app/api/agent.py#L750) |
| GET | `/api/agent/skills` | [list_learning_skills](../apps/desktop/backend/app/api/agent.py#L204) |
| POST | `/api/learning-events` | [create_learning_event](../apps/desktop/backend/app/api/agent.py#L1186) |

### app.api.auth

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/admin/accounts` | [admin_accounts](../apps/desktop/backend/app/api/auth.py#L822) |
| GET | `/api/auth/csrf` | [csrf_token](../apps/desktop/backend/app/api/auth.py#L376) |
| POST | `/api/auth/desktop-pet-capability` | [refresh_desktop_pet_capability](../apps/desktop/backend/app/api/auth.py#L794) |
| POST | `/api/auth/login` | [login](../apps/desktop/backend/app/api/auth.py#L308) |
| POST | `/api/auth/logout` | [logout](../apps/desktop/backend/app/api/auth.py#L742) |
| GET | `/api/auth/me` | [me](../apps/desktop/backend/app/api/auth.py#L758) |
| DELETE | `/api/auth/model-credential` | [delete_model_credential](../apps/desktop/backend/app/api/auth.py#L434) |
| GET | `/api/auth/model-credential` | [get_model_credential](../apps/desktop/backend/app/api/auth.py#L389) |
| PUT | `/api/auth/model-credential` | [put_model_credential](../apps/desktop/backend/app/api/auth.py#L398) |
| POST | `/api/auth/model-credential/internal/resolve` | [resolve_model_credential_for_runtime](../apps/desktop/backend/app/api/auth.py#L641) |
| POST | `/api/auth/model-credential/test` | [test_model_credential](../apps/desktop/backend/app/api/auth.py#L577) |
| POST | `/api/auth/password` | [change_password](../apps/desktop/backend/app/api/auth.py#L687) |
| POST | `/api/auth/register` | [register](../apps/desktop/backend/app/api/auth.py#L205) |
| GET | `/api/auth/status` | [auth_status](../apps/desktop/backend/app/api/auth.py#L767) |
| DELETE | `/api/auth/vision-credential` | [delete_vision_credential](../apps/desktop/backend/app/api/auth.py#L506) |
| GET | `/api/auth/vision-credential` | [get_vision_credential](../apps/desktop/backend/app/api/auth.py#L450) |
| PUT | `/api/auth/vision-credential` | [put_vision_credential](../apps/desktop/backend/app/api/auth.py#L459) |
| POST | `/api/auth/vision-credential/test` | [test_vision_credential](../apps/desktop/backend/app/api/auth.py#L522) |
| POST | `/api/demo/login` | [competition_demo_login](../apps/desktop/backend/app/api/auth.py#L886) |
| GET | `/api/demo/manifest` | [competition_demo_manifest](../apps/desktop/backend/app/api/auth.py#L922) |
| GET | `/api/demo/status` | [competition_demo_status](../apps/desktop/backend/app/api/auth.py#L881) |
| GET | `/api/dev/accounts` | [list_dev_accounts](../apps/desktop/backend/app/api/auth.py#L943) |
| POST | `/api/dev/accounts/{account_id}/login` | [dev_login](../apps/desktop/backend/app/api/auth.py#L972) |

### app.api.experiments

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/projects/{project_id}/experiments/profiles` | [list_experiment_profiles](../apps/desktop/backend/app/api/experiments.py#L40) |
| GET | `/api/projects/{project_id}/experiments/runs` | [list_experiment_runs](../apps/desktop/backend/app/api/experiments.py#L83) |
| POST | `/api/projects/{project_id}/experiments/runs/preview` | [preview_experiment_run](../apps/desktop/backend/app/api/experiments.py#L52) |
| GET | `/api/projects/{project_id}/experiments/runs/{run_id}` | [get_experiment_run](../apps/desktop/backend/app/api/experiments.py#L95) |
| POST | `/api/projects/{project_id}/experiments/runs/{run_id}/confirm` | [confirm_experiment_run](../apps/desktop/backend/app/api/experiments.py#L71) |

### app.api.pet

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/pet/bootstrap` | [desktop_pet_bootstrap](../apps/desktop/backend/app/api/pet.py#L137) |
| POST | `/api/pet/context-packages` | [create_context_package](../apps/desktop/backend/app/api/pet.py#L199) |
| POST | `/api/pet/context-packages/document` | [create_document_context_package](../apps/desktop/backend/app/api/pet.py#L221) |
| POST | `/api/pet/context-packages/image` | [create_image_context_package](../apps/desktop/backend/app/api/pet.py#L268) |
| DELETE | `/api/pet/context-packages/{package_id}` | [delete_context_package](../apps/desktop/backend/app/api/pet.py#L373) |
| POST | `/api/pet/context-packages/{package_id}/confirm` | [confirm_context_package](../apps/desktop/backend/app/api/pet.py#L355) |
| POST | `/api/pet/selection-text` | [transcribe_selection_text](../apps/desktop/backend/app/api/pet.py#L323) |

### app.api.project_workflows

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/practice-cases` | [list_cases](../apps/desktop/backend/app/api/project_workflows.py#L19) |
| GET | `/api/practice-cases/{case_id}` | [read_case](../apps/desktop/backend/app/api/project_workflows.py#L24) |
| POST | `/api/practice-cases/{case_id}/validate` | [validate_case](../apps/desktop/backend/app/api/project_workflows.py#L30) |
| POST | `/api/vnext-projects/{project_id}/checkpoints/{checkpoint_id}/deliver` | [deliver](../apps/desktop/backend/app/api/project_workflows.py#L70) |
| POST | `/api/vnext-projects/{project_id}/checkpoints/{checkpoint_id}/hint` | [hint](../apps/desktop/backend/app/api/project_workflows.py#L87) |
| POST | `/api/vnext-projects/{project_id}/reading` | [reading](../apps/desktop/backend/app/api/project_workflows.py#L80) |
| PUT | `/api/vnext-projects/{project_id}/workbench` | [save_workbench](../apps/desktop/backend/app/api/project_workflows.py#L63) |
| GET | `/api/vnext-projects/{project_id}/workflow` | [read_workflow](../apps/desktop/backend/app/api/project_workflows.py#L40) |
| POST | `/api/vnext-projects/{project_id}/workflow/initialize` | [initialize](../apps/desktop/backend/app/api/project_workflows.py#L56) |

### app.api.vnext_projects

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/vnext-projects` | [list_vnext_projects](../apps/desktop/backend/app/api/vnext_projects.py#L348) |
| POST | `/api/vnext-projects` | [create_vnext_project](../apps/desktop/backend/app/api/vnext_projects.py#L361) |
| GET | `/api/vnext-projects/{project_id}` | [get_vnext_project](../apps/desktop/backend/app/api/vnext_projects.py#L391) |
| GET | `/api/vnext-projects/{project_id}/agent-context` | [get_project_agent_context](../apps/desktop/backend/app/api/vnext_projects.py#L730) |
| GET | `/api/vnext-projects/{project_id}/knowledge-baseline` | [read_project_knowledge_baseline](../apps/desktop/backend/app/api/vnext_projects.py#L796) |
| POST | `/api/vnext-projects/{project_id}/knowledge-baseline/proposals` | [propose_project_knowledge_baseline](../apps/desktop/backend/app/api/vnext_projects.py#L953) |
| POST | `/api/vnext-projects/{project_id}/knowledge-baseline/{packet_id}/confirm` | [confirm_project_knowledge_baseline](../apps/desktop/backend/app/api/vnext_projects.py#L994) |
| POST | `/api/vnext-projects/{project_id}/knowledge-sources/promotions` | [promote_project_knowledge_source](../apps/desktop/backend/app/api/vnext_projects.py#L811) |
| PUT | `/api/vnext-projects/{project_id}/roadmap` | [revise_vnext_roadmap](../apps/desktop/backend/app/api/vnext_projects.py#L482) |
| POST | `/api/vnext-projects/{project_id}/roadmap/apply` | [apply_vnext_roadmap](../apps/desktop/backend/app/api/vnext_projects.py#L403) |
| POST | `/api/vnext-projects/{project_id}/sessions` | [create_project_free_session](../apps/desktop/backend/app/api/vnext_projects.py#L671) |
| DELETE | `/api/vnext-projects/{project_id}/sources/{source_id}` | [remove_project_source](../apps/desktop/backend/app/api/vnext_projects.py#L697) |
| POST | `/api/vnext-projects/{project_id}/sources/{source_id}/health` | [update_project_source_health](../apps/desktop/backend/app/api/vnext_projects.py#L1054) |

### learnflow_core.api.architecture

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/architecture/registry` | [get_architecture_registry](../packages/learning-core/src/learnflow_core/api/architecture.py#L12) |
| GET | `/api/architecture/validate` | [validate_architecture_registry](../packages/learning-core/src/learnflow_core/api/architecture.py#L17) |

### learnflow_core.api.assessment_design

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/assessment-blueprints` | [list_assessment_blueprints](../packages/learning-core/src/learnflow_core/api/assessment_design.py#L57) |
| POST | `/api/assessment-blueprints` | [propose_assessment_blueprint](../packages/learning-core/src/learnflow_core/api/assessment_design.py#L36) |
| GET | `/api/assessment-blueprints/{blueprint_id}` | [get_assessment_blueprint](../packages/learning-core/src/learnflow_core/api/assessment_design.py#L81) |

### learnflow_core.api.health

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/health` | [health_check](../packages/learning-core/src/learnflow_core/api/health.py#L6) |
| GET | `/ready` | [readiness_check](../packages/learning-core/src/learnflow_core/api/health.py#L11) |

### learnflow_core.api.knowledge_library

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/knowledge-library/context` | [read_library_context](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L326) |
| GET | `/api/knowledge-library/sources` | [list_library_sources](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L109) |
| POST | `/api/knowledge-library/sources/upload` | [upload_library_source](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L198) |
| POST | `/api/knowledge-library/sources/url` | [add_library_url](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L175) |
| GET | `/api/knowledge-library/sources/{source_id}/paper` | [read_owned_source_paper](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L130) |
| POST | `/api/knowledge-library/sources/{source_id}/process` | [process_library_source](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L284) |
| POST | `/api/knowledge-library/web-evidence` | [capture_web_evidence](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L404) |

### learnflow_core.api.learner_state

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/learner-state/agent-workspace-context` | [get_agent_workspace_context](../packages/learning-core/src/learnflow_core/api/learner_state.py#L372) |
| GET | `/api/learner-state/concept-graph` | [get_personal_concept_graph](../packages/learning-core/src/learnflow_core/api/learner_state.py#L397) |
| POST | `/api/learner-state/concept-graph/statements` | [record_concept_statement](../packages/learning-core/src/learnflow_core/api/learner_state.py#L405) |
| GET | `/api/learner-state/context` | [get_learner_context](../packages/learning-core/src/learnflow_core/api/learner_state.py#L329) |
| POST | `/api/learner-state/events` | [sync_learner_event](../packages/learning-core/src/learnflow_core/api/learner_state.py#L516) |
| POST | `/api/learner-state/learning-path/personal-nodes` | [add_personal_learning_path_node](../packages/learning-core/src/learnflow_core/api/learner_state.py#L606) |
| DELETE | `/api/learner-state/learning-path/personal-nodes/{node_id}` | [remove_personal_learning_path_node](../packages/learning-core/src/learnflow_core/api/learner_state.py#L649) |
| POST | `/api/learner-state/learning-path/plans` | [commit_learning_path_plan](../packages/learning-core/src/learnflow_core/api/learner_state.py#L682) |
| DELETE | `/api/learner-state/learning-path/plans/{plan_id}` | [archive_learning_path_plan](../packages/learning-core/src/learnflow_core/api/learner_state.py#L729) |
| POST | `/api/learner-state/learning-path/status` | [set_learning_path_status](../packages/learning-core/src/learnflow_core/api/learner_state.py#L580) |
| GET | `/api/learner-state/snapshot` | [get_learner_state_snapshot](../packages/learning-core/src/learnflow_core/api/learner_state.py#L286) |
| POST | `/api/learner-state/value-claims/confirm` | [confirm_value_claim](../packages/learning-core/src/learnflow_core/api/learner_state.py#L763) |

### learnflow_core.api.learning_files

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/learning-files` | [list_learning_files](../packages/learning-core/src/learnflow_core/api/learning_files.py#L99) |
| GET | `/api/learning-files/lecture/{lecture_id}` | [get_lecture_file](../packages/learning-core/src/learnflow_core/api/learning_files.py#L159) |
| POST | `/api/learning-files/lecture/{lecture_id}/read` | [mark_lecture_read](../packages/learning-core/src/learnflow_core/api/learning_files.py#L554) |
| POST | `/api/learning-files/practice/generate` | [generate_dynamic_practice_file](../packages/learning-core/src/learnflow_core/api/learning_files.py#L283) |
| GET | `/api/learning-files/practice/{practice_ref}` | [get_practice_file](../packages/learning-core/src/learnflow_core/api/learning_files.py#L181) |
| POST | `/api/learning-files/practice/{practice_ref}/quality` | [inspect_dynamic_practice_quality](../packages/learning-core/src/learnflow_core/api/learning_files.py#L402) |
| POST | `/api/learning-files/tasks/{task_id}/generate` | [generate_task_learning_files](../packages/learning-core/src/learnflow_core/api/learning_files.py#L441) |
| POST | `/api/learning-files/{kind}/{ref}/attached` | [record_learning_file_attached](../packages/learning-core/src/learnflow_core/api/learning_files.py#L541) |
| POST | `/api/learning-files/{kind}/{ref}/opened` | [record_learning_file_opened](../packages/learning-core/src/learnflow_core/api/learning_files.py#L528) |

### learnflow_core.api.learning_task_integrations

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates` | [create_learning_task_candidate](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L81) |
| GET | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}` | [read_learning_task_candidate](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L124) |
| GET | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/audit` | [audit_learning_task_candidate](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L144) |
| POST | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/confirm` | [confirm_learning_task_candidate](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L170) |
| GET | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/evidence` | [inspect_learning_task_candidate_evidence](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L134) |
| GET | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/handoff` | [prepare_learning_task_candidate_handoff](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L157) |

### learnflow_core.api.learning_tasks

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/learning-tasks` | [list_learning_tasks](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L95) |
| POST | `/api/learning-tasks` | [create_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L131) |
| POST | `/api/learning-tasks/reorder` | [reorder_queue](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L164) |
| GET | `/api/learning-tasks/summary` | [get_queue_summary](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L61) |
| GET | `/api/learning-tasks/{task_id}` | [get_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L184) |
| PATCH | `/api/learning-tasks/{task_id}` | [update_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L196) |
| POST | `/api/learning-tasks/{task_id}/actions` | [task_action](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L219) |
| POST | `/api/learning-tasks/{task_id}/materialize` | [materialize_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L269) |
| POST | `/api/learning-tasks/{task_id}/replan` | [replan_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L244) |

### learnflow_core.api.local_agent

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/desktop/agent-profiles` | [list_agent_profiles](../packages/learning-core/src/learnflow_core/api/local_agent.py#L53) |
| POST | `/api/desktop/agent-profiles` | [create_agent_profile](../packages/learning-core/src/learnflow_core/api/local_agent.py#L70) |
| DELETE | `/api/desktop/agent-profiles/{profile_id}` | [delete_agent_profile](../packages/learning-core/src/learnflow_core/api/local_agent.py#L138) |
| PATCH | `/api/desktop/agent-profiles/{profile_id}` | [patch_agent_profile](../packages/learning-core/src/learnflow_core/api/local_agent.py#L97) |
| GET | `/api/local-agent/runs/{run_id}` | [get_local_agent_run](../packages/learning-core/src/learnflow_core/api/local_agent.py#L160) |
| POST | `/api/local-agent/runs/{run_id}/apply` | [apply_local_agent_run](../packages/learning-core/src/learnflow_core/api/local_agent.py#L206) |
| POST | `/api/local-agent/runs/{run_id}/cancel` | [cancel_local_agent_run](../packages/learning-core/src/learnflow_core/api/local_agent.py#L191) |
| GET | `/api/local-agent/runs/{run_id}/events` | [get_local_agent_run_events](../packages/learning-core/src/learnflow_core/api/local_agent.py#L173) |

### learnflow_core.api.memory

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/memory/claims/{claim_id}/feedback` | [submit_claim_feedback](../packages/learning-core/src/learnflow_core/api/memory.py#L385) |
| GET | `/api/memory/consolidations` | [get_consolidations](../packages/learning-core/src/learnflow_core/api/memory.py#L367) |
| GET | `/api/memory/graph` | [get_memory_graph](../packages/learning-core/src/learnflow_core/api/memory.py#L214) |
| GET | `/api/memory/nodes/{node_id}` | [get_memory_node](../packages/learning-core/src/learnflow_core/api/memory.py#L260) |
| GET | `/api/memory/timeline` | [get_memory_timeline](../packages/learning-core/src/learnflow_core/api/memory.py#L240) |

### learnflow_core.api.micro_learning

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/micro-learning/runs` | [list_runs](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L77) |
| POST | `/api/micro-learning/runs` | [create_run](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L54) |
| GET | `/api/micro-learning/runs/{run_id}` | [get_run](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L96) |
| POST | `/api/micro-learning/runs/{run_id}/advance` | [advance](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L109) |
| POST | `/api/micro-learning/runs/{run_id}/regenerate` | [regenerate](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L132) |
| POST | `/api/micro-learning/runs/{run_id}/sync` | [sync](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L179) |
| POST | `/api/micro-learning/runs/{run_id}/teach-back` | [teach_back](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L156) |

### learnflow_core.api.phase1

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/projects/{project_id}/reconcile` | [reconcile_sources](../packages/learning-core/src/learnflow_core/api/phase1.py#L657) |
| POST | `/api/projects/{project_id}/reconcile/apply` | [apply_reconcile](../packages/learning-core/src/learnflow_core/api/phase1.py#L737) |
| POST | `/api/projects/{project_id}/roadmap/briefs` | [backfill_briefs](../packages/learning-core/src/learnflow_core/api/phase1.py#L1088) |
| POST | `/api/projects/{project_id}/roadmap/chat` | [roadmap_chat](../packages/learning-core/src/learnflow_core/api/phase1.py#L858) |
| GET | `/api/projects/{project_id}/roadmap/history` | [get_roadmap_history](../packages/learning-core/src/learnflow_core/api/phase1.py#L993) |
| POST | `/api/projects/{project_id}/roadmap/resync` | [resync_roadmap_chunks](../packages/learning-core/src/learnflow_core/api/phase1.py#L1217) |
| POST | `/api/projects/{project_id}/sources/process-all` | [process_all_sources](../packages/learning-core/src/learnflow_core/api/phase1.py#L529) |
| POST | `/api/projects/{project_id}/sources/{source_id}/analyze` | [analyze_source_structure](../packages/learning-core/src/learnflow_core/api/phase1.py#L361) |
| POST | `/api/projects/{project_id}/sources/{source_id}/images/caption` | [start_image_captioning](../packages/learning-core/src/learnflow_core/api/phase1.py#L305) |
| POST | `/api/projects/{project_id}/sources/{source_id}/process` | [process_source](../packages/learning-core/src/learnflow_core/api/phase1.py#L166) |
| PUT | `/api/projects/{project_id}/sources/{source_id}/role` | [set_source_role](../packages/learning-core/src/learnflow_core/api/phase1.py#L636) |
| POST | `/api/projects/{project_id}/sources/{source_id}/summarize` | [summarize_source_files](../packages/learning-core/src/learnflow_core/api/phase1.py#L393) |
| GET | `/api/sources/{source_id}/files/{file_path}` | [serve_source_file](../packages/learning-core/src/learnflow_core/api/phase1.py#L286) |

### learnflow_core.api.phase2

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/animations/generate` | [generate_animation](../packages/learning-core/src/learnflow_core/api/phase2.py#L402) |
| GET | `/api/animations/{animation_id}` | [get_animation](../packages/learning-core/src/learnflow_core/api/phase2.py#L420) |
| DELETE | `/api/artifact-annotations/{annotation_id}` | [delete_artifact_annotation](../packages/learning-core/src/learnflow_core/api/phase2.py#L755) |
| PUT | `/api/artifact-annotations/{annotation_id}` | [update_artifact_annotation](../packages/learning-core/src/learnflow_core/api/phase2.py#L742) |
| GET | `/api/artifacts/{artifact_type}/{artifact_id}/annotations` | [list_artifact_annotations](../packages/learning-core/src/learnflow_core/api/phase2.py#L685) |
| POST | `/api/artifacts/{artifact_type}/{artifact_id}/annotations` | [create_artifact_annotation](../packages/learning-core/src/learnflow_core/api/phase2.py#L700) |
| POST | `/api/checkpoints/{checkpoint_id}/ask` | [ask_question](../packages/learning-core/src/learnflow_core/api/phase2.py#L576) |
| POST | `/api/checkpoints/{checkpoint_id}/concept-graph/generate` | [generate_concept_graph](../packages/learning-core/src/learnflow_core/api/phase2.py#L443) |
| GET | `/api/checkpoints/{checkpoint_id}/concept-graph/task` | [get_concept_graph_task](../packages/learning-core/src/learnflow_core/api/phase2.py#L482) |
| GET | `/api/checkpoints/{checkpoint_id}/lecture` | [get_lecture](../packages/learning-core/src/learnflow_core/api/phase2.py#L342) |
| PUT | `/api/checkpoints/{checkpoint_id}/lecture` | [put_lecture](../packages/learning-core/src/learnflow_core/api/phase2.py#L320) |
| GET | `/api/checkpoints/{checkpoint_id}/lecture/generate` | [generate_lecture_stream](../packages/learning-core/src/learnflow_core/api/phase2.py#L111) |
| POST | `/api/checkpoints/{checkpoint_id}/lecture/generate` | [generate_lecture_task](../packages/learning-core/src/learnflow_core/api/phase2.py#L33) |
| POST | `/api/checkpoints/{checkpoint_id}/lecture/rollback` | [rollback_lecture](../packages/learning-core/src/learnflow_core/api/phase2.py#L527) |
| POST | `/api/checkpoints/{checkpoint_id}/lecture/save` | [save_lecture_compat](../packages/learning-core/src/learnflow_core/api/phase2.py#L331) |
| GET | `/api/checkpoints/{checkpoint_id}/lecture/task` | [get_lecture_task](../packages/learning-core/src/learnflow_core/api/phase2.py#L86) |
| GET | `/api/checkpoints/{checkpoint_id}/lecture/versions` | [list_lecture_versions](../packages/learning-core/src/learnflow_core/api/phase2.py#L504) |
| GET | `/api/checkpoints/{checkpoint_id}/notes` | [list_notes](../packages/learning-core/src/learnflow_core/api/phase2.py#L777) |
| POST | `/api/checkpoints/{checkpoint_id}/notes` | [create_note](../packages/learning-core/src/learnflow_core/api/phase2.py#L792) |
| DELETE | `/api/notes/{note_id}` | [delete_note](../packages/learning-core/src/learnflow_core/api/phase2.py#L825) |
| PUT | `/api/notes/{note_id}` | [update_note](../packages/learning-core/src/learnflow_core/api/phase2.py#L815) |

### learnflow_core.api.phase3

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/checkpoints/{checkpoint_id}/concepts` | [list_concepts](../packages/learning-core/src/learnflow_core/api/phase3.py#L412) |
| POST | `/api/checkpoints/{checkpoint_id}/concepts/generate` | [generate_concepts](../packages/learning-core/src/learnflow_core/api/phase3.py#L437) |
| GET | `/api/checkpoints/{checkpoint_id}/concepts/task` | [get_concept_task](../packages/learning-core/src/learnflow_core/api/phase3.py#L476) |
| POST | `/api/checkpoints/{checkpoint_id}/concepts/{question_id}/explain` | [explain_concept](../packages/learning-core/src/learnflow_core/api/phase3.py#L496) |
| POST | `/api/checkpoints/{checkpoint_id}/concepts/{question_id}/submit` | [submit_concept](../packages/learning-core/src/learnflow_core/api/phase3.py#L536) |
| GET | `/api/checkpoints/{checkpoint_id}/exercises` | [list_exercises](../packages/learning-core/src/learnflow_core/api/phase3.py#L57) |
| POST | `/api/checkpoints/{checkpoint_id}/exercises` | [create_exercise](../packages/learning-core/src/learnflow_core/api/phase3.py#L84) |
| POST | `/api/checkpoints/{checkpoint_id}/exercises/generate` | [generate_exercises](../packages/learning-core/src/learnflow_core/api/phase3.py#L698) |
| GET | `/api/checkpoints/{checkpoint_id}/exercises/task` | [get_exercise_task](../packages/learning-core/src/learnflow_core/api/phase3.py#L738) |
| POST | `/api/code/ask` | [ask_code_question](../packages/learning-core/src/learnflow_core/api/phase3.py#L324) |
| GET | `/api/exercises/{exercise_id}` | [get_exercise](../packages/learning-core/src/learnflow_core/api/phase3.py#L133) |
| GET | `/api/exercises/{exercise_id}/draft` | [get_exercise_draft](../packages/learning-core/src/learnflow_core/api/phase3.py#L151) |
| PUT | `/api/exercises/{exercise_id}/draft` | [put_exercise_draft](../packages/learning-core/src/learnflow_core/api/phase3.py#L185) |
| GET | `/api/exercises/{exercise_id}/env` | [exercise_env_status](../packages/learning-core/src/learnflow_core/api/phase3.py#L270) |
| POST | `/api/exercises/{exercise_id}/review` | [review_code](../packages/learning-core/src/learnflow_core/api/phase3.py#L293) |
| POST | `/api/exercises/{exercise_id}/run` | [run_code](../packages/learning-core/src/learnflow_core/api/phase3.py#L219) |
| POST | `/api/exercises/{exercise_id}/submit` | [submit_exercise](../packages/learning-core/src/learnflow_core/api/phase3.py#L758) |
| POST | `/api/projects/{project_id}/embeddings/index` | [index_embeddings](../packages/learning-core/src/learnflow_core/api/phase3.py#L371) |

### learnflow_core.api.platform

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/platform` | [platform_manifest](../packages/learning-core/src/learnflow_core/api/platform.py#L9) |

### learnflow_core.api.profile

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/profile` | [get_profile](../packages/learning-core/src/learnflow_core/api/profile.py#L38) |
| PATCH | `/api/profile` | [update_profile](../packages/learning-core/src/learnflow_core/api/profile.py#L56) |
| GET | `/api/profile/growth` | [get_growth](../packages/learning-core/src/learnflow_core/api/profile.py#L114) |
| GET | `/api/profile/journey` | [get_journey](../packages/learning-core/src/learnflow_core/api/profile.py#L158) |
| GET | `/api/profile/memories` | [get_memories](../packages/learning-core/src/learnflow_core/api/profile.py#L106) |
| POST | `/api/profile/memories/{memory_id}/archive` | [archive_memory](../packages/learning-core/src/learnflow_core/api/profile.py#L124) |
| POST | `/api/profile/memories/{memory_id}/restore` | [restore_memory](../packages/learning-core/src/learnflow_core/api/profile.py#L142) |

### learnflow_core.api.projects

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/projects` | [list_projects](../packages/learning-core/src/learnflow_core/api/projects.py#L60) |
| POST | `/api/projects` | [create_project](../packages/learning-core/src/learnflow_core/api/projects.py#L31) |
| DELETE | `/api/projects/{project_id}` | [delete_project](../packages/learning-core/src/learnflow_core/api/projects.py#L108) |
| GET | `/api/projects/{project_id}` | [get_project](../packages/learning-core/src/learnflow_core/api/projects.py#L99) |
| GET | `/api/projects/{project_id}/chunks` | [list_chunks](../packages/learning-core/src/learnflow_core/api/projects.py#L284) |
| GET | `/api/projects/{project_id}/roadmap` | [get_roadmap](../packages/learning-core/src/learnflow_core/api/projects.py#L305) |
| GET | `/api/projects/{project_id}/sources` | [list_sources](../packages/learning-core/src/learnflow_core/api/projects.py#L260) |
| POST | `/api/projects/{project_id}/sources` | [add_source](../packages/learning-core/src/learnflow_core/api/projects.py#L129) |
| POST | `/api/projects/{project_id}/sources/upload` | [upload_source](../packages/learning-core/src/learnflow_core/api/projects.py#L159) |

### learnflow_core.api.remediation

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/checkpoints/{checkpoint_id}/remediation-cases` | [list_remediation_cases](../packages/learning-core/src/learnflow_core/api/remediation.py#L38) |
| GET | `/api/remediation/{case_id}` | [get_remediation_case](../packages/learning-core/src/learnflow_core/api/remediation.py#L29) |
| POST | `/api/remediation/{case_id}/explanations` | [change_remediation_explanation](../packages/learning-core/src/learnflow_core/api/remediation.py#L52) |
| POST | `/api/remediation/{case_id}/variant` | [create_remediation_variant](../packages/learning-core/src/learnflow_core/api/remediation.py#L70) |
| POST | `/api/remediation/{case_id}/variant/submit` | [evaluate_remediation_variant](../packages/learning-core/src/learnflow_core/api/remediation.py#L84) |

### learnflow_core.api.review

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/review/agent-context` | [review_agent_context](../packages/learning-core/src/learnflow_core/api/review.py#L461) |
| GET | `/api/review/items` | [list_review_items](../packages/learning-core/src/learnflow_core/api/review.py#L391) |
| GET | `/api/review/items/{schedule_id}` | [get_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L525) |
| POST | `/api/review/items/{schedule_id}/defer` | [defer_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L974) |
| GET | `/api/review/items/{schedule_id}/history` | [get_review_history](../packages/learning-core/src/learnflow_core/api/review.py#L535) |
| POST | `/api/review/items/{schedule_id}/reflections` | [record_review_reflection](../packages/learning-core/src/learnflow_core/api/review.py#L579) |
| POST | `/api/review/items/{schedule_id}/resume` | [resume_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L1029) |
| POST | `/api/review/items/{schedule_id}/submit` | [submit_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L677) |
| POST | `/api/review/items/{schedule_id}/suspend` | [suspend_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L1004) |
| GET | `/api/review/summary` | [review_summary](../packages/learning-core/src/learnflow_core/api/review.py#L357) |

### learnflow_core.api.settings

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/settings` | [get_settings](../packages/learning-core/src/learnflow_core/api/settings.py#L167) |
| PUT | `/api/settings` | [save_settings](../packages/learning-core/src/learnflow_core/api/settings.py#L297) |
| POST | `/api/settings/test` | [test_connection](../packages/learning-core/src/learnflow_core/api/settings.py#L202) |
| POST | `/api/settings/test-embedding` | [test_embedding](../packages/learning-core/src/learnflow_core/api/settings.py#L261) |
| POST | `/api/settings/test-vision` | [test_vision](../packages/learning-core/src/learnflow_core/api/settings.py#L346) |

### learnflow_core.api.tasks

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/tasks/{task_id}` | [get_task_status](../packages/learning-core/src/learnflow_core/api/tasks.py#L39) |
| POST | `/api/tasks/{task_id}/cancel` | [cancel_task](../packages/learning-core/src/learnflow_core/api/tasks.py#L49) |
| GET | `/api/tasks/{task_id}/events` | [task_events](../packages/learning-core/src/learnflow_core/api/tasks.py#L69) |

### learnflow_core.api.workspace

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/checkpoints/{checkpoint_id}/workspace/artifacts` | [get_checkpoint_workspace_artifacts](../packages/learning-core/src/learnflow_core/api/workspace.py#L115) |
| GET | `/api/projects/{project_id}/workspace/agent-files/{file_path}` | [get_workspace_file_for_checkpoint_tutor](../packages/learning-core/src/learnflow_core/api/workspace.py#L280) |
| GET | `/api/projects/{project_id}/workspace/files/{file_path}` | [get_workspace_file](../packages/learning-core/src/learnflow_core/api/workspace.py#L227) |
| PUT | `/api/projects/{project_id}/workspace/files/{file_path}` | [put_workspace_file](../packages/learning-core/src/learnflow_core/api/workspace.py#L370) |
| POST | `/api/projects/{project_id}/workspace/link` | [link_workspace](../packages/learning-core/src/learnflow_core/api/workspace.py#L137) |
| POST | `/api/projects/{project_id}/workspace/open` | [open_workspace_item](../packages/learning-core/src/learnflow_core/api/workspace.py#L339) |
| GET | `/api/projects/{project_id}/workspace/operations` | [list_workspace_operations](../packages/learning-core/src/learnflow_core/api/workspace.py#L535) |
| POST | `/api/projects/{project_id}/workspace/operations/propose` | [propose_workspace_operation](../packages/learning-core/src/learnflow_core/api/workspace.py#L441) |
| POST | `/api/projects/{project_id}/workspace/operations/{operation_id}/confirm` | [confirm_workspace_operation](../packages/learning-core/src/learnflow_core/api/workspace.py#L562) |
| GET | `/api/projects/{project_id}/workspace/previews/{file_path}` | [preview_workspace_file](../packages/learning-core/src/learnflow_core/api/workspace.py#L250) |
| POST | `/api/projects/{project_id}/workspace/reveal` | [reveal_workspace_item](../packages/learning-core/src/learnflow_core/api/workspace.py#L305) |
| GET | `/api/projects/{project_id}/workspace/tree` | [workspace_tree](../packages/learning-core/src/learnflow_core/api/workspace.py#L203) |


## Desktop Node Tutor (dev/preview)

### tutorProxy

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/tutor` | [middleware](../apps/desktop/frontend/vite.config.ts#L253) |
| GET | `/api/tutor/status` | [middleware](../apps/desktop/frontend/vite.config.ts#L231) |
| POST | `/api/tutor/stream` | [middleware](../apps/desktop/frontend/vite.config.ts#L252) |


## Desktop Tauri IPC

### native bridge

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| invoke | `capture_desktop_pet_ocr` | [capture_desktop_pet_ocr](../apps/desktop/desktop/src-tauri/src/lib.rs#L492) |
| invoke | `capture_desktop_pet_selection` | [capture_desktop_pet_selection](../apps/desktop/desktop/src-tauri/src/lib.rs#L540) |
| invoke | `clear_desktop_auth_token` | [clear_desktop_auth_token](../apps/desktop/desktop/src-tauri/src/lib.rs#L1088) |
| invoke | `close_desktop_pet` | [close_desktop_pet](../apps/desktop/desktop/src-tauri/src/lib.rs#L721) |
| invoke | `desktop_pet_active_session` | [desktop_pet_active_session](../apps/desktop/desktop/src-tauri/src/lib.rs#L1073) |
| invoke | `desktop_pet_auth_token` | [desktop_pet_auth_token](../apps/desktop/desktop/src-tauri/src/lib.rs#L1114) |
| invoke | `desktop_pet_preferences` | [desktop_pet_preferences](../apps/desktop/desktop/src-tauri/src/lib.rs#L583) |
| invoke | `desktop_runtime_config` | [desktop_runtime_config](../apps/desktop/desktop/src-tauri/src/lib.rs#L159) |
| invoke | `open_desktop_main_path` | [open_desktop_main_path](../apps/desktop/desktop/src-tauri/src/lib.rs#L948) |
| invoke | `open_external_url` | [open_external_url](../apps/desktop/desktop/src-tauri/src/lib.rs#L1016) |
| invoke | `open_platform_workspace` | [open_platform_workspace](../apps/desktop/desktop/src-tauri/src/lib.rs#L1008) |
| invoke | `reset_desktop_pet_geometry` | [reset_desktop_pet_geometry](../apps/desktop/desktop/src-tauri/src/lib.rs#L692) |
| invoke | `restore_desktop_pet_geometry` | [restore_desktop_pet_geometry](../apps/desktop/desktop/src-tauri/src/lib.rs#L661) |
| invoke | `store_desktop_pet_capability` | [store_desktop_pet_capability](../apps/desktop/desktop/src-tauri/src/lib.rs#L1027) |
| invoke | `sync_desktop_pet_session` | [sync_desktop_pet_session](../apps/desktop/desktop/src-tauri/src/lib.rs#L1049) |
| invoke | `update_desktop_pet_preferences` | [update_desktop_pet_preferences](../apps/desktop/desktop/src-tauri/src/lib.rs#L598) |


## Role Atlas / Graph Hub

### agent

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/agent` | [POST](../apps/role-atlas/app/api/agent/route.ts#L54) |

### auth

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/auth/session` | [GET](../apps/role-atlas/app/api/auth/session/route.ts#L8) |

### build-runs

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/build-runs` | [POST](../apps/role-atlas/app/api/build-runs/route.ts#L59) |
| POST | `/api/build-runs/enrich` | [POST](../apps/role-atlas/app/api/build-runs/enrich/route.ts#L55) |

### conversations

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/conversations/{conversationId}/messages` | [GET](../apps/role-atlas/app/api/conversations/[conversationId]/messages/route.ts#L5) |

### hub

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/hub/search` | [GET](../apps/role-atlas/app/api/hub/search/route.ts#L5) |

### integrations

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/integrations/learnflow/gateway` | [POST](../apps/role-atlas/app/api/integrations/learnflow/gateway/route.ts#L10) |
| POST | `/api/integrations/learnflow/launch` | [POST](../apps/role-atlas/app/api/integrations/learnflow/launch/route.ts#L17) |

### jobs

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/jobs/{jobId}` | [GET](../apps/role-atlas/app/api/jobs/[jobId]/route.ts#L5) |

### navigation

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/navigation/role-atlas` | [GET](../apps/role-atlas/app/api/navigation/role-atlas/route.ts#L3) |

### packages

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/packages/import` | [POST](../apps/role-atlas/app/api/packages/import/route.ts#L5) |

### projects

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/projects` | [GET](../apps/role-atlas/app/api/projects/route.ts#L16) |
| POST | `/api/projects` | [POST](../apps/role-atlas/app/api/projects/route.ts#L25) |
| GET | `/api/projects/trash` | [GET](../apps/role-atlas/app/api/projects/trash/route.ts#L4) |
| DELETE | `/api/projects/{projectId}` | [DELETE](../apps/role-atlas/app/api/projects/[projectId]/route.ts#L6) |
| GET | `/api/projects/{projectId}` | [GET](../apps/role-atlas/app/api/projects/[projectId]/route.ts#L18) |
| PATCH | `/api/projects/{projectId}` | [PATCH](../apps/role-atlas/app/api/projects/[projectId]/route.ts#L10) |
| POST | `/api/projects/{projectId}/conversations` | [POST](../apps/role-atlas/app/api/projects/[projectId]/conversations/route.ts#L12) |
| GET | `/api/projects/{projectId}/diffs` | [GET](../apps/role-atlas/app/api/projects/[projectId]/diffs/route.ts#L5) |
| DELETE | `/api/projects/{projectId}/tags` | [DELETE](../apps/role-atlas/app/api/projects/[projectId]/tags/route.ts#L29) |
| GET | `/api/projects/{projectId}/tags` | [GET](../apps/role-atlas/app/api/projects/[projectId]/tags/route.ts#L12) |
| POST | `/api/projects/{projectId}/tags` | [POST](../apps/role-atlas/app/api/projects/[projectId]/tags/route.ts#L17) |
| GET | `/api/projects/{projectId}/versions` | [GET](../apps/role-atlas/app/api/projects/[projectId]/versions/route.ts#L12) |
| POST | `/api/projects/{projectId}/versions` | [POST](../apps/role-atlas/app/api/projects/[projectId]/versions/route.ts#L26) |

### providers

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/providers/test` | [POST](../apps/role-atlas/app/api/providers/test/route.ts#L13) |

### reference-migrations

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/reference-migrations` | [GET](../apps/role-atlas/app/api/reference-migrations/route.ts#L5) |

### registry

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/registry` | [GET](../apps/role-atlas/app/api/registry/route.ts#L7) |
| PATCH | `/api/registry` | [PATCH](../apps/role-atlas/app/api/registry/route.ts#L24) |
| GET | `/api/registry/{packageLineId}` | [GET](../apps/role-atlas/app/api/registry/[packageLineId]/route.ts#L5) |

### releases

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/releases` | [GET](../apps/role-atlas/app/api/releases/route.ts#L45) |
| PATCH | `/api/releases` | [PATCH](../apps/role-atlas/app/api/releases/route.ts#L64) |
| POST | `/api/releases` | [POST](../apps/role-atlas/app/api/releases/route.ts#L51) |
| GET | `/api/releases/{releaseId}/export` | [GET](../apps/role-atlas/app/api/releases/[releaseId]/export/route.ts#L6) |

### risk-runs

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/risk-runs` | [GET](../apps/role-atlas/app/api/risk-runs/route.ts#L49) |
| POST | `/api/risk-runs` | [POST](../apps/role-atlas/app/api/risk-runs/route.ts#L59) |

### role-tools

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/role-tools` | [GET](../apps/role-atlas/app/api/role-tools/route.ts#L10) |
| POST | `/api/role-tools` | [POST](../apps/role-atlas/app/api/role-tools/route.ts#L14) |

### runtime-config

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/runtime-config` | [GET](../apps/role-atlas/app/api/runtime-config/route.ts#L6) |

### search

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/search/providers/test` | [POST](../apps/role-atlas/app/api/search/providers/test/route.ts#L16) |

### snapshot-iterations

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/snapshot-iterations` | [GET](../apps/role-atlas/app/api/snapshot-iterations/route.ts#L65) |
| POST | `/api/snapshot-iterations` | [POST](../apps/role-atlas/app/api/snapshot-iterations/route.ts#L75) |

### snapshots

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/snapshots/resolve` | [GET](../apps/role-atlas/app/api/snapshots/resolve/route.ts#L5) |

### work-process

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/work-process` | [GET](../apps/role-atlas/app/api/work-process/route.ts#L6) |

### workspace-upgrades

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/workspace-upgrades` | [POST](../apps/role-atlas/app/api/workspace-upgrades/route.ts#L76) |

### workspaces

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/workspaces/ingest` | [GET](../apps/role-atlas/app/api/workspaces/ingest/route.ts#L23) |
| POST | `/api/workspaces/ingest` | [POST](../apps/role-atlas/app/api/workspaces/ingest/route.ts#L35) |


## Web FastAPI

### app.api.agent

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/agent/actions/{action_id}` | [get_action](../backend/app/api/agent.py#L1047) |
| POST | `/api/agent/actions/{action_id}/cancel` | [cancel_action](../backend/app/api/agent.py#L1124) |
| POST | `/api/agent/actions/{action_id}/confirm` | [confirm_action](../backend/app/api/agent.py#L1074) |
| GET | `/api/agent/modes` | [list_chat_modes](../backend/app/api/agent.py#L208) |
| GET | `/api/agent/project-proposals/{proposal_id}` | [get_project_proposal](../backend/app/api/agent.py#L888) |
| PATCH | `/api/agent/project-proposals/{proposal_id}` | [patch_project_proposal](../backend/app/api/agent.py#L918) |
| POST | `/api/agent/project-proposals/{proposal_id}/accept` | [accept_project_proposal](../backend/app/api/agent.py#L940) |
| POST | `/api/agent/project-proposals/{proposal_id}/dismiss` | [dismiss_project_proposal](../backend/app/api/agent.py#L996) |
| POST | `/api/agent/project-proposals/{proposal_id}/refresh-sources` | [refresh_project_proposal_sources](../backend/app/api/agent.py#L1036) |
| POST | `/api/agent/project-proposals/{proposal_id}/reopen` | [reopen_project_proposal](../backend/app/api/agent.py#L1021) |
| GET | `/api/agent/projects/{project_id}/accepted-proposal` | [get_accepted_project_proposal](../backend/app/api/agent.py#L898) |
| POST | `/api/agent/role-package-launches/consume` | [consume_role_package_launch](../backend/app/api/agent.py#L615) |
| GET | `/api/agent/sessions` | [list_sessions](../backend/app/api/agent.py#L216) |
| POST | `/api/agent/sessions` | [create_or_resume_session](../backend/app/api/agent.py#L545) |
| DELETE | `/api/agent/sessions/{session_id}` | [delete_session](../backend/app/api/agent.py#L259) |
| GET | `/api/agent/sessions/{session_id}` | [get_session](../backend/app/api/agent.py#L799) |
| POST | `/api/agent/sessions/{session_id}/skill-runs` | [start_learning_skill_run](../backend/app/api/agent.py#L297) |
| POST | `/api/agent/sessions/{session_id}/skill-runs/{run_id}/actions` | [update_learning_skill_run](../backend/app/api/agent.py#L372) |
| POST | `/api/agent/sessions/{session_id}/skill-runs/{run_id}/turns` | [advance_learning_skill_turn](../backend/app/api/agent.py#L425) |
| POST | `/api/agent/sessions/{session_id}/turns` | [tutor_turn](../backend/app/api/agent.py#L809) |
| POST | `/api/agent/sessions/{session_id}/visual-plans` | [plan_visual_for_desktop](../backend/app/api/agent.py#L853) |
| PUT | `/api/agent/sessions/{session_id}/vnext` | [sync_vnext_session](../backend/app/api/agent.py#L746) |
| GET | `/api/agent/skills` | [list_learning_skills](../backend/app/api/agent.py#L200) |
| POST | `/api/learning-events` | [create_learning_event](../backend/app/api/agent.py#L1145) |

### app.api.auth

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/admin/accounts` | [admin_accounts](../backend/app/api/auth.py#L504) |
| GET | `/api/auth/csrf` | [csrf_token](../backend/app/api/auth.py#L341) |
| POST | `/api/auth/login` | [login](../backend/app/api/auth.py#L282) |
| POST | `/api/auth/logout` | [logout](../backend/app/api/auth.py#L467) |
| GET | `/api/auth/me` | [me](../backend/app/api/auth.py#L483) |
| DELETE | `/api/auth/model-credential` | [delete_model_credential](../backend/app/api/auth.py#L372) |
| GET | `/api/auth/model-credential` | [get_model_credential](../backend/app/api/auth.py#L354) |
| PUT | `/api/auth/model-credential` | [put_model_credential](../backend/app/api/auth.py#L363) |
| POST | `/api/auth/model-credential/internal/resolve` | [resolve_model_credential_for_runtime](../backend/app/api/auth.py#L391) |
| POST | `/api/auth/model-credential/test` | [test_model_credential](../backend/app/api/auth.py#L380) |
| POST | `/api/auth/password` | [change_password](../backend/app/api/auth.py#L420) |
| POST | `/api/auth/register` | [register](../backend/app/api/auth.py#L182) |
| GET | `/api/auth/status` | [auth_status](../backend/app/api/auth.py#L492) |
| POST | `/api/demo/login` | [competition_demo_login](../backend/app/api/auth.py#L568) |
| GET | `/api/demo/manifest` | [competition_demo_manifest](../backend/app/api/auth.py#L595) |
| GET | `/api/demo/status` | [competition_demo_status](../backend/app/api/auth.py#L563) |
| GET | `/api/dev/accounts` | [list_dev_accounts](../backend/app/api/auth.py#L616) |
| POST | `/api/dev/accounts/{account_id}/login` | [dev_login](../backend/app/api/auth.py#L645) |

### app.api.ecosystem

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/ecosystem/capabilities` | [capabilities](../backend/app/api/ecosystem.py#L86) |
| POST | `/api/ecosystem/dispatch` | [dispatch](../backend/app/api/ecosystem.py#L100) |
| GET | `/api/ecosystem/learning-path` | [learning_path](../backend/app/api/ecosystem.py#L107) |
| POST | `/api/ecosystem/learning-path/commit` | [commit](../backend/app/api/ecosystem.py#L117) |
| POST | `/api/ecosystem/learning-path/resolve` | [resolve](../backend/app/api/ecosystem.py#L112) |

### app.api.vnext_projects

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/vnext-projects` | [list_vnext_projects](../backend/app/api/vnext_projects.py#L340) |
| POST | `/api/vnext-projects` | [create_vnext_project](../backend/app/api/vnext_projects.py#L353) |
| GET | `/api/vnext-projects/{project_id}` | [get_vnext_project](../backend/app/api/vnext_projects.py#L382) |
| GET | `/api/vnext-projects/{project_id}/agent-context` | [get_project_agent_context](../backend/app/api/vnext_projects.py#L717) |
| GET | `/api/vnext-projects/{project_id}/knowledge-baseline` | [read_project_knowledge_baseline](../backend/app/api/vnext_projects.py#L782) |
| POST | `/api/vnext-projects/{project_id}/knowledge-baseline/proposals` | [propose_project_knowledge_baseline](../backend/app/api/vnext_projects.py#L939) |
| POST | `/api/vnext-projects/{project_id}/knowledge-baseline/{packet_id}/confirm` | [confirm_project_knowledge_baseline](../backend/app/api/vnext_projects.py#L980) |
| POST | `/api/vnext-projects/{project_id}/knowledge-sources/promotions` | [promote_project_knowledge_source](../backend/app/api/vnext_projects.py#L797) |
| PUT | `/api/vnext-projects/{project_id}/roadmap` | [revise_vnext_roadmap](../backend/app/api/vnext_projects.py#L473) |
| POST | `/api/vnext-projects/{project_id}/roadmap/apply` | [apply_vnext_roadmap](../backend/app/api/vnext_projects.py#L394) |
| POST | `/api/vnext-projects/{project_id}/sessions` | [create_project_free_session](../backend/app/api/vnext_projects.py#L658) |
| DELETE | `/api/vnext-projects/{project_id}/sources/{source_id}` | [remove_project_source](../backend/app/api/vnext_projects.py#L684) |
| POST | `/api/vnext-projects/{project_id}/sources/{source_id}/health` | [update_project_source_health](../backend/app/api/vnext_projects.py#L1040) |

### learnflow_core.api.architecture

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/architecture/registry` | [get_architecture_registry](../packages/learning-core/src/learnflow_core/api/architecture.py#L12) |
| GET | `/api/architecture/validate` | [validate_architecture_registry](../packages/learning-core/src/learnflow_core/api/architecture.py#L17) |

### learnflow_core.api.assessment_design

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/assessment-blueprints` | [list_assessment_blueprints](../packages/learning-core/src/learnflow_core/api/assessment_design.py#L57) |
| POST | `/api/assessment-blueprints` | [propose_assessment_blueprint](../packages/learning-core/src/learnflow_core/api/assessment_design.py#L36) |
| GET | `/api/assessment-blueprints/{blueprint_id}` | [get_assessment_blueprint](../packages/learning-core/src/learnflow_core/api/assessment_design.py#L81) |

### learnflow_core.api.health

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/health` | [health_check](../packages/learning-core/src/learnflow_core/api/health.py#L6) |
| GET | `/ready` | [readiness_check](../packages/learning-core/src/learnflow_core/api/health.py#L11) |

### learnflow_core.api.knowledge_library

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/knowledge-library/context` | [read_library_context](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L326) |
| GET | `/api/knowledge-library/sources` | [list_library_sources](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L109) |
| POST | `/api/knowledge-library/sources/upload` | [upload_library_source](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L198) |
| POST | `/api/knowledge-library/sources/url` | [add_library_url](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L175) |
| GET | `/api/knowledge-library/sources/{source_id}/paper` | [read_owned_source_paper](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L130) |
| POST | `/api/knowledge-library/sources/{source_id}/process` | [process_library_source](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L284) |
| POST | `/api/knowledge-library/web-evidence` | [capture_web_evidence](../packages/learning-core/src/learnflow_core/api/knowledge_library.py#L404) |

### learnflow_core.api.learner_state

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/learner-state/agent-workspace-context` | [get_agent_workspace_context](../packages/learning-core/src/learnflow_core/api/learner_state.py#L372) |
| GET | `/api/learner-state/concept-graph` | [get_personal_concept_graph](../packages/learning-core/src/learnflow_core/api/learner_state.py#L397) |
| POST | `/api/learner-state/concept-graph/statements` | [record_concept_statement](../packages/learning-core/src/learnflow_core/api/learner_state.py#L405) |
| GET | `/api/learner-state/context` | [get_learner_context](../packages/learning-core/src/learnflow_core/api/learner_state.py#L329) |
| POST | `/api/learner-state/events` | [sync_learner_event](../packages/learning-core/src/learnflow_core/api/learner_state.py#L516) |
| POST | `/api/learner-state/learning-path/personal-nodes` | [add_personal_learning_path_node](../packages/learning-core/src/learnflow_core/api/learner_state.py#L606) |
| DELETE | `/api/learner-state/learning-path/personal-nodes/{node_id}` | [remove_personal_learning_path_node](../packages/learning-core/src/learnflow_core/api/learner_state.py#L649) |
| POST | `/api/learner-state/learning-path/plans` | [commit_learning_path_plan](../packages/learning-core/src/learnflow_core/api/learner_state.py#L682) |
| DELETE | `/api/learner-state/learning-path/plans/{plan_id}` | [archive_learning_path_plan](../packages/learning-core/src/learnflow_core/api/learner_state.py#L729) |
| POST | `/api/learner-state/learning-path/status` | [set_learning_path_status](../packages/learning-core/src/learnflow_core/api/learner_state.py#L580) |
| GET | `/api/learner-state/snapshot` | [get_learner_state_snapshot](../packages/learning-core/src/learnflow_core/api/learner_state.py#L286) |
| POST | `/api/learner-state/value-claims/confirm` | [confirm_value_claim](../packages/learning-core/src/learnflow_core/api/learner_state.py#L763) |

### learnflow_core.api.learning_files

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/learning-files` | [list_learning_files](../packages/learning-core/src/learnflow_core/api/learning_files.py#L99) |
| GET | `/api/learning-files/lecture/{lecture_id}` | [get_lecture_file](../packages/learning-core/src/learnflow_core/api/learning_files.py#L159) |
| POST | `/api/learning-files/lecture/{lecture_id}/read` | [mark_lecture_read](../packages/learning-core/src/learnflow_core/api/learning_files.py#L554) |
| POST | `/api/learning-files/practice/generate` | [generate_dynamic_practice_file](../packages/learning-core/src/learnflow_core/api/learning_files.py#L283) |
| GET | `/api/learning-files/practice/{practice_ref}` | [get_practice_file](../packages/learning-core/src/learnflow_core/api/learning_files.py#L181) |
| POST | `/api/learning-files/practice/{practice_ref}/quality` | [inspect_dynamic_practice_quality](../packages/learning-core/src/learnflow_core/api/learning_files.py#L402) |
| POST | `/api/learning-files/tasks/{task_id}/generate` | [generate_task_learning_files](../packages/learning-core/src/learnflow_core/api/learning_files.py#L441) |
| POST | `/api/learning-files/{kind}/{ref}/attached` | [record_learning_file_attached](../packages/learning-core/src/learnflow_core/api/learning_files.py#L541) |
| POST | `/api/learning-files/{kind}/{ref}/opened` | [record_learning_file_opened](../packages/learning-core/src/learnflow_core/api/learning_files.py#L528) |

### learnflow_core.api.learning_task_integrations

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates` | [create_learning_task_candidate](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L81) |
| GET | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}` | [read_learning_task_candidate](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L124) |
| GET | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/audit` | [audit_learning_task_candidate](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L144) |
| POST | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/confirm` | [confirm_learning_task_candidate](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L170) |
| GET | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/evidence` | [inspect_learning_task_candidate_evidence](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L134) |
| GET | `/api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/handoff` | [prepare_learning_task_candidate_handoff](../packages/learning-core/src/learnflow_core/api/learning_task_integrations.py#L157) |

### learnflow_core.api.learning_tasks

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/learning-tasks` | [list_learning_tasks](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L95) |
| POST | `/api/learning-tasks` | [create_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L131) |
| POST | `/api/learning-tasks/reorder` | [reorder_queue](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L164) |
| GET | `/api/learning-tasks/summary` | [get_queue_summary](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L61) |
| GET | `/api/learning-tasks/{task_id}` | [get_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L184) |
| PATCH | `/api/learning-tasks/{task_id}` | [update_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L196) |
| POST | `/api/learning-tasks/{task_id}/actions` | [task_action](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L219) |
| POST | `/api/learning-tasks/{task_id}/materialize` | [materialize_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L269) |
| POST | `/api/learning-tasks/{task_id}/replan` | [replan_task](../packages/learning-core/src/learnflow_core/api/learning_tasks.py#L244) |

### learnflow_core.api.local_agent

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/desktop/agent-profiles` | [list_agent_profiles](../packages/learning-core/src/learnflow_core/api/local_agent.py#L53) |
| POST | `/api/desktop/agent-profiles` | [create_agent_profile](../packages/learning-core/src/learnflow_core/api/local_agent.py#L70) |
| DELETE | `/api/desktop/agent-profiles/{profile_id}` | [delete_agent_profile](../packages/learning-core/src/learnflow_core/api/local_agent.py#L138) |
| PATCH | `/api/desktop/agent-profiles/{profile_id}` | [patch_agent_profile](../packages/learning-core/src/learnflow_core/api/local_agent.py#L97) |
| GET | `/api/local-agent/runs/{run_id}` | [get_local_agent_run](../packages/learning-core/src/learnflow_core/api/local_agent.py#L160) |
| POST | `/api/local-agent/runs/{run_id}/apply` | [apply_local_agent_run](../packages/learning-core/src/learnflow_core/api/local_agent.py#L206) |
| POST | `/api/local-agent/runs/{run_id}/cancel` | [cancel_local_agent_run](../packages/learning-core/src/learnflow_core/api/local_agent.py#L191) |
| GET | `/api/local-agent/runs/{run_id}/events` | [get_local_agent_run_events](../packages/learning-core/src/learnflow_core/api/local_agent.py#L173) |

### learnflow_core.api.memory

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/memory/claims/{claim_id}/feedback` | [submit_claim_feedback](../packages/learning-core/src/learnflow_core/api/memory.py#L385) |
| GET | `/api/memory/consolidations` | [get_consolidations](../packages/learning-core/src/learnflow_core/api/memory.py#L367) |
| GET | `/api/memory/graph` | [get_memory_graph](../packages/learning-core/src/learnflow_core/api/memory.py#L214) |
| GET | `/api/memory/nodes/{node_id}` | [get_memory_node](../packages/learning-core/src/learnflow_core/api/memory.py#L260) |
| GET | `/api/memory/timeline` | [get_memory_timeline](../packages/learning-core/src/learnflow_core/api/memory.py#L240) |

### learnflow_core.api.micro_learning

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/micro-learning/runs` | [list_runs](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L77) |
| POST | `/api/micro-learning/runs` | [create_run](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L54) |
| GET | `/api/micro-learning/runs/{run_id}` | [get_run](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L96) |
| POST | `/api/micro-learning/runs/{run_id}/advance` | [advance](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L109) |
| POST | `/api/micro-learning/runs/{run_id}/regenerate` | [regenerate](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L132) |
| POST | `/api/micro-learning/runs/{run_id}/sync` | [sync](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L179) |
| POST | `/api/micro-learning/runs/{run_id}/teach-back` | [teach_back](../packages/learning-core/src/learnflow_core/api/micro_learning.py#L156) |

### learnflow_core.api.phase1

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/projects/{project_id}/reconcile` | [reconcile_sources](../packages/learning-core/src/learnflow_core/api/phase1.py#L657) |
| POST | `/api/projects/{project_id}/reconcile/apply` | [apply_reconcile](../packages/learning-core/src/learnflow_core/api/phase1.py#L737) |
| POST | `/api/projects/{project_id}/roadmap/briefs` | [backfill_briefs](../packages/learning-core/src/learnflow_core/api/phase1.py#L1088) |
| POST | `/api/projects/{project_id}/roadmap/chat` | [roadmap_chat](../packages/learning-core/src/learnflow_core/api/phase1.py#L858) |
| GET | `/api/projects/{project_id}/roadmap/history` | [get_roadmap_history](../packages/learning-core/src/learnflow_core/api/phase1.py#L993) |
| POST | `/api/projects/{project_id}/roadmap/resync` | [resync_roadmap_chunks](../packages/learning-core/src/learnflow_core/api/phase1.py#L1217) |
| POST | `/api/projects/{project_id}/sources/process-all` | [process_all_sources](../packages/learning-core/src/learnflow_core/api/phase1.py#L529) |
| POST | `/api/projects/{project_id}/sources/{source_id}/analyze` | [analyze_source_structure](../packages/learning-core/src/learnflow_core/api/phase1.py#L361) |
| POST | `/api/projects/{project_id}/sources/{source_id}/images/caption` | [start_image_captioning](../packages/learning-core/src/learnflow_core/api/phase1.py#L305) |
| POST | `/api/projects/{project_id}/sources/{source_id}/process` | [process_source](../packages/learning-core/src/learnflow_core/api/phase1.py#L166) |
| PUT | `/api/projects/{project_id}/sources/{source_id}/role` | [set_source_role](../packages/learning-core/src/learnflow_core/api/phase1.py#L636) |
| POST | `/api/projects/{project_id}/sources/{source_id}/summarize` | [summarize_source_files](../packages/learning-core/src/learnflow_core/api/phase1.py#L393) |
| GET | `/api/sources/{source_id}/files/{file_path}` | [serve_source_file](../packages/learning-core/src/learnflow_core/api/phase1.py#L286) |

### learnflow_core.api.phase2

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/animations/generate` | [generate_animation](../packages/learning-core/src/learnflow_core/api/phase2.py#L402) |
| GET | `/api/animations/{animation_id}` | [get_animation](../packages/learning-core/src/learnflow_core/api/phase2.py#L420) |
| DELETE | `/api/artifact-annotations/{annotation_id}` | [delete_artifact_annotation](../packages/learning-core/src/learnflow_core/api/phase2.py#L755) |
| PUT | `/api/artifact-annotations/{annotation_id}` | [update_artifact_annotation](../packages/learning-core/src/learnflow_core/api/phase2.py#L742) |
| GET | `/api/artifacts/{artifact_type}/{artifact_id}/annotations` | [list_artifact_annotations](../packages/learning-core/src/learnflow_core/api/phase2.py#L685) |
| POST | `/api/artifacts/{artifact_type}/{artifact_id}/annotations` | [create_artifact_annotation](../packages/learning-core/src/learnflow_core/api/phase2.py#L700) |
| POST | `/api/checkpoints/{checkpoint_id}/ask` | [ask_question](../packages/learning-core/src/learnflow_core/api/phase2.py#L576) |
| POST | `/api/checkpoints/{checkpoint_id}/concept-graph/generate` | [generate_concept_graph](../packages/learning-core/src/learnflow_core/api/phase2.py#L443) |
| GET | `/api/checkpoints/{checkpoint_id}/concept-graph/task` | [get_concept_graph_task](../packages/learning-core/src/learnflow_core/api/phase2.py#L482) |
| GET | `/api/checkpoints/{checkpoint_id}/lecture` | [get_lecture](../packages/learning-core/src/learnflow_core/api/phase2.py#L342) |
| PUT | `/api/checkpoints/{checkpoint_id}/lecture` | [put_lecture](../packages/learning-core/src/learnflow_core/api/phase2.py#L320) |
| GET | `/api/checkpoints/{checkpoint_id}/lecture/generate` | [generate_lecture_stream](../packages/learning-core/src/learnflow_core/api/phase2.py#L111) |
| POST | `/api/checkpoints/{checkpoint_id}/lecture/generate` | [generate_lecture_task](../packages/learning-core/src/learnflow_core/api/phase2.py#L33) |
| POST | `/api/checkpoints/{checkpoint_id}/lecture/rollback` | [rollback_lecture](../packages/learning-core/src/learnflow_core/api/phase2.py#L527) |
| POST | `/api/checkpoints/{checkpoint_id}/lecture/save` | [save_lecture_compat](../packages/learning-core/src/learnflow_core/api/phase2.py#L331) |
| GET | `/api/checkpoints/{checkpoint_id}/lecture/task` | [get_lecture_task](../packages/learning-core/src/learnflow_core/api/phase2.py#L86) |
| GET | `/api/checkpoints/{checkpoint_id}/lecture/versions` | [list_lecture_versions](../packages/learning-core/src/learnflow_core/api/phase2.py#L504) |
| GET | `/api/checkpoints/{checkpoint_id}/notes` | [list_notes](../packages/learning-core/src/learnflow_core/api/phase2.py#L777) |
| POST | `/api/checkpoints/{checkpoint_id}/notes` | [create_note](../packages/learning-core/src/learnflow_core/api/phase2.py#L792) |
| DELETE | `/api/notes/{note_id}` | [delete_note](../packages/learning-core/src/learnflow_core/api/phase2.py#L825) |
| PUT | `/api/notes/{note_id}` | [update_note](../packages/learning-core/src/learnflow_core/api/phase2.py#L815) |

### learnflow_core.api.phase3

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/checkpoints/{checkpoint_id}/concepts` | [list_concepts](../packages/learning-core/src/learnflow_core/api/phase3.py#L412) |
| POST | `/api/checkpoints/{checkpoint_id}/concepts/generate` | [generate_concepts](../packages/learning-core/src/learnflow_core/api/phase3.py#L437) |
| GET | `/api/checkpoints/{checkpoint_id}/concepts/task` | [get_concept_task](../packages/learning-core/src/learnflow_core/api/phase3.py#L476) |
| POST | `/api/checkpoints/{checkpoint_id}/concepts/{question_id}/explain` | [explain_concept](../packages/learning-core/src/learnflow_core/api/phase3.py#L496) |
| POST | `/api/checkpoints/{checkpoint_id}/concepts/{question_id}/submit` | [submit_concept](../packages/learning-core/src/learnflow_core/api/phase3.py#L536) |
| GET | `/api/checkpoints/{checkpoint_id}/exercises` | [list_exercises](../packages/learning-core/src/learnflow_core/api/phase3.py#L57) |
| POST | `/api/checkpoints/{checkpoint_id}/exercises` | [create_exercise](../packages/learning-core/src/learnflow_core/api/phase3.py#L84) |
| POST | `/api/checkpoints/{checkpoint_id}/exercises/generate` | [generate_exercises](../packages/learning-core/src/learnflow_core/api/phase3.py#L698) |
| GET | `/api/checkpoints/{checkpoint_id}/exercises/task` | [get_exercise_task](../packages/learning-core/src/learnflow_core/api/phase3.py#L738) |
| POST | `/api/code/ask` | [ask_code_question](../packages/learning-core/src/learnflow_core/api/phase3.py#L324) |
| GET | `/api/exercises/{exercise_id}` | [get_exercise](../packages/learning-core/src/learnflow_core/api/phase3.py#L133) |
| GET | `/api/exercises/{exercise_id}/draft` | [get_exercise_draft](../packages/learning-core/src/learnflow_core/api/phase3.py#L151) |
| PUT | `/api/exercises/{exercise_id}/draft` | [put_exercise_draft](../packages/learning-core/src/learnflow_core/api/phase3.py#L185) |
| GET | `/api/exercises/{exercise_id}/env` | [exercise_env_status](../packages/learning-core/src/learnflow_core/api/phase3.py#L270) |
| POST | `/api/exercises/{exercise_id}/review` | [review_code](../packages/learning-core/src/learnflow_core/api/phase3.py#L293) |
| POST | `/api/exercises/{exercise_id}/run` | [run_code](../packages/learning-core/src/learnflow_core/api/phase3.py#L219) |
| POST | `/api/exercises/{exercise_id}/submit` | [submit_exercise](../packages/learning-core/src/learnflow_core/api/phase3.py#L758) |
| POST | `/api/projects/{project_id}/embeddings/index` | [index_embeddings](../packages/learning-core/src/learnflow_core/api/phase3.py#L371) |

### learnflow_core.api.platform

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/platform` | [platform_manifest](../packages/learning-core/src/learnflow_core/api/platform.py#L9) |

### learnflow_core.api.profile

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/profile` | [get_profile](../packages/learning-core/src/learnflow_core/api/profile.py#L38) |
| PATCH | `/api/profile` | [update_profile](../packages/learning-core/src/learnflow_core/api/profile.py#L56) |
| GET | `/api/profile/growth` | [get_growth](../packages/learning-core/src/learnflow_core/api/profile.py#L114) |
| GET | `/api/profile/journey` | [get_journey](../packages/learning-core/src/learnflow_core/api/profile.py#L158) |
| GET | `/api/profile/memories` | [get_memories](../packages/learning-core/src/learnflow_core/api/profile.py#L106) |
| POST | `/api/profile/memories/{memory_id}/archive` | [archive_memory](../packages/learning-core/src/learnflow_core/api/profile.py#L124) |
| POST | `/api/profile/memories/{memory_id}/restore` | [restore_memory](../packages/learning-core/src/learnflow_core/api/profile.py#L142) |

### learnflow_core.api.projects

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/projects` | [list_projects](../packages/learning-core/src/learnflow_core/api/projects.py#L60) |
| POST | `/api/projects` | [create_project](../packages/learning-core/src/learnflow_core/api/projects.py#L31) |
| DELETE | `/api/projects/{project_id}` | [delete_project](../packages/learning-core/src/learnflow_core/api/projects.py#L108) |
| GET | `/api/projects/{project_id}` | [get_project](../packages/learning-core/src/learnflow_core/api/projects.py#L99) |
| GET | `/api/projects/{project_id}/chunks` | [list_chunks](../packages/learning-core/src/learnflow_core/api/projects.py#L284) |
| GET | `/api/projects/{project_id}/roadmap` | [get_roadmap](../packages/learning-core/src/learnflow_core/api/projects.py#L305) |
| GET | `/api/projects/{project_id}/sources` | [list_sources](../packages/learning-core/src/learnflow_core/api/projects.py#L260) |
| POST | `/api/projects/{project_id}/sources` | [add_source](../packages/learning-core/src/learnflow_core/api/projects.py#L129) |
| POST | `/api/projects/{project_id}/sources/upload` | [upload_source](../packages/learning-core/src/learnflow_core/api/projects.py#L159) |

### learnflow_core.api.remediation

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/checkpoints/{checkpoint_id}/remediation-cases` | [list_remediation_cases](../packages/learning-core/src/learnflow_core/api/remediation.py#L38) |
| GET | `/api/remediation/{case_id}` | [get_remediation_case](../packages/learning-core/src/learnflow_core/api/remediation.py#L29) |
| POST | `/api/remediation/{case_id}/explanations` | [change_remediation_explanation](../packages/learning-core/src/learnflow_core/api/remediation.py#L52) |
| POST | `/api/remediation/{case_id}/variant` | [create_remediation_variant](../packages/learning-core/src/learnflow_core/api/remediation.py#L70) |
| POST | `/api/remediation/{case_id}/variant/submit` | [evaluate_remediation_variant](../packages/learning-core/src/learnflow_core/api/remediation.py#L84) |

### learnflow_core.api.review

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/review/agent-context` | [review_agent_context](../packages/learning-core/src/learnflow_core/api/review.py#L461) |
| GET | `/api/review/items` | [list_review_items](../packages/learning-core/src/learnflow_core/api/review.py#L391) |
| GET | `/api/review/items/{schedule_id}` | [get_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L525) |
| POST | `/api/review/items/{schedule_id}/defer` | [defer_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L974) |
| GET | `/api/review/items/{schedule_id}/history` | [get_review_history](../packages/learning-core/src/learnflow_core/api/review.py#L535) |
| POST | `/api/review/items/{schedule_id}/reflections` | [record_review_reflection](../packages/learning-core/src/learnflow_core/api/review.py#L579) |
| POST | `/api/review/items/{schedule_id}/resume` | [resume_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L1029) |
| POST | `/api/review/items/{schedule_id}/submit` | [submit_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L677) |
| POST | `/api/review/items/{schedule_id}/suspend` | [suspend_review_item](../packages/learning-core/src/learnflow_core/api/review.py#L1004) |
| GET | `/api/review/summary` | [review_summary](../packages/learning-core/src/learnflow_core/api/review.py#L357) |

### learnflow_core.api.settings

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/settings` | [get_settings](../packages/learning-core/src/learnflow_core/api/settings.py#L167) |
| PUT | `/api/settings` | [save_settings](../packages/learning-core/src/learnflow_core/api/settings.py#L297) |
| POST | `/api/settings/test` | [test_connection](../packages/learning-core/src/learnflow_core/api/settings.py#L202) |
| POST | `/api/settings/test-embedding` | [test_embedding](../packages/learning-core/src/learnflow_core/api/settings.py#L261) |
| POST | `/api/settings/test-vision` | [test_vision](../packages/learning-core/src/learnflow_core/api/settings.py#L346) |

### learnflow_core.api.tasks

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/tasks/{task_id}` | [get_task_status](../packages/learning-core/src/learnflow_core/api/tasks.py#L39) |
| POST | `/api/tasks/{task_id}/cancel` | [cancel_task](../packages/learning-core/src/learnflow_core/api/tasks.py#L49) |
| GET | `/api/tasks/{task_id}/events` | [task_events](../packages/learning-core/src/learnflow_core/api/tasks.py#L69) |

### learnflow_core.api.workspace

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| GET | `/api/checkpoints/{checkpoint_id}/workspace/artifacts` | [get_checkpoint_workspace_artifacts](../packages/learning-core/src/learnflow_core/api/workspace.py#L115) |
| GET | `/api/projects/{project_id}/workspace/agent-files/{file_path}` | [get_workspace_file_for_checkpoint_tutor](../packages/learning-core/src/learnflow_core/api/workspace.py#L280) |
| GET | `/api/projects/{project_id}/workspace/files/{file_path}` | [get_workspace_file](../packages/learning-core/src/learnflow_core/api/workspace.py#L227) |
| PUT | `/api/projects/{project_id}/workspace/files/{file_path}` | [put_workspace_file](../packages/learning-core/src/learnflow_core/api/workspace.py#L370) |
| POST | `/api/projects/{project_id}/workspace/link` | [link_workspace](../packages/learning-core/src/learnflow_core/api/workspace.py#L137) |
| POST | `/api/projects/{project_id}/workspace/open` | [open_workspace_item](../packages/learning-core/src/learnflow_core/api/workspace.py#L339) |
| GET | `/api/projects/{project_id}/workspace/operations` | [list_workspace_operations](../packages/learning-core/src/learnflow_core/api/workspace.py#L535) |
| POST | `/api/projects/{project_id}/workspace/operations/propose` | [propose_workspace_operation](../packages/learning-core/src/learnflow_core/api/workspace.py#L441) |
| POST | `/api/projects/{project_id}/workspace/operations/{operation_id}/confirm` | [confirm_workspace_operation](../packages/learning-core/src/learnflow_core/api/workspace.py#L562) |
| GET | `/api/projects/{project_id}/workspace/previews/{file_path}` | [preview_workspace_file](../packages/learning-core/src/learnflow_core/api/workspace.py#L250) |
| POST | `/api/projects/{project_id}/workspace/reveal` | [reveal_workspace_item](../packages/learning-core/src/learnflow_core/api/workspace.py#L305) |
| GET | `/api/projects/{project_id}/workspace/tree` | [workspace_tree](../packages/learning-core/src/learnflow_core/api/workspace.py#L203) |


## Web Node Tutor

### tutorProxy

| 方法 | 路径 / 命令 | 实现 |
|---|---|---|
| POST | `/api/tutor` | [middleware](../frontend/vite.config.ts#L285) |
| GET | `/api/tutor/status` | [middleware](../frontend/vite.config.ts#L262) |
| POST | `/api/tutor/stream` | [middleware](../frontend/vite.config.ts#L284) |
