import asyncio
import hashlib
import json
from pathlib import Path

from app.api.architecture import validate_architecture_registry
from app.services import learning_runtime
from app.services.action_board import ACTION_BOARD
from app.services.architecture_registry import (
    AGENTS,
    CHAT_MODES,
    CAPABILITY_OWNERS,
    EVENT_SCHEMA_VERSION,
    EVENTS,
    IMPLEMENTATION_BINDINGS,
    KERNELS,
    KERNEL_NAMES,
    LIFECYCLE_STATES,
    PUBLICATIONS,
    PLUGIN_EXTENSION_POINTS,
    REGISTRY_VERSION,
    SKILLS,
    SKILL_KINDS,
    SKILL_SPEC_VERSION,
    TOOLS,
    TOOL_INTERFACE_ROLES,
    TOOL_MODEL_EXPOSURE,
    WORKBENCHES,
    normalize_event_provenance,
    registry_manifest,
    registry_validation_report,
    chat_mode_manifest,
    frontend_learning_skill_manifest,
    implementation_binding_failures,
    selectable_learning_skill_manifest,
    validate_implementation,
    validate_registry,
)


def test_registry_has_three_agents_five_kernels_and_no_drift():
    assert len(AGENTS) == 3
    assert KERNEL_NAMES == ("structure", "knowledge", "human", "value", "practice")
    assert set(ACTION_BOARD) == set(CAPABILITY_OWNERS)
    assert validate_registry() == []
    manifest = registry_manifest()
    assert REGISTRY_VERSION == "2026-09-06.6-desktop"
    assert manifest["schema_valid"] is True
    assert manifest["valid"] is (
        manifest["schema_valid"] and manifest["implementation_valid"]
    )
    assert manifest["validation_errors"] == manifest["issues"] == manifest["errors"]
    assert len(manifest["digest"]) == 64
    manifest_without_digest = dict(manifest)
    digest = manifest_without_digest.pop("digest")
    digest_input = json.dumps(
        manifest_without_digest,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    assert digest == hashlib.sha256(digest_input.encode("utf-8")).hexdigest()
    assert manifest["authority"]["memory_projection"] == (
        "KernelMutation -> MemoryFact -> versioned MemoryModule -> MemoryClaim"
    )
    assert "one active version" in manifest["authority"]["module_versioning"]
    assert "startup queue reconciliation" in manifest["authority"]["memory_consolidation"]
    assert "shared Tutor deadline" in manifest["authority"]["interactive_model_latency"]
    assert manifest["authority"]["teaching_delivery_projection"].startswith(
        "DomainBrief -> versioned SourceVersion evidence"
    )
    assert "cannot imply mastery" in manifest["authority"]["domain_knowledge_authority"]
    assert manifest["authority"]["frontend_authority"].startswith("frontend/ is the only product frontend")
    assert tuple(PLUGIN_EXTENSION_POINTS) == ("tool", "skill", "object", "tool_renderer")
    assert [item["id"] for item in manifest["plugin_extension_points"]] == list(PLUGIN_EXTENSION_POINTS)
    assert all(item["bindings"] for item in manifest["plugin_extension_points"])
    assert "frontend:plugin.picker" in PLUGIN_EXTENSION_POINTS["tool"].bindings
    assert "frontend:plugin.picker" in PLUGIN_EXTENSION_POINTS["skill"].bindings
    assert "conversation_sticky_after_first_tool_run" in PLUGIN_EXTENSION_POINTS["tool"].restrictions
    assert "prompt_reference_only" in PLUGIN_EXTENSION_POINTS["tool_renderer"].restrictions
    assert "paper_projection_only" in PLUGIN_EXTENSION_POINTS["tool_renderer"].restrictions
    assert "none can write kernels" in manifest["authority"]["plugin_extension_authority"]
    assert "LearnFlow exposes no role-package production" in manifest["authority"]["role_package_ecosystem"]
    assert "explicit immutable package reference" in manifest["authority"]["role_package_ecosystem"]
    assert "deterministic role match or Role Atlas research handoff" in manifest["authority"]["role_package_ecosystem"]
    assert tuple(CHAT_MODES) == ("free", "explain", "learn", "plan")
    assert [item["id"] for item in chat_mode_manifest()] == [
        "free", "explain", "learn", "plan",
    ]
    assert len(manifest["chat_modes"]) == 4
    assert KERNELS["knowledge"].claim_mode == "evidence_claims"
    assert "Learning-path self-report never implies knowledge mastery." in KERNELS["structure"].hard_boundaries
    assert KERNELS["human"].claim_mode == "directive_claims"
    assert KERNELS["value"].claim_mode == "consent_claims"
    assert KERNELS["practice"].claim_mode == "performance_claims"


def test_publications_have_lifecycle_bindings_and_optional_rows_are_unavailable():
    manifest = registry_manifest()
    assert tuple(manifest["lifecycle_states"]) == LIFECYCLE_STATES
    for category in ("tools", "skills", "workbenches", "capabilities", "important_events"):
        for row in manifest[category]:
            assert row["lifecycle"] in LIFECYCLE_STATES
            assert isinstance(row["binding_ids"], list)
            assert isinstance(row["available"], bool)
            if row["lifecycle"] == "implemented":
                assert row["binding_ids"]
            else:
                assert row["available"] is False
                assert row["lifecycle_note"]

    tools = {row["id"]: row for row in manifest["tools"]}
    skills = {row["id"]: row for row in manifest["skills"]}
    workbenches = {row["id"]: row for row in manifest["workbenches"]}
    capabilities = {row["capability"]: row for row in manifest["capabilities"]}
    assert tools["workflow_gateway"]["lifecycle"] == "optional_unimplemented"
    assert tools["workflow_validator"]["lifecycle"] == "optional_unimplemented"
    assert skills["external_workflow_rendering"]["lifecycle"] == "optional_unimplemented"
    assert workbenches["xingchen_studio"]["lifecycle"] == "optional_unimplemented"
    assert capabilities["recommend_learning_resources"]["lifecycle"] == "optional_unimplemented"
    assert capabilities["search_learning_resources"]["lifecycle"] == "optional_unimplemented"
    assert "recommend_learning_resources" not in manifest["available_capabilities"]
    assert "search_learning_resources" not in manifest["available_capabilities"]
    assert tools["action_board"]["binding_ids"] == ["py:action_board.execute"]
    assert workbenches["vnext_chat"]["binding_ids"] == ["workbench:vnext_chat"]
    assert tools["learning_task_candidate_gateway"]["lifecycle"] == "implemented"
    assert skills["learning_task_conversion"]["lifecycle"] == "implemented"
    assert capabilities["draft_learning_task_candidate"]["lifecycle"] == "implemented"
    assert TOOLS["learning_task_candidate_gateway"].writes_kernels == ()
    assert CAPABILITY_OWNERS["draft_learning_task_candidate"] == (
        "tutor_agent", "learning_task_candidate_gateway", "vnext_chat",
    )
    for event_id in (
        "learning_task_candidate_generated",
        "learning_task_candidate_audited",
        "learning_task_candidate_handoff_prepared",
        "learning_task_candidate_confirmed",
    ):
        assert EVENTS[event_id].kernel_targets == ()


def test_targeted_events_declare_payload_and_explicit_reducer_bindings():
    for event in EVENTS.values():
        if not event.kernel_targets:
            assert event.payload_version is None
            assert event.reducer_binding is None
            continue
        assert event.payload_version == EVENT_SCHEMA_VERSION
        assert event.reducer_binding == f"reducer:{event.id}"
        binding = IMPLEMENTATION_BINDINGS[event.reducer_binding]
        assert binding.kind == "reducer_event"
        assert binding.module == "app.services.learning_runtime"
        assert binding.symbol == "REDUCER_EVENT_TYPES"
        assert binding.member == event.id
        assert event.reducer_binding in PUBLICATIONS["events"][event.id].bindings

    assert EVENTS["project_proposal_accepted"].reducer_binding == (
        "reducer:project_proposal_accepted"
    )
    assert EVENTS["project_completed"].reducer_binding == "reducer:project_completed"


def test_project_operational_workflows_cannot_promote_mastery_or_expose_host_execution_to_models():
    for tool_id in ("project_workflow_runtime", "local_work_case_catalog", "desktop_experiment_runner"):
        assert TOOLS[tool_id].writes_kernels == ()
        assert TOOL_INTERFACE_ROLES[tool_id] == "harness"
    for event_id in ("project_workflow_initialized", "project_workbench_saved", "project_delivery_submitted",
                     "project_reading_recorded", "experiment_run_started", "experiment_run_completed"):
        assert EVENTS[event_id].kernel_targets == ()
        assert EVENTS[event_id].reducer_binding is None


def test_implementation_validation_requires_reducer_export_and_checks_members(monkeypatch):
    targeted_event_types = frozenset(
        event.id for event in EVENTS.values() if event.kernel_targets
    )

    monkeypatch.delattr(learning_runtime, "REDUCER_EVENT_TYPES", raising=False)
    missing_export = validate_implementation()
    assert len(missing_export) == 1
    assert "REDUCER_EVENT_TYPES" in missing_export[0]
    assert "project_proposal_accepted" in missing_export[0]
    assert "project_completed" in missing_export[0]

    monkeypatch.setattr(
        learning_runtime,
        "REDUCER_EVENT_TYPES",
        targeted_event_types - {"project_completed"},
        raising=False,
    )
    missing_handler = validate_implementation()
    assert any("reducer:project_completed" in issue for issue in missing_handler)

    monkeypatch.setattr(
        learning_runtime,
        "REDUCER_EVENT_TYPES",
        targeted_event_types,
        raising=False,
    )
    assert implementation_binding_failures() == {}
    report = registry_validation_report()
    assert report["schema_valid"] is True
    assert report["implementation_valid"] is True
    assert report["valid"] is True
    assert report["issues"] == report["errors"] == []


def test_architecture_validate_keeps_legacy_fields_and_split_validity():
    report = asyncio.run(validate_architecture_registry())
    assert {"schema_valid", "implementation_valid", "issues", "valid", "errors"} <= set(report)
    assert report["errors"] == report["issues"]
    assert report["valid"] is (
        report["schema_valid"] and report["implementation_valid"]
    )


def test_chat_modes_are_tutor_postures_with_registered_action_projection():
    assert all(item.owner_agent == "tutor_agent" for item in CHAT_MODES.values())
    assert "coordinate_chat_mode" in ACTION_BOARD
    assert CAPABILITY_OWNERS["coordinate_chat_mode"] == (
        "tutor_agent", "chat_mode_runtime", "global_tutor",
    )
    assert EVENTS["chat_mode_entered"].kernel_targets == ()
    assert EVENTS["learning_action_segment_completed"].kernel_targets == (
        "structure", "knowledge", "value",
    )
    assert EVENTS["vnext_human_adaptation_requested"].kernel_targets == ("human",)
    assert EVENTS["vnext_human_adaptation_requested"].evidence_role == "explicit_transient_adaptation"
    assert EVENTS["vnext_planning_profile_self_reported"].kernel_targets == KERNEL_NAMES
    assert EVENTS["vnext_planning_profile_self_reported"].evidence_role == "learner_self_report_for_planning"
    assert {"pace_adjustment", "format_request"} <= set(KERNELS["human"].short_term_keys)
    assert WORKBENCHES["learning_tasks"].capabilities == ("manage_learning_tasks",)
    assert WORKBENCHES["focused_learning"].name == "Learning Artifact Workbench"


def test_workspace_deletion_is_registered_as_zero_target_lifecycle():
    assert "workspace_lifecycle" in TOOLS
    assert CAPABILITY_OWNERS["delete_conversation"] == (
        "tutor_agent", "workspace_lifecycle", "global_tutor",
    )
    assert CAPABILITY_OWNERS["delete_project"] == (
        "tutor_agent", "workspace_lifecycle", "project_tutor",
    )
    assert "delete_conversation" in WORKBENCHES["global_tutor"].capabilities
    assert "delete_project" in WORKBENCHES["project_tutor"].capabilities
    assert EVENTS["conversation_deleted"].kernel_targets == ()
    assert EVENTS["project_deleted"].kernel_targets == ()


def test_vnext_tools_use_formal_event_gateway_without_direct_kernel_writes():
    assert {
        "computer_knowledge_search", "web_evidence_reader", "learning_video_search", "learning_video_inspector", "safe_visual_generation", "learning_diagram_generator", "learning_animation_generator", "selection_followup_context",
        "vnext_learning_task_runtime", "vnext_learning_plan_runtime", "vnext_five_kernel_profile_reader",
        "vnext_learning_workspace_reader",
        "vnext_learning_path_graph_reader", "vnext_learning_path_exact_reader",
        "vnext_learning_path_fuzzy_reader", "vnext_personal_path_node_proposer",
        "vnext_learning_path_planner",
        "vnext_learning_path_plan_manager", "personal_concept_graph_reader",
        "concept_self_report_gateway", "vnext_personal_path_node_runtime",
        "vnext_five_kernel_explicit_editor", "review_context_reader",
        "review_proficiency_projector", "review_reflection_gateway",
    } <= set(TOOLS)
    assert TOOL_INTERFACE_ROLES["vnext_chat_session_store"] == "adapter"
    assert TOOLS["vnext_chat_session_store"].writes_kernels == ()
    assert WORKBENCHES["vnext_chat"].surface == "/chat/:conversationId"
    assert set(WORKBENCHES["vnext_chat"].capabilities) == {
        "coordinate_vnext_agent_turn",
        "search_computer_knowledge", "read_web_evidence", "search_learning_videos", "inspect_learning_video", "generate_learning_diagram", "generate_learning_animation", "open_selection_followup",
        "run_vnext_learning_task", "run_vnext_learning_plan", "read_vnext_five_kernel_profile",
        "read_vnext_learning_workspace", "manage_domain_knowledge_sources", "read_domain_knowledge",
        "read_active_learning_file", "validate_teaching_contract", "read_checkpoint_delivery_readiness",
        "recommend_learning_resources", "attach_learning_file_to_chat",
        "design_assessment_blueprint",
        "generate_dynamic_practice", "generate_similar_practice", "inspect_practice_quality",
        "read_review_context",
        "lookup_vnext_learning_path_node", "search_vnext_learning_path_graph",
        "propose_vnext_personal_path_node",
        "read_vnext_learning_path_graph", "plan_vnext_learning_path", "manage_vnext_learning_path_plan",
        "read_personal_concept_graph", "record_concept_self_report", "manage_vnext_personal_path_node",
        "draft_learning_task_candidate",
    }
    assert CAPABILITY_OWNERS["search_computer_knowledge"][0] == "learning_design_agent"
    assert CAPABILITY_OWNERS["read_web_evidence"] == (
        "learning_design_agent", "web_evidence_reader", "vnext_chat",
    )
    assert ACTION_BOARD["generate_learning_diagram"].confirmation_policy == "explicit_or_click"
    assert ACTION_BOARD["generate_learning_animation"].confirmation_policy == "explicit_or_click"
    assert CAPABILITY_OWNERS["search_learning_videos"] == (
        "learning_design_agent", "learning_video_search", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["inspect_learning_video"] == (
        "learning_design_agent", "learning_video_inspector", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["coordinate_vnext_agent_turn"] == (
        "tutor_agent", "vnext_agent_turn_runtime", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["open_selection_followup"][0] == "tutor_agent"
    assert CAPABILITY_OWNERS["run_vnext_learning_task"] == (
        "tutor_agent", "vnext_learning_task_runtime", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["run_vnext_learning_plan"] == (
        "tutor_agent", "vnext_learning_plan_runtime", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["read_vnext_five_kernel_profile"] == (
        "tutor_agent", "vnext_five_kernel_profile_reader", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["read_vnext_learning_workspace"] == (
        "tutor_agent", "vnext_learning_workspace_reader", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["manage_domain_knowledge_sources"] == (
        "tutor_agent", "source_ingestion", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["read_domain_knowledge"] == (
        "tutor_agent", "domain_knowledge_reader", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["recommend_learning_resources"] == (
        "learning_design_agent", "domain_knowledge_reader", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["read_vnext_learning_path_graph"] == (
        "tutor_agent", "vnext_learning_path_graph_reader", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["lookup_vnext_learning_path_node"] == (
        "tutor_agent", "vnext_learning_path_exact_reader", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["search_vnext_learning_path_graph"] == (
        "tutor_agent", "vnext_learning_path_fuzzy_reader", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["propose_vnext_personal_path_node"] == (
        "tutor_agent", "vnext_personal_path_node_proposer", "vnext_chat",
    )
    assert WORKBENCHES["vnext_learning_path"].surface == "/learning-path"
    assert WORKBENCHES["vnext_profile"].surface == "/learner-profile"
    assert "edit_vnext_five_kernel_profile" in WORKBENCHES["vnext_profile"].capabilities
    assert CAPABILITY_OWNERS["edit_vnext_five_kernel_profile"] == (
        "tutor_agent", "vnext_five_kernel_explicit_editor", "vnext_profile",
    )
    assert EVENTS["profile_updated"].capability == "edit_vnext_five_kernel_profile"
    assert EVENTS["career_goal_confirmed"].capability == "edit_vnext_five_kernel_profile"
    assert all(
        TOOLS[tool_id].writes_kernels == ()
        for tool_id in {
            "computer_knowledge_search", "web_evidence_reader", "learning_video_search", "learning_video_inspector", "safe_visual_generation", "learning_diagram_generator", "learning_animation_generator", "selection_followup_context",
            "vnext_learning_task_runtime", "vnext_learning_plan_runtime", "vnext_five_kernel_profile_reader",
            "vnext_learning_workspace_reader", "review_context_reader",
            "domain_knowledge_reader", "learning_file_service",
            "review_proficiency_projector", "review_reflection_gateway",
            "vnext_learning_path_graph_reader", "vnext_learning_path_exact_reader",
            "vnext_learning_path_fuzzy_reader", "vnext_personal_path_node_proposer",
            "vnext_learning_path_planner", "vnext_learning_path_plan_manager",
            "personal_concept_graph_reader", "concept_self_report_gateway", "vnext_personal_path_node_runtime",
            "vnext_five_kernel_explicit_editor",
        }
    )
    assert "deterministic rerank" in TOOLS["computer_knowledge_search"].write_path
    assert "untrusted evidence bundle" in TOOLS["computer_knowledge_search"].write_path
    assert TOOLS["web_evidence_reader"].writes_kernels == ()
    assert "exact URL from current search" in TOOLS["web_evidence_reader"].write_path
    assert "LearningSkillRun" in TOOLS["vnext_learning_task_runtime"].write_path
    assert "explicit confirmation EvidenceEvent" in TOOLS["vnext_learning_plan_runtime"].write_path
    assert registry_manifest()["authority"]["vnext_learning_substate_projection"] == (
        "guided_learning main state -> bound learning skill -> formal LearningSkillRun state; "
        "browser events only mirror the formal state or serve explicit offline fallback"
    )
    assert "non-mastery alignment records" in registry_manifest()["authority"]["vnext_learning_graph_alignment"]
    assert TOOLS["vnext_five_kernel_profile_reader"].reads_kernels == (
        "structure", "knowledge", "human", "value", "practice",
    )
    assert "bounded read-only Tutor context" in TOOLS["vnext_five_kernel_profile_reader"].write_path
    assert EVENTS["knowledge_source_added"].kernel_targets == ()
    assert EVENTS["knowledge_source_processed"].kernel_targets == ()
    assert EVENTS["project_knowledge_source_promoted"].kernel_targets == ()
    assert "source vectors" in TOOLS["domain_knowledge_packet_compiler"].write_path
    assert "viewpoints separated from facts" in registry_manifest()["authority"]["domain_knowledge_authority"]
    assert "learner-confirmed project snapshot" in registry_manifest()["authority"]["project_source_selection"]
    assert EVENTS["learning_file_generated"].kernel_targets == ()
    assert EVENTS["learning_file_opened"].kernel_targets == ()
    assert EVENTS["learning_file_attached_to_chat"].kernel_targets == ()
    assert all(EVENTS[event_id].kernel_targets == () for event_id in {
            "vnext_learning_task_created", "vnext_learning_task_started",
            "vnext_learning_task_phase_entered",
            "vnext_learning_skill_step_entered", "vnext_learning_skill_looped",
            "vnext_learning_task_learner_replied", "vnext_learning_support_requested",
            "vnext_learning_skill_selected", "vnext_learning_task_paused",
            "vnext_learning_task_resumed", "vnext_learning_task_completed",
            "vnext_learning_plan_started", "vnext_learning_plan_note_captured",
            "vnext_project_seed_ready", "vnext_value_claim_proposed",
            "vnext_value_claim_proposal_rejected",
            "vnext_value_claim_proposal_revision_requested", "vnext_learning_plan_closed",
        })
    assert EVENTS["vnext_value_claim_proposal_accepted"].kernel_targets == ("value",)
    assert EVENTS["vnext_learning_path_node_status_set"].kernel_targets == (
        "structure", "knowledge",
    )
    assert EVENTS["vnext_personal_path_node_added"].kernel_targets == (
        "structure", "value",
    )
    assert "self-report is never Knowledge mastery" in TOOLS["vnext_learning_path_graph_reader"].write_path
    assert CAPABILITY_OWNERS["manage_learner_memory"] == (
        "tutor_agent", "learner_memory_manager", "vnext_profile",
    )
    assert "manage_learner_memory" in WORKBENCHES["vnext_profile"].capabilities
    assert CAPABILITY_OWNERS["read_personal_concept_graph"] == (
        "tutor_agent", "personal_concept_graph_reader", "vnext_chat",
    )
    assert CAPABILITY_OWNERS["record_concept_self_report"] == (
        "tutor_agent", "concept_self_report_gateway", "vnext_profile",
    )
    assert EVENTS["learner_concept_statement_recorded"].kernel_targets == ()
    assert EVENTS["learner_concept_observation_recorded"].kernel_targets == ("knowledge",)
    assert EVENTS["learner_concept_relation_recorded"].kernel_targets == ("structure",)
    assert "shared ConceptAnchor identity" in TOOLS["personal_concept_graph_reader"].write_path
    assert "no mastery inference" in TOOLS["concept_self_report_gateway"].write_path


def test_agent_interface_ontology_separates_tools_harness_and_skills():
    assert set(TOOL_INTERFACE_ROLES) == set(TOOLS)
    assert set(TOOL_MODEL_EXPOSURE) == set(TOOLS)
    assert set(SKILL_KINDS) == set(SKILLS)
    assert TOOL_INTERFACE_ROLES["computer_knowledge_search"] == "aci_tool"
    assert TOOL_INTERFACE_ROLES["web_evidence_reader"] == "aci_tool"
    assert TOOL_INTERFACE_ROLES["learning_video_search"] == "aci_tool"
    assert TOOL_INTERFACE_ROLES["learning_video_inspector"] == "aci_tool"
    assert TOOL_MODEL_EXPOSURE["learning_video_search"] == "vnext_native"
    assert TOOL_MODEL_EXPOSURE["learning_video_inspector"] == "vnext_native"
    assert TOOL_INTERFACE_ROLES["teaching_contract_gate"] == "policy"
    assert TOOL_INTERFACE_ROLES["checkpoint_delivery_readiness"] == "projection"
    assert "package readiness" in TOOLS["checkpoint_delivery_readiness"].write_path
    assert "task readiness" in TOOLS["checkpoint_delivery_readiness"].write_path
    assert TOOLS["checkpoint_delivery_readiness"].reads_kernels == ()
    assert TOOL_MODEL_EXPOSURE["web_evidence_reader"] == "vnext_native"
    assert TOOL_INTERFACE_ROLES["vnext_agent_turn_runtime"] == "harness"
    assert TOOL_INTERFACE_ROLES["five_kernel_reducer"] == "projection"
    assert TOOL_INTERFACE_ROLES["deterministic_remediation"] == "policy"
    assert TOOL_MODEL_EXPOSURE["vnext_five_kernel_profile_reader"] == "vnext_native"
    assert TOOL_MODEL_EXPOSURE["vnext_learning_workspace_reader"] == "vnext_native"
    assert TOOL_INTERFACE_ROLES["vnext_learning_path_graph_reader"] == "harness"
    assert TOOL_MODEL_EXPOSURE["vnext_learning_path_graph_reader"] == "not_model_callable"
    assert TOOL_MODEL_EXPOSURE["vnext_learning_path_exact_reader"] == "vnext_native"
    assert TOOL_MODEL_EXPOSURE["vnext_learning_path_fuzzy_reader"] == "vnext_native"
    assert TOOL_MODEL_EXPOSURE["vnext_personal_path_node_proposer"] == "vnext_native"
    assert TOOL_INTERFACE_ROLES["project_roadmap_reader"] == "aci_tool"
    assert TOOL_MODEL_EXPOSURE["project_roadmap_reader"] == "vnext_native"
    assert CAPABILITY_OWNERS["read_project_roadmap"] == (
        "tutor_agent", "project_roadmap_reader", "project_tutor",
    )
    assert CAPABILITY_OWNERS["revise_project_roadmap"] == (
        "tutor_agent", "project_roadmap_proposer", "project_tutor",
    )
    assert TOOL_MODEL_EXPOSURE["concept_self_report_gateway"] == "agent_mediated"
    assert SKILL_KINDS["guided_explanation"] == "pedagogical_method"
    assert SKILL_KINDS["atomic_learning_loop"] == "playbook"
    manifest = registry_manifest()
    runtime = next(tool for tool in manifest["tools"] if tool["id"] == "vnext_agent_turn_runtime")
    assert runtime["interface_role"] == "harness"
    guided = next(skill for skill in manifest["skills"] if skill["id"] == "guided_explanation")
    assert guided["skill_kind"] == "pedagogical_method"


def test_visual_generation_is_owned_by_a_registered_explanation_first_skill():
    skill = SKILLS["visual_teaching_composition"]
    assert SKILL_KINDS[skill.id] == "playbook"
    assert skill.owner_agent == "learning_design_agent"
    assert skill.learner_selectable is False
    assert {"safe_visual_generation", "learning_diagram_generator", "learning_animation_generator"} <= set(skill.tools)
    runtime = skill.runtime
    assert runtime is not None
    assert runtime.version == "visual-teaching-skill-runtime-v1"
    assert [state.id for state in runtime.states] == [
        "compose_explanation", "commit_explanation", "compile_visual_brief",
        "render_visual", "bundle_ready_or_explanation_only",
    ]
    assert "VisualTeachingBundle" in runtime.output_objects
    assert "explanation_only" in runtime.failure_policy
    assert "no mastery inference" in runtime.evidence_policy
    assert "independently valid explanation" in TOOLS["safe_visual_generation"].write_path
    assert "ASCII" in TOOLS["safe_visual_generation"].write_path


def test_remediation_events_have_standard_authority_provenance():
    expected = {
        "remediation_started",
        "remediation_mode_rejected",
        "remediation_explanation_requested",
        "remediation_retry_evaluated",
        "remediation_variant_evaluated",
        "remediation_completed",
    }
    assert expected <= set(EVENTS)
    provenance = normalize_event_provenance(
        "remediation_completed", "assessment", {"provider": "local"},
    )
    assert provenance["owner_agent"] == "practice_agent"
    assert provenance["tool"] == "deterministic_assessment"
    assert provenance["kernel_targets"] == ["knowledge", "human", "practice"]
    assert provenance["provider"] == "local"


def test_background_task_events_are_registered_with_their_actual_authority():
    assert {"source_processed", "assessment_generated", "task_completed", "task_failed"} <= set(EVENTS)
    assert normalize_event_provenance("source_processed", "task", {})["kernel_targets"] == [
        "structure", "practice",
    ]
    assert normalize_event_provenance("assessment_generated", "task", {})["kernel_targets"] == []
    failure = normalize_event_provenance("task_failed", "task", {})
    assert failure["tool"] == "task_runtime"
    assert failure["kernel_targets"] == ["structure"]


def test_review_workbench_is_registered_without_new_kernel_writer():
    assert "review" in WORKBENCHES
    assert "spaced_review" in SKILLS
    assert "review_scheduler" in TOOLS
    assert {
        "plan_review_queue", "evaluate_review_attempt", "evaluate_transfer_variant",
        "manage_review_item",
    } <= set(ACTION_BOARD)
    assert {
        "evaluate_review_attempt", "evaluate_transfer_variant",
    } <= set(WORKBENCHES["review"].capabilities)
    assert CAPABILITY_OWNERS["plan_review_queue"][0] == "tutor_agent"
    assert CAPABILITY_OWNERS["evaluate_review_attempt"][0] == "practice_agent"
    assert EVENTS["review_attempt_evaluated"].kernel_targets == (
        "knowledge", "practice",
    )
    for event_type in {
        "review_item_skipped", "review_item_deferred",
        "review_item_suspended", "review_item_resumed",
    }:
        assert EVENTS[event_type].kernel_targets == ()
    assert {
        tool.id for tool in TOOLS.values() if tool.writes_kernels
    } == {"five_kernel_reducer"}


def test_focused_micro_learning_reuses_existing_agent_and_evidence_authority():
    assert "focused_learning" in WORKBENCHES
    assert {"verified_micro_learning", "feynman_teach_back"} <= set(SKILLS)
    assert {"micro_learning_orchestrator", "teach_back_analyzer"} <= set(TOOLS)
    assert {
        "start_micro_learning", "continue_micro_learning", "analyze_teach_back",
    } <= set(ACTION_BOARD)
    assert CAPABILITY_OWNERS["start_micro_learning"][0] == "tutor_agent"
    assert CAPABILITY_OWNERS["analyze_teach_back"][0] == "practice_agent"
    assert EVENTS["teach_back_analyzed"].kernel_targets == ("knowledge", "practice")
    assert EVENTS["micro_learning_completed"].kernel_targets == ()
    assert len(AGENTS) == 3
    assert {
        tool.id for tool in TOOLS.values() if tool.writes_kernels
    } == {"five_kernel_reducer"}


def test_learning_task_runtime_is_registered_as_zero_evidence_coordination():
    assert "learning_tasks" in WORKBENCHES
    assert WORKBENCHES["learning_tasks"].surface == "/tasks"
    assert "atomic_learning_loop" in SKILLS
    assert {"learning_task_runtime", "learning_task_planner"} <= set(TOOLS)
    assert {
        "manage_learning_tasks", "plan_learning_task", "run_learning_task",
    } <= set(ACTION_BOARD)
    assert CAPABILITY_OWNERS["manage_learning_tasks"][0] == "tutor_agent"
    assert CAPABILITY_OWNERS["plan_learning_task"][0] == "learning_design_agent"
    assert CAPABILITY_OWNERS["run_learning_task"][0] == "tutor_agent"
    assert "deterministic runtime projection" in TOOLS["learning_task_runtime"].write_path
    assert TOOLS["learning_task_planner"].reads_kernels == ("human",)
    assert "bounded model enhancement" in TOOLS["learning_task_planner"].write_path
    assert "deterministic fallback" in TOOLS["micro_learning_orchestrator"].write_path
    assert "persisted lecture/questions" in SKILLS["atomic_learning_loop"].output_contract
    assert all(
        EVENTS[event_id].kernel_targets == ()
        for event_id in {
            "learning_task_created", "learning_task_accepted",
            "learning_task_replanned", "learning_task_started",
            "learning_task_paused", "learning_task_resumed",
            "learning_task_phase_completed", "learning_task_materialized",
            "learning_task_completed", "learning_task_canceled",
        }
    )
    assert len(AGENTS) == 3
    assert {
        tool.id for tool in TOOLS.values() if tool.writes_kernels
    } == {"five_kernel_reducer"}


def test_conversational_learning_skills_are_registered_without_mastery_side_effects():
    assert {
        "guided_explanation", "socratic_dialogue", "feynman_dialogue",
        "worked_example_fading", "learning_file_study",
    } == {item["id"] for item in selectable_learning_skill_manifest()}
    assert all(item["atomic_task_capable"] for item in selectable_learning_skill_manifest())
    assert all(item["spec_version"] == SKILL_SPEC_VERSION for item in selectable_learning_skill_manifest())
    assert all(item["runtime"]["states"][-1]["id"] == "verification_ready" for item in selectable_learning_skill_manifest())
    assert all(item["runtime"]["verification_required"] for item in selectable_learning_skill_manifest())
    assert "use_learning_skill" in ACTION_BOARD
    assert CAPABILITY_OWNERS["use_learning_skill"] == (
        "tutor_agent", "tutor_context", "global_tutor",
    )
    assert EVENTS["learning_skill_selected"].kernel_targets == ()
    assert WORKBENCHES["global_tutor"].surface == "/agent/:sessionId"
    assert "use_learning_skill" in WORKBENCHES["global_tutor"].capabilities
    assert {
        "start_learning_skill_run", "advance_learning_skill_run",
        "start_skill_verification",
    } <= set(WORKBENCHES["global_tutor"].capabilities)
    assert CAPABILITY_OWNERS["start_learning_skill_run"] == (
        "tutor_agent", "learning_skill_runtime", "global_tutor",
    )
    assert {
        "learning_skill_run_started", "learning_skill_run_advanced",
        "learning_skill_run_paused", "learning_skill_run_resumed",
        "learning_skill_calibration_updated", "learning_skill_teach_back_diagnostic_updated",
        "learning_skill_verification_started", "learning_skill_run_completed",
    } <= set(EVENTS)
    assert all(
        EVENTS[event_id].kernel_targets == ()
        for event_id in {
            "learning_skill_run_started", "learning_skill_run_advanced",
            "learning_skill_run_paused", "learning_skill_run_resumed",
            "learning_skill_calibration_updated", "learning_skill_teach_back_diagnostic_updated",
            "learning_skill_verification_started", "learning_skill_run_completed",
        }
    )
    assert "learning_skill_runtime" in SKILLS["socratic_dialogue"].tools
    assert "不得把它当成有效尝试或推进步骤" in SKILLS["socratic_dialogue"].invocation_prompt
    assert "learning_skill_runtime" in SKILLS["feynman_dialogue"].tools
    feynman_runtime = SKILLS["feynman_dialogue"].runtime
    assert feynman_runtime is not None
    assert feynman_runtime.version == "atomic-learning-skill-runtime-v6"
    assert feynman_runtime.turn_budget == 5
    assert {axis.id for axis in feynman_runtime.calibration_axes} == {
        "audience_level", "cognitive_demand", "scaffold_level", "representation_mode",
    }
    assert "TeachBackDiagnostic" in feynman_runtime.output_objects
    assert "只围绕诊断中的一个候选缺口" in SKILLS["feynman_dialogue"].invocation_prompt
    assert "learning_task_runtime" in SKILLS["guided_explanation"].tools
    assert "learning_task_runtime" in SKILLS["worked_example_fading"].tools
    file_runtime = SKILLS["learning_file_study"].runtime
    assert file_runtime is not None
    assert [state.id for state in file_runtime.states] == [
        "selecting_learning_artifact", "reading_with_anchor",
        "practicing_in_file", "verification_ready",
    ]
    assert "active_learning_file_reader" in SKILLS["learning_file_study"].tools
    assert "active_paper_artifact" in file_runtime.required_context
    assert "PaperArtifactHandoff" in file_runtime.output_objects
    assert TOOL_INTERFACE_ROLES["active_learning_file_reader"] == "aci_tool"
    assert CAPABILITY_OWNERS["read_active_learning_file"] == (
        "tutor_agent", "active_learning_file_reader", "vnext_chat",
    )
    assert SKILLS["assessment_blueprint_design"].learner_selectable is False
    assert "assessment_blueprint_builder" in TOOLS
    assert EVENTS["assessment_blueprint_proposed"].kernel_targets == ()
    assert CAPABILITY_OWNERS["design_assessment_blueprint"] == (
        "learning_design_agent", "assessment_blueprint_builder", "vnext_chat",
    )
    assert len(AGENTS) == 3


def test_frontend_learning_skill_manifest_matches_registry_authority():
    path = Path(__file__).resolve().parents[2] / "frontend" / "src" / "generated" / "learning-skill-manifest.json"
    registry_payload = json.loads(json.dumps(frontend_learning_skill_manifest(), ensure_ascii=False))
    assert json.loads(path.read_text(encoding="utf-8")) == registry_payload


def test_desktop_pet_is_registered_without_kernel_or_evidence_writes():
    pet_capabilities = {
        "desktop_pet_companion", "desktop_pet_task_control",
        "desktop_pet_main_navigation", "desktop_pet_context_attachment",
    }
    assert "desktop_pet" in WORKBENCHES
    workbench = WORKBENCHES["desktop_pet"]
    assert workbench.surface == "tauri://pet"
    assert workbench.owner_agent == "tutor_agent"
    assert workbench.origin == "desktop"
    assert "coordinate_vnext_agent_turn" in workbench.capabilities
    assert pet_capabilities <= set(workbench.capabilities)
    assert pet_capabilities <= set(ACTION_BOARD)
    assert pet_capabilities <= set(CAPABILITY_OWNERS)
    for capability in pet_capabilities:
        assert CAPABILITY_OWNERS[capability] == (
            "tutor_agent", "desktop_pet_gateway", "desktop_pet",
        )
    assert TOOL_INTERFACE_ROLES["desktop_pet_gateway"] == "adapter"
    assert TOOL_INTERFACE_ROLES["desktop_pet_vision_observer"] == "adapter"
    assert TOOL_MODEL_EXPOSURE["desktop_pet_gateway"] == "not_model_callable"
    assert TOOL_MODEL_EXPOSURE["desktop_pet_vision_observer"] == "not_model_callable"
    assert TOOLS["desktop_pet_gateway"].writes_kernels == ()
    assert TOOLS["desktop_pet_vision_observer"].writes_kernels == ()
    assert "EvidenceEvent" in TOOLS["desktop_pet_gateway"].write_path
    assert "KernelState" in TOOLS["desktop_pet_gateway"].write_path
    assert "never enter AgentMessage" in TOOLS["desktop_pet_vision_observer"].write_path
    manifest = registry_manifest()
    workbench_rows = {row["id"]: row for row in manifest["workbenches"]}
    capability_rows = {row["capability"]: row for row in manifest["capabilities"]}
    assert workbench_rows["desktop_pet"]["lifecycle"] == "implemented"
    assert workbench_rows["desktop_pet"]["binding_ids"] == ["workbench:desktop_pet"]
    assert workbench_rows["desktop_pet"]["available"] is True
    assert workbench_rows["desktop_pet"]["lifecycle_note"] == ""
    for capability in pet_capabilities:
        assert capability_rows[capability]["lifecycle"] == "implemented"
        assert capability_rows[capability]["binding_ids"] == [
            "api:pet.bootstrap", "api:pet.context", "api:pet.selection_text",
        ]
        assert capability_rows[capability]["available"] is True
        assert capability in manifest["available_capabilities"]
    assert capability_rows["desktop_pet_context_attachment"]["workbench"] == "desktop_pet"
    # A desktop pet registration must never introduce a new kernel writer.
    assert {
        tool.id for tool in TOOLS.values() if tool.writes_kernels
    } == {"five_kernel_reducer"}


def test_learner_growth_is_an_additive_read_only_workbench():
    growth = WORKBENCHES["learner_growth"]
    assert growth.surface == "/growth"
    assert growth.owner_agent == "tutor_agent"
    assert growth.capabilities == ()
    assert {"profile", "memory"} <= set(WORKBENCHES)
    assert {
        tool.id for tool in TOOLS.values() if tool.writes_kernels
    } == {"five_kernel_reducer"}
