import { z } from "zod/v4";
import type { ColdStartBuildResult, WebResearchReport } from "@/lib/build/types";
import type { PlannedQuery } from "@/lib/search/web-research";
import { snapshotReferenceSchema, type SnapshotReference } from "@/lib/snapshots/types";

export const riskModeSchema = z.enum(["scan", "repair", "deepen", "temporal_refresh", "verify"]);
export const riskProfileSchema = z.enum([
  "structural",
  "semantic",
  "task_quality",
  "capability_skill",
  "evidence",
  "temporal",
  "process",
  "effectiveness",
]);

export const riskRunRequestSchema = z.object({
  runId: z.string().min(4).max(100),
  snapshotRef: snapshotReferenceSchema,
  projectId: z.string().min(4).max(100).optional(),
  conversationId: z.string().min(4).max(100).optional(),
  baseVersionId: z.string().max(220).optional(),
  mode: riskModeSchema.default("repair"),
  scope: z.object({
    targetIds: z.array(z.string().max(220)).max(60).default([]),
    profiles: z.array(riskProfileSchema).max(8).default([]),
    question: z.string().max(2_000).default(""),
  }).default({ targetIds: [], profiles: [], question: "" }),
  targetAsOf: z.string().max(40).optional(),
  webResearch: z.boolean().default(true),
  maxIterations: z.number().int().min(1).max(4).default(4),
  sourceLimit: z.number().int().min(4).max(64).default(64),
});

export type RiskRunRequest = z.infer<typeof riskRunRequestSchema>;
export type RiskMode = z.infer<typeof riskModeSchema>;
export type RiskProfile = z.infer<typeof riskProfileSchema>;
export type RiskSeverity = "info" | "warning" | "error";
export type RiskRepairability = "automatic" | "research" | "user" | "organization_specific" | "developer";

export type RiskIssue = {
  id: string;
  fingerprint: string;
  profile: RiskProfile;
  severity: RiskSeverity;
  code: string;
  title: string;
  detail: string;
  impact: string;
  confidence: number;
  targetIds: string[];
  evidenceBindingIds: string[];
  sourceIds: string[];
  repairability: RiskRepairability;
  status: "open" | "researching" | "evidence_ready" | "patch_proposed" | "resolved" | "known_gap" | "rejected";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedInVersionId?: string;
};

export type RiskCluster = {
  id: string;
  title: string;
  summary: string;
  profile: RiskProfile;
  severity: RiskSeverity;
  issueIds: string[];
  targetIds: string[];
  repairability: RiskRepairability[];
  researchQuestion?: string;
  priority: number;
};

export type RiskHealthMetrics = {
  score: number;
  issueWeight: number;
  errors: number;
  warnings: number;
  evidenceCoverage: number;
  directEvidenceCoverage: number;
  processCoverage: number;
  sourceDomainDiversity: number;
  semanticOverlapClusters: number;
  unsupportedTargets: number;
  inferredProcessRatio: number;
  effectivenessCoverage: number;
};

export type RiskAuditReport = {
  snapshotId: string;
  snapshotAsOf: string;
  generatedAt: string;
  profiles: RiskProfile[];
  issues: RiskIssue[];
  clusters: RiskCluster[];
  metrics: RiskHealthMetrics;
};

export type RiskResearchPlan = {
  id: string;
  iteration: number;
  clusterIds: string[];
  queries: PlannedQuery[];
  rationale: string[];
  stopConditions: string[];
};

export type GraphPatchOperation =
  | { op: "remove_semantic_edge"; edgeId: string; reason: string; issueIds: string[] }
  | { op: "remove_process_edge"; edgeId: string; reason: string; issueIds: string[] }
  | { op: "remove_source"; sourceId: string; reason: string; issueIds: string[] }
  | { op: "merge_semantic_nodes"; canonicalId: string; mergedIds: string[]; reason: string; issueIds: string[] }
  | { op: "update_semantic_node"; nodeId: string; changes: Record<string, unknown>; reason: string; issueIds: string[] };

export type GraphPatch = {
  id: string;
  baseSnapshotId: string;
  status: "proposed" | "applied" | "rejected";
  iteration: number;
  operations: GraphPatchOperation[];
  targetIds: string[];
  issueIds: string[];
  summary: string;
  createdAt: string;
};

export type SemanticDiff = {
  baseSnapshotId: string;
  candidateSnapshotId: string;
  summary: string;
  versionBump: "patch" | "minor" | "major";
  nodes: { added: string[]; removed: string[]; updated: string[]; merged: Array<{ from: string[]; to: string }> };
  edges: { added: string[]; removed: string[]; updated: string[] };
  process: { scenariosAdded: string[]; scenariosRemoved: string[]; nodesAdded: string[]; nodesRemoved: string[] };
  sources: { added: string[]; removed: string[] };
  issues: { resolved: string[]; introduced: string[]; remaining: string[] };
  referenceMigration: Record<string, string>;
};

export type RiskRunResult = {
  runId: string;
  snapshotRef: SnapshotReference;
  projectId?: string;
  baseVersionId: string;
  baseSnapshotId: string;
  mode: RiskMode;
  status: "completed" | "waiting_user" | "no_improvement";
  auditBefore: RiskAuditReport;
  auditAfter: RiskAuditReport;
  researchPlans: RiskResearchPlan[];
  researchReports: WebResearchReport[];
  patches: GraphPatch[];
  diff: SemanticDiff;
  candidate: ColdStartBuildResult;
  improved: boolean;
  improvementSummary: string[];
  knownGaps: RiskIssue[];
  candidateVersionId?: string;
};

export type RiskEventKind =
  | "risk.run.started"
  | "risk.baseline.pinned"
  | "risk.audit.started"
  | "risk.audit.issue.found"
  | "risk.audit.clustered"
  | "risk.research.plan.created"
  | "risk.search.started"
  | "risk.search.completed"
  | "risk.search.failed"
  | "risk.research.completed"
  | "risk.candidate.rebuilt"
  | "risk.patch.proposed"
  | "risk.patch.applied"
  | "risk.validation.completed"
  | "risk.iteration.completed"
  | "risk.version.created"
  | "risk.run.completed"
  | "risk.run.failed";

export type RiskEvent = {
  version: "1.0";
  runId: string;
  snapshotId: string;
  projectId?: string;
  seq: number;
  time: string;
  kind: RiskEventKind;
  phase: "baseline" | "audit" | "research" | "repair" | "validate" | "version" | "system";
  payload: Record<string, unknown>;
};
