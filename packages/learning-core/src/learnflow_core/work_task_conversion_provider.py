"""Projectless use of the existing Xingchen transport and deterministic validator."""
import asyncio
from app.services import xingchen_learning_task_candidates as xingchen


async def generate_learning(conversion_id: str, learner_id: int, brief: dict, source_refs: list, request_id: str) -> dict:
    # These are task-definition inputs, not invented SourceVersion database rows.
    # Keep full provenance in the draft and show the provider's wire truncation.
    text = "；".join([brief["task_description"], brief["work_context"], "交付：" + brief["deliverable"],
                       "验收：" + "；".join(brief["acceptance_criteria"]), "约束：" + "；".join(brief["constraints"])])
    source_hash = xingchen.canonical_hash({"brief": brief, "source_refs": source_refs})
    snapshot = xingchen.SourceSnapshot(
        package_id="learnflow-conversion:" + conversion_id, package_version="brief." + source_hash[:12],
        snapshot_id="conversion_snapshot_" + source_hash[:20], root_hash=source_hash,
        bindings=[], citations=[],
        segments=[{"citationId": "task_definition", "sourceVersionId": "brief:" + source_hash[:16], "text": text}],
        coverage={"availableSegmentCount": 1, "availableCharacters": len(text), "sourceVersionCount": 0},
        warnings=[{"code": "task_definition_only", "message": "输入是已确认工作任务定义，未接入外部事实资料；生成内容不构成岗位事实或掌握证据。"}],
    )
    snapshot = xingchen._provider_bounded_snapshot(snapshot)
    base = xingchen._base_provider_input(request_id=request_id, task_title=brief["task_title"],
        task_description=brief["task_description"], source_snapshot=snapshot, target_step_count=4)
    client = xingchen.XingchenWorkflowClient()
    provider_input = base
    run_ids = []
    # Cancellation from the persisted generation lease also bounds repairs.
    async with asyncio.timeout(390):
        for attempt in range(3):
            run = await client.run(provider_input, uid=f"lf-{learner_id}-{conversion_id[-20:]}")
            if run.get("runId"):
                run_ids.append(str(run["runId"]))
            try:
                bundle, output = await xingchen._bundle_from_run(run, None)
                candidate = xingchen.bundle_to_candidate(bundle,
                    candidate_id="ltc_" + xingchen.canonical_hash({"conversion": conversion_id, "request": request_id})[:28],
                    request_id=request_id, task_title=brief["task_title"], source_snapshot=snapshot,
                    provider_run={**run, "workflowRunIds": run_ids, "workflowOutput": output},
                    target_step_count=4, upstream_task={"source_ref": "work-task-conversion://" + conversion_id})
                # Candidate paths may include signed provider download URLs.
                # They are transport credentials, not a source reference.
                candidate["provenance"]["workflowArtifacts"] = {
                    key: value for key, value in output.items() if not key.endswith("url")
                }
                return candidate
            except xingchen.LearningTaskIntegrationError as exc:
                if exc.code not in {"bundle_contract_invalid", "candidate_validation_failed", "workflow_artifact_missing", "workflow_review_failed"} or attempt == 2:
                    raise
                provider_input = xingchen._repair_provider_input(base, exc, attempt + 1)
    raise RuntimeError("generation_interrupted")
