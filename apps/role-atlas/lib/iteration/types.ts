import { z } from "zod/v4";
import { learningPathGraphInputSchema, sourceInputSchema, type ColdStartBuildResult, type SourceInput, type WebResearchReport } from "@/lib/build/types";
import type { PlannedQuery } from "@/lib/search/web-research";
import { snapshotReferenceSchema, type SnapshotReference } from "@/lib/snapshots/types";
import type { GraphPatch, RiskAuditReport, RiskIssue, SemanticDiff } from "@/lib/risk/types";

export const initiativeProfileSchema = z.enum(["autonomous", "co_guided", "user_directed"]);
export const iterationModeSchema = z.enum(["auto", "freshness", "deep_research", "risk_repair"]);
export const iterationIntentSchema = z.enum(["repair", "expand", "refresh", "instantiate", "verify"]);
export const iterationFindingLayerSchema = z.enum([
  "protocol",
  "semantic",
  "coverage",
  "evidence",
  "temporal",
  "process",
  "agent",
]);

export const snapshotIterationRequestSchema = z.object({
  runId: z.string().min(4).max(100),
  snapshotRef: snapshotReferenceSchema,
  projectId: z.string().min(4).max(100).optional(),
  conversationId: z.string().min(4).max(100).optional(),
  initiativeProfile: initiativeProfileSchema.default("co_guided"),
  mode: iterationModeSchema.default("auto"),
  prompt: z.string().max(4_000).default(""),
  targetIds: z.array(z.string().max(220)).max(60).default([]),
  targetAsOf: z.string().max(40).optional(),
  supplementalSources: z.array(sourceInputSchema).max(64).default([]),
  learningPathGraph: learningPathGraphInputSchema,
  learningMountFeedback: z.array(z.object({ roleNodeId: z.string().min(1).max(220), reason: z.string().max(1_000), researchGoal: z.string().max(1_500) })).max(40).default([]),
  webResearch: z.boolean().default(true),
  maxRounds: z.number().int().min(1).max(12).default(12),
  sourceLimit: z.number().int().min(4).max(64).default(64),
  maxWorkItems: z.number().int().min(3).max(32).default(32),
});

export type InitiativeProfile = z.infer<typeof initiativeProfileSchema>;
export type IterationMode = z.infer<typeof iterationModeSchema>;
export type IterationIntent = z.infer<typeof iterationIntentSchema>;
export type IterationFindingLayer = z.infer<typeof iterationFindingLayerSchema>;
export type SnapshotIterationRequest = Omit<z.infer<typeof snapshotIterationRequestSchema>, "mode" | "learningMountFeedback"> & {
  learningMountFeedback?: Array<{ roleNodeId: string; reason: string; researchGoal: string }>;
  /** Optional for callers created before the three-mode product contract. */
  mode?: IterationMode;
};

export type IterationContract = {
  id: string;
  initiativeProfile: InitiativeProfile;
  mode: IterationMode;
  objective: string;
  learningMountFeedback?: Array<{ roleNodeId: string; reason: string; researchGoal: string }>;
  targetIds: string[];
  targetAsOf: string;
  changeIntents: IterationIntent[];
  evidencePolicy: string[];
  budgets: {
    maxRounds: number;
    maxSources: number;
    maxWorkItems: number;
    graphRadius: number | "global";
  };
  acceptancePolicy: string[];
  stopConditions: string[];
  inferredFrom: string[];
};

export type IterationFinding = {
  id: string;
  layer: IterationFindingLayer;
  classification: "invariant" | "core_usability" | "research";
  severity: "info" | "warning" | "error";
  code: string;
  title: string;
  detail: string;
  impact: string;
  targetIds: string[];
  evidenceBindingIds: string[];
  confidence: number;
  suggestedAction: "automatic" | "research" | "user" | "organization_specific" | "developer";
  hardBlocker: boolean;
};

export type AgentProbe = {
  id: string;
  label: string;
  status: "passed" | "warning" | "failed";
  detail: string;
  targetIds: string[];
};

