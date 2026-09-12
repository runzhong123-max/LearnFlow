import type { WorkProcessPayload } from "@/app/components/WorkProcessForestView";
import type { ColdStartBuildResult } from "@/lib/build/types";

function evidenceFor(result: ColdStartBuildResult, bindingIds: string[]) {
  const bindings = bindingIds
    .map((id) => result.sources.evidenceBindings.find((binding) => binding.id === id))
    .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding));
  return {
    binding_refs: bindingIds,
    source_refs: [...new Set(bindings.map((binding) => binding.sourceId))],
    max_confidence: bindings.reduce((maximum, binding) => Math.max(maximum, binding.confidence), 0),
    has_segment_evidence: bindings.length > 0,
    temporal_status_counts: { current: bindings.length },
  };
}

export function projectGraphPayload(result: ColdStartBuildResult) {
  return {
    metadata: {
      snapshot_id: result.snapshot.id,
      snapshot_version: result.packages.rolePackage.packageVersion,
      generated_at: result.sources.research?.completedAt || new Date().toISOString(),
    },
    nodes: result.semantic.nodes.map((node) => ({
      ...node,
      lifecycle: "candidate" as const,
      assertion_refs: result.semantic.claims.filter((claim) => claim.subjectId === node.id || claim.objectId === node.id).map((claim) => claim.id),
      evidence_summary: evidenceFor(result, node.evidenceBindingIds),
      data: { taskDefinition: node.taskDefinition, aliases: node.aliases, confidence: node.confidence, granularity: node.granularity, facets: node.facets, expansion: node.expansion },
      packageId: result.packages.rolePackage.packageId,
      packageVersion: result.packages.rolePackage.packageVersion,
      snapshotId: result.snapshot.id,
    })),
    edges: result.semantic.edges.map((edge) => ({ ...edge, lifecycle: "candidate" as const })),
  };
}

export function projectObjectIndex(result: ColdStartBuildResult) {
  return result.semantic.nodes.map((node) => ({
    target_id: node.id,
    object_type: node.type,
    lifecycle: "candidate",
    binding_refs: node.evidenceBindingIds,
    field_states: [{ field_path: "summary", state: node.evidenceBindingIds.length ? "supported" : "candidate" }],
    related_ids: result.semantic.edges.filter((edge) => edge.source === node.id || edge.target === node.id).flatMap((edge) => [edge.id, edge.source === node.id ? edge.target : edge.source]),
    payload: { taskDefinition: node.taskDefinition, label: node.label, summary: node.summary, aliases: node.aliases, confidence: node.confidence, granularity: node.granularity, facets: node.facets, expansion: node.expansion },
  }));
}