export type SnapshotInspection = {
  snapshotId: string;
  generatedAt: string;
  protocolValid: boolean;
  hardBlockers: IterationFinding[];
  findings: IterationFinding[];
  audit: RiskAuditReport;
  axes: {
    structuralValidity: number;
    semanticClarity: number;
    evidenceReadiness: number;
    temporalIntegrity: number;
    processCoverage: number;
    agentUsability: number;
  };
  core: {
    nodeCount: number;
    acceptedNodeCount: number;
    errorCount: number;
    unsupportedAcceptedCount: number;
  };
  frontier: {
    candidateNodeCount: number;
    researchFindingCount: number;
    openTopicCount: number;
  };
  coverage: {
    tasks: number;
    knowledgeSkills: number;
    tasksWithoutSkills: number;
    tasksWithoutProcess: number;
    evidenceCoverage: number;
    directEvidenceCoverage: number;
  };
  agentProbes: AgentProbe[];
};

export type IterationOpportunity = {
  id: string;
  origin: "user" | "inspector" | "time_clock" | "workspace";
  title: string;
  detail: string;
  targetIds: string[];
  findingIds: string[];
  intents: IterationIntent[];
  expectedValue: number;
  requiresResearch: boolean;
};

export type IterationWorkItem = {
  id: string;
  kind: IterationIntent;
  origin: IterationOpportunity["origin"];
  title: string;
  detail: string;
  targetIds: string[];
  findingIds: string[];
  priority: number;
  requiresResearch: boolean;
  dependencies: string[];
  status: "planned" | "running" | "completed" | "known_gap" | "skipped";
};

export type IterationResearchPlan = {
  id: string;
  round: number;
  workItemIds: string[];
  queries: PlannedQuery[];
  rationale: string[];
  stopConditions: string[];
};

export type IterationEvaluation = {
  meaningful: boolean;
  coreRegression: boolean;
  protocolValid: boolean;
  healthImproved: boolean;
  informationGain: {
    score: number;
    newSources: number;
    newSemanticNodes: number;
    newProcessScenarios: number;
    resolvedFindings: number;
    introducedFindings: number;
  };
  objectiveSignals: string[];
  reasons: string[];
};

export type SnapshotIterationResult = {
  runId: string;
  snapshotRef: SnapshotReference;
  projectId?: string;
  baseSnapshotId: string;
  status: "completed" | "no_change" | "waiting_user";
  contract: IterationContract;
  inspectionBefore: SnapshotInspection;
  inspectionAfter: SnapshotInspection;
  opportunities: IterationOpportunity[];
  workItems: IterationWorkItem[];
  researchPlans: IterationResearchPlan[];
  researchReports: WebResearchReport[];
  patches: GraphPatch[];
  diff: SemanticDiff;
  evaluation: IterationEvaluation;
  candidate: ColdStartBuildResult;
  createdSnapshot: boolean;
  summary: string[];
  knownGaps: IterationFinding[];
  candidateSnapshotId?: string;
  projectVersionId?: string;
};

export type IterationEventPhase = "contract" | "inspect" | "plan" | "research" | "rebuild" | "consolidate" | "evaluate" | "snapshot" | "system";

export type IterationEventKind =
  | "iteration.run.started"
  | "iteration.snapshot.resolved"
  | "iteration.contract.created"
  | "iteration.inspection.started"
  | "iteration.finding.discovered"
  | "iteration.inspection.completed"
  | "iteration.opportunities.created"
  | "iteration.work.plan.created"
  | "iteration.work.item.started"
  | "iteration.work.item.completed"
  | "iteration.research.plan.created"
  | "iteration.search.started"
  | "iteration.search.completed"
  | "iteration.search.failed"
  | "iteration.research.completed"
  | "iteration.candidate.rebuild.started"
  | "iteration.candidate.rebuilt"
  | "iteration.consolidation.started"
  | "iteration.patch.proposed"
  | "iteration.patch.applied"
  | "iteration.evaluation.started"
  | "iteration.evaluation.completed"
  | "iteration.round.completed"
  | "iteration.snapshot.write.started"
  | "iteration.snapshot.created"
  | "iteration.run.completed"
  | "iteration.run.failed";

export type IterationEvent = {
  version: "1.0";
  runId: string;
  snapshotId: string;
  projectId?: string;
  seq: number;
  time: string;
  kind: IterationEventKind;
  phase: IterationEventPhase;
  payload: Record<string, unknown>;
};

export type IterationRuntimeState = {
  supplementalSources: SourceInput[];
  issues: RiskIssue[];
};