export function projectWorkProcessPayload(result: ColdStartBuildResult): WorkProcessPayload {
  const processBinding = (bindingIds: string[], knowledgeState: string) => {
    const evidence = evidenceFor(result, bindingIds);
    return {
      assertion_type: knowledgeState === "observed_pattern" ? "observed" : knowledgeState === "documented_norm" ? "normative" : "inferred",
      method: "cold_start_extraction",
      source_refs: evidence.source_refs,
      confidence: evidence.max_confidence,
      as_of: result.snapshot.asOf,
    };
  };
  const bridgesByProcess = new Map<string, string[]>();
  for (const bridge of result.process.bridges) bridgesByProcess.set(bridge.processNodeId, [...(bridgesByProcess.get(bridge.processNodeId) || []), bridge.semanticNodeId]);
  const eventNodeIds = new Set(result.process.nodes.filter((node) => node.kind === "event" || node.kind === "decision").map((node) => node.id));
  const related = (eventId: string, edgeType: string) => result.process.edges
    .filter((edge) => edge.source === eventId && edge.type === edgeType)
    .map((edge) => edge.target);
  const kindMap = {
    event: "event",
    decision: "event",
    actor: "actor",
    work_object: "work_object",
    artifact: "artifact",
    tool_system: "tool_system",
    quality_criterion: "quality_criterion",
    exception_risk: "exception_risk",
    risk: "exception_risk",
  } as const;
  const nodes = result.process.nodes.map((node) => ({
    id: node.id,
    scenario_id: node.scenarioId,
    kind: kindMap[node.kind],
    event_type: node.eventType || (node.kind === "decision" ? "decision" as const : node.kind === "risk" || node.kind === "exception_risk" ? "exception" as const : node.kind === "event" ? "activity" as const : undefined),
    label: node.label,
    summary: node.summary,
    lane: "岗位",
    sequence_hint: node.sequenceHint,
    task_refs: node.taskRefs || result.process.bridges.filter((bridge) => bridge.processNodeId === node.id && bridge.type === "realizes_task").map((bridge) => bridge.semanticNodeId),
    capability_refs: (bridgesByProcess.get(node.id) || []).filter((id) => id.startsWith("capability:") || id.startsWith("cap:")),
    knowledge_skill_refs: result.process.bridges.filter((bridge) => bridge.processNodeId === node.id && bridge.type === "uses_skill").map((bridge) => bridge.semanticNodeId),
    artifact_refs: node.artifactRefs || (eventNodeIds.has(node.id) ? related(node.id, "produces") : []),
    actor_refs: node.actorRefs || (eventNodeIds.has(node.id) ? related(node.id, "performed_by") : []),
    lifecycle: "candidate" as const,
    evidence_binding: processBinding(node.evidenceBindingIds, node.knowledgeState),
  }));
  const scenarios = result.process.scenarios.map((scenario) => {
    const scenarioNodes = result.process.nodes.filter((node) => node.scenarioId === scenario.id);
    const eventRefs = scenarioNodes.filter((node) => eventNodeIds.has(node.id)).map((node) => node.id);
    const taskRefs = [...new Set([
      ...(bridgesByProcess.get(scenario.id) || []),
      ...scenarioNodes.flatMap((node) => bridgesByProcess.get(node.id) || []),
    ].filter((id) => id.startsWith("task:")))];
    return {
      id: scenario.id,
      title: scenario.label,
      summary: scenario.summary,
      scenario_family: "delivery",
      goal: scenario.outcome,
      trigger: scenario.trigger,
      expected_outcomes: scenario.outcome ? [scenario.outcome] : [],
      event_refs: eventRefs,
      task_refs: taskRefs,
      knowledge_state: scenario.knowledgeState,
      lifecycle: "candidate" as const,
      evidence_binding: processBinding(scenario.evidenceBindingIds, scenario.knowledgeState),
    };
  });
  const alignment = result.semantic.nodes.filter((node) => node.type === "task").map((task) => {
    const matchingNodes = result.process.bridges.filter((bridge) => bridge.type === "realizes_task" && bridge.semanticNodeId === task.id).map((bridge) => bridge.processNodeId);
    const scenarioIds = new Set(result.process.scenarios.map((scenario) => scenario.id));
    const scenarioRefs = [...new Set(matchingNodes.map((id) => scenarioIds.has(id) ? id : result.process.nodes.find((node) => node.id === id)?.scenarioId).filter((id): id is string => Boolean(id)))];
    return {
      semantic_target_id: task.id,
      scenario_refs: scenarioRefs,
      status: scenarioRefs.length ? "covered" : "gap",
      note: scenarioRefs.length ? "冷启动事理事件已桥接到该任务。" : "尚无工作场景覆盖该任务。",
    };
  });
  return {
    manifest: {
      package_id: result.packages.rolePackage.packageId,
      package_version: result.packages.rolePackage.packageVersion,
      snapshot_id: result.snapshot.id,
      status: result.packages.rolePackage.status,
    },
    validation: { warnings: result.validation.process.issues, stats: { scenarios: scenarios.length, nodes: nodes.length } },
    workProcess: {
      scenarios,
      nodes,
      relations: result.process.edges.map((edge) => ({ id: edge.id, type: edge.type, source: edge.source, target: edge.target })),
      alignment,
    },
  } as WorkProcessPayload;
}
