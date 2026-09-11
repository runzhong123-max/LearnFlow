import { z } from "zod/v4";

export const sourceKindSchema = z.enum([
  "user_brief",
  "public_document",
  "private_document",
  "workspace_observation",
]);

export const workspaceEvidenceSchema = z.object({
  workspacePackageId: z.string().min(1).max(180),
  adapterId: z.string().min(1).max(80),
  resourceIds: z.array(z.string().min(1).max(180)).max(40).default([]),
  episodeId: z.string().max(180).optional(),
  evidenceClass: z.enum([
    "real_work_activity",
    "curated_real_case",
    "production_trace",
    "controlled_experiment",
    "teaching_simulation",
    "synthetic_fixture",
  ]),
  license: z.string().max(120).optional(),
  publicLocator: z.string().url().max(500).optional(),
  observedFrom: z.string().max(80).optional(),
});

export const sourceInputSchema = z.object({
  attachmentId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(60_000),
  kind: sourceKindSchema.default("private_document"),
  locator: z.string().max(500).optional(),
  observedAt: z.string().max(80).optional(),
  publisher: z.string().max(240).optional(),
  domain: z.string().max(240).optional(),
  publishedAt: z.string().max(80).optional(),
  fetchedAt: z.string().max(80).optional(),
  sourceTier: z.enum(["authoritative", "primary", "secondary", "contextual"]).optional(),
  queryIds: z.array(z.string().max(160)).max(16).optional(),
  searchCategories: z.array(z.string().max(80)).max(12).optional(),
  retrievalScore: z.number().min(0).max(1).optional(),
  provider: z.string().max(80).optional(),
  providerRequestIds: z.array(z.string().max(160)).max(24).optional(),
  extractionMethod: z.enum(["search_content", "provider_extract", "direct_fetch"]).optional(),
  workspaceEvidence: workspaceEvidenceSchema.optional(),
});

export const learningPathNodeInputSchema = z.object({
  id: z.string().min(1).max(180),
  title: z.string().min(1).max(160),
  summary: z.string().max(1_000).default(""),
  aliases: z.array(z.string().max(120)).max(16).default([]),
  domains: z.array(z.string().max(80)).max(16).default([]),
  audiences: z.array(z.enum(["vocational", "undergraduate", "graduate", "self_directed"])).max(4).default([]),
  stage: z.enum(["foundation", "core", "domain", "advanced", "research"]),
  order: z.number().int().min(0).max(1_000),
  origin: z.enum(["official", "personal"]),
  sourceRefs: z.array(z.string().max(500)).max(16).default([]),
  sourceProposalId: z.string().max(180).optional(),
});

export const learningPathEdgeInputSchema = z.object({
  id: z.string().min(1).max(180),
  from: z.string().min(1).max(180),
  to: z.string().min(1).max(180),
  kind: z.enum(["hard_prerequisite", "soft_prerequisite", "co_learning"]),
  rationale: z.string().max(500).default(""),
  origin: z.enum(["official", "personal"]),
});

export const learningPathGraphInputSchema = z.object({
  protocolVersion: z.literal("learnflow-learning-path/v1"),
  nodes: z.array(learningPathNodeInputSchema).max(240),
  edges: z.array(learningPathEdgeInputSchema).max(500),
}).optional();

export const coldStartRequestSchema = z.object({
  runId: z.string().min(4).max(100),
  projectId: z.string().min(4).max(100),
  roleTitle: z.string().min(2).max(120),
  roleDescription: z.string().max(8_000).default(""),
  market: z.string().max(120).default("中国大陆"),
  audience: z.array(z.string().min(1).max(80)).max(8).default(["高职学生", "教师"]),
  snapshotAsOf: z.string().max(40).default(() => new Date().toISOString().slice(0, 10)),
  sources: z.array(sourceInputSchema).max(20).default([]),
  /** Optional LearnFlow-owned graph used only to build a read-only role projection. */
  learningPathGraph: learningPathGraphInputSchema,
});

export type ColdStartRequest = z.infer<typeof coldStartRequestSchema>;
export type SourceKind = z.infer<typeof sourceKindSchema>;
export type SourceInput = z.infer<typeof sourceInputSchema>;
export type WorkspaceEvidence = z.infer<typeof workspaceEvidenceSchema>;
export type LearningPathGraphInput = NonNullable<z.infer<typeof learningPathGraphInputSchema>>;

export const webSearchCategorySchema = z.enum([
  "official_standard",
  "job_market",
  "work_practice",
  "technology",
  "education",
  "future_signal",
  "user_focus",
]);
export type WebSearchCategory = z.infer<typeof webSearchCategorySchema>;

export type WebResearchReport = {
  provider: string;
  providerName: string;
  planStrategy?: "model_assisted" | "deterministic";
  plannerFallbackReason?: string;
  startedAt: string;
  completedAt: string;
  queries: Array<{
    id: string;
    category: WebSearchCategory;
    query: string;
    resultCount: number;
    requestId?: string;
    responseTimeMs?: number;
    credits?: number;
  }>;
  selectedSourceCount: number;
  candidateCount: number;
  deduplicatedCount: number;
  candidates: Array<{
    title: string;
    url: string;
    domain: string;
    queryIds: string[];
    categories: WebSearchCategory[];
    providerScore?: number;
    relevanceScore: number;
    rankingScore: number;
    disposition: "selected" | "duplicate_content" | "low_relevance" | "domain_limit" | "source_limit" | "unreadable" | "foreign_occupation";
    duplicateOf?: string;
  }>;
  categoryCoverage: Array<{
    category: WebSearchCategory;
    queryCount: number;
    candidateCount: number;
    selectedSourceCount: number;
    status: "covered" | "missing" | "failed";
  }>;
  failures: Array<{ queryId: string; message: string }>;
  extraction?: {
    requestCount: number;
    requestedSourceCount: number;
    extractedSourceCount: number;
    failedSourceCount: number;
    requestIds: string[];
  };
  usage?: { searchCredits: number; extractCredits: number; totalCredits: number };
};

export type ProjectBrief = {
  projectId: string;
  roleTitle: string;
  roleDescription: string;
  market: string;
  audience: string[];
  snapshotAsOf: string;
  assumptions: string[];
};

export type SourceAsset = {
  attachmentId?: string;
  id: string;
  title: string;
  kind: SourceKind;
  locator?: string;
  observedAt?: string;
  publisher?: string;
  domain?: string;
  publishedAt?: string;
  fetchedAt?: string;
  sourceTier?: "authoritative" | "primary" | "secondary" | "contextual";
  queryIds?: string[];
  searchCategories?: string[];
  retrievalScore?: number;
  provider?: string;
  providerRequestIds?: string[];
  extractionMethod?: "search_content" | "provider_extract" | "direct_fetch";
  workspaceEvidence?: WorkspaceEvidence;
  contentHash: string;
  visibility: "project_private" | "publishable_metadata";
  qualification?: SourceQualification;
  /** Human-auditable source class used by curated and golden packages. */
  sourceType?: "official_classification" | "occupation_standard" | "education_standard" | "regulation" | "job_posting" | "official_technical_documentation" | "industry_standard" | "repository_issue" | "research_literature";
  independenceGroup?: string;
  limitations?: string[];
};

export type SourceSegment = {
  id: string;
  sourceId: string;
  ordinal: number;
  text: string;
  contentHash: string;
  /** Stable locator fields are optional for backward compatibility. */
  locator?: string;
  page?: number;
  section?: string;
  paragraph?: string;
  observedAt?: string;
  excerptType?: "verbatim" | "close_paraphrase" | "research_note";
};

export const evidenceRoleSchema = z.enum([
  "role_boundary",
  "official_standard",
  "job_market",
  "work_practice",
  "technology_primary",
  "education",
  "future_signal",
  "workspace_observation",
]);

export type EvidenceRole = z.infer<typeof evidenceRoleSchema>;

export type SourceQualification = {
  status: "accepted" | "limited" | "quarantined";
  evidenceRoles: EvidenceRole[];
  reasons: string[];
};

export type EvidenceSpan = {
  segmentId: string;
  quote: string;
  start?: number;
  end?: number;
};

export const conceptMentionKindSchema = z.enum([
  "role_context",
  "task",
  "knowledge_skill",
  "capability_signal",
  "work_event",
  "actor",
  "work_object",
  "deliverable",
  "risk",
  "decision",
]);

export type ConceptMentionKind = z.infer<typeof conceptMentionKindSchema>;

/**
 * Source-bound extraction record. Mentions deliberately remain separate from
 * canonical graph nodes so reruns can reuse evidence without silently changing
 * a published node identity.
 */
export type ConceptMention = {
  id: string;
  runId: string;
  kind: ConceptMentionKind;
  surfaceForm: string;
  normalizedForm: string;
  definitionHint: string;
  attributes: Record<string, string>;
  sourceSegmentId: string;
  evidenceSpan?: EvidenceSpan;
  confidence: number;
  createdByWorkItem: string;
};

export type RelationProposition = {
  id: string;
  runId: string;
  subjectMentionId: string;
  predicateHint: string;
  objectMentionId: string;
  qualifiers: Record<string, string>;
  sourceSegmentId: string;
  evidenceSpan?: EvidenceSpan;
  assertionMode: "explicit" | "inferred";
  confidence: number;
  materializationStatus: "pending" | "materialized" | "rejected";
};

export type BuildWorkItemSummary = {
  id: string;
  stage: string;
  lane: string;
  inputRefs: string[];
  status: "queued" | "running" | "completed" | "failed" | "recovered" | "skipped";
  attempt: number;
  priority: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  actualDurationMs?: number;
  outputRefs: string[];
  cacheKey: string;
  cacheHit?: boolean;
  error?: string;
};

export type ColdStartBuildMetrics = {
  firstTaskSkeletonMs?: number;
  firstKernelMs?: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  cacheHits: number;
  failedWorkItems: number;
  targetedResearchQueries: number;
};

export type EvidenceBinding = {
  id: string;
  targetId: string;
  fieldPath: string;
  sourceId: string;
  segmentId: string;
  support: "direct" | "inferred";
  method: "user_assertion" | "model_extraction" | "compiler";
  confidence: number;
  evidenceSpan?: EvidenceSpan;
  mentionIds?: string[];
  /** Curated assertion semantics. Numeric confidence remains a compatibility projection. */
  assertionType?: "direct_fact" | "cross_source_synthesis" | "research_inference" | "disputed";
  supportRole?: "supports" | "corroborates" | "limits" | "contradicts";
  strength?: "strong" | "moderate" | "weak";
  limitations?: string[];
  rationale?: string;
};

export const semanticNodeTypeSchema = z.enum([
  "market_role",
  "industry_chain_node",
  "job_family",
  "occupation_standard",
  "related_role",
  "task",
  "capability",
  "capability_unit",
  "knowledge_skill",
]);

export type SemanticNodeType = z.infer<typeof semanticNodeTypeSchema>;

export type SemanticNode = {
  id: string;
  type: SemanticNodeType;
  label: string;
  summary: string;
  aliases: string[];
  lifecycle: "candidate" | "stable" | "rejected";
  confidence: number;
  evidenceSegmentIds: string[];
  evidenceBindingIds: string[];
  ring: number;
  /** Required only for knowledge_skill nodes in curated packages. */
  learningKind?: "knowledge" | "skill" | "hybrid";
  /** Explicit atomic semantics. Missing/legacy hybrid definitions stay unresolved in v2. */
  learningDefinition?: { scopeNote: string; assessmentCriteria: string[] };
  /** Candidate course organization, never a canonical path ID or mastery evidence. */
  learningCourse?: { title: string; scopeNote: string };
  /** Daily cultivation contract. Required for newly generated capability units. */
  cultivation?: CapabilityUnitCultivation;
  applicability?: string;
  observableOutcome?: string;
  /** Multi-resolution projection metadata. The full fact layer is retained. */
  granularity?: "kernel" | "detail";
  defaultVisibility?: boolean;
  parentKernelId?: string;
  facets?: Array<{ label: string; nodeId?: string; summary?: string }>;
  expansion?: {
    status: "queued" | "running" | "available" | "not_requested";
    kinds: Array<"task_process" | "skill_dependencies" | "prerequisite_graph" | "evidence_deepening">;
    handle: string;
  };
};

export type CapabilityUnitCultivation = {
  observableBehavior: string;
  practiceSituation: string;
  microPractice: string;
  practiceFrequency: string;
  feedbackSignal: string;
  evidenceArtifact: string;
  progression: string;
  independenceCriterion: string;
};

export type RoleLearningPathBinding = {
  id: string;
  semanticNodeId: string;
  learningPathNodeId?: string;
  relation: "requires" | "practices" | "verifies";
  mappingMode: "exact" | "fuzzy_resolved" | "ambiguous" | "graph_gap";
  rationale: string;
  candidateNodeIds: string[];
  evidenceBindingIds: string[];
};

export type RoleLearningNodeProposal = {
  id: string;
  policyId: "vnext-personal-path-node-proposer-v3";
  generatedFromSnapshotId: string;
  semanticNodeId: string;
  title: string;
  summary: string;
  aliases: string[];
  domains: string[];
  stage: "foundation" | "core" | "domain" | "advanced" | "research";
  order: number;
  sourceUrls: string[];
  sourceEvidence: Array<{
    url: string;
    title: string;
    source: string;
    quality: "official" | "academic" | "community" | "repository";
    relevance: number;
    matchedTerms: string[];
  }>;
  connections: Array<{
    nodeId: string;
    kind: "hard_prerequisite" | "soft_prerequisite" | "co_learning";
    rationale: string;
  }>;
  requiresLearnerConfirmation: true;
  masteryUnchanged: true;
};

export type RoleLearningProjection = {
  protocolVersion: "learnflow-learning-path/v1";
  authority: "learnflow";
  retrievalPolicyId: "vnext-learning-path-retrieval-v3";
  generatedFromSnapshotId: string;
  bindings: RoleLearningPathBinding[];
  proposals: RoleLearningNodeProposal[];
};

export type SemanticEdge = {
  id: string;
  type: string;
  source: string;
  target: string;
  lifecycle: "candidate" | "stable" | "rejected";
  confidence: number;
  evidenceSegmentIds: string[];
  evidenceBindingIds: string[];
  evidenceSpans?: EvidenceSpan[];
  propositionIds?: string[];
};

export type SemanticClaim = {
  id: string;
  subjectId: string;
  predicate: string;
  objectId?: string;
  value?: string;
  status: "candidate" | "accepted" | "disputed" | "rejected";
  evidenceSegmentIds: string[];
  evidenceBindingIds: string[];
  confidence: number;
  assertionType?: "direct_fact" | "cross_source_synthesis" | "research_inference";
  limitations?: string[];
  conflictRefs?: string[];
};

export const processKnowledgeStateSchema = z.enum([
  "observed_pattern",
  "documented_norm",
  "inferred_pattern",
]);

export const processNodeKindSchema = z.enum([
  "event",
  "actor",
  "work_object",
  "artifact",
  "tool_system",
  "quality_criterion",
  "exception_risk",
  "risk",
  "decision",
]);

export type ProcessKnowledgeState = z.infer<typeof processKnowledgeStateSchema>;
export type ProcessNodeKind = z.infer<typeof processNodeKindSchema>;

export type ProcessScenario = {
  id: string;
  label: string;
  summary: string;
  trigger: string;
  outcome: string;
  knowledgeState: ProcessKnowledgeState;
  lifecycle: "candidate" | "stable";
  evidenceSegmentIds: string[];
  evidenceBindingIds: string[];
  taskRefs?: string[];
  actorRefs?: string[];
  inputRefs?: string[];
  outputRefs?: string[];
  acceptanceCriteria?: string[];
};

export type ProcessNode = {
  id: string;
  scenarioId: string;
  kind: ProcessNodeKind;
  label: string;
  summary: string;
  sequenceHint?: number;
  knowledgeState: ProcessKnowledgeState;
  lifecycle: "candidate" | "stable";
  evidenceSegmentIds: string[];
  evidenceBindingIds: string[];
  eventType?: "activity" | "decision" | "handoff" | "exception" | "outcome";
  lane?: string;
  taskRefs?: string[];
  actorRefs?: string[];
  objectRefs?: string[];
  artifactRefs?: string[];
  toolRefs?: string[];
  qualityCriterionRefs?: string[];
};

export type ProcessEdge = {
  id: string;
  type: string;
  source: string;
  target: string;
  evidenceSegmentIds: string[];
  evidenceBindingIds: string[];
  evidenceSpans?: EvidenceSpan[];
  lifecycle?: "candidate" | "stable";
  knowledgeState?: ProcessKnowledgeState;
  qualifiers?: Record<string, string>;
};

export type SemanticBridge = {
  id: string;
  processNodeId: string;
  semanticNodeId: string;
  type: "realizes_task" | "uses_skill" | "produces_deliverable";
  confidence: number;
  /** Optional in legacy packages; curated packages bind the bridge itself. */
  evidenceSegmentIds?: string[];
  evidenceBindingIds?: string[];
  assertionType?: "direct_fact" | "cross_source_synthesis" | "research_inference";
  limitations?: string[];
};

/** Evidence-linked seed used to expand a task into a process forest later. */
export type ProcessCapsule = {
  id: string;
  taskId: string;
  actionPattern: string;
  trigger?: string;
  deliverable?: string;
  decisionOrRisk?: string;
  evidenceSegmentIds: string[];
  eventMentionIds: string[];
  expansionStatus: "queued" | "running" | "complete" | "degraded";
  scenarioIds: string[];
};

export type AuditIssue = {
  id: string;
  code: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
  targetIds: string[];
  repair: "automatic" | "research" | "user" | "organization_specific";
};

export type ResearchTopic = {
  id: string;
  title: string;
  question: string;
  reason: string;
  targetIds: string[];
};

export type SnapshotSection = {
  id: string;
  title: string;
  status: "candidate" | "stable";
  summary: string;
  itemIds: string[];
  evidenceBindingIds: string[];
};

export type ValidationReport = {
  publishable: boolean;
  structural: { passed: boolean; issues: string[] };
  semantic: { passed: boolean; issues: string[] };
  evidence: { passed: boolean; coverage: number; issues: string[] };
  temporal: { passed: boolean; issues: string[] };
  process: { passed: boolean; coverage: number; issues: string[] };
};

export type RolePackageNamespaceManifest = {
  id: "evidence" | "semantic" | "process";
  schemaVersion: string;
  objectCount: number;
  fingerprint: string;
};

/** One externally addressable Role Package with three internal namespaces. */
export type RolePackageManifest = {
  protocolVersion: "3.0.0";
  packageId: string;
  packageVersion: string;
  snapshotId: string;
  snapshotAsOf: string;
  status: "candidate" | "ready";
  namespaces: {
    evidence: RolePackageNamespaceManifest & { id: "evidence" };
    semantic: RolePackageNamespaceManifest & { id: "semantic" };
    process: RolePackageNamespaceManifest & { id: "process" };
  };
};

export type ColdStartBuildResult = {
  runId: string;
  projectId: string;
  brief: ProjectBrief;
  sources: {
    assets: SourceAsset[];
    segments: SourceSegment[];
    evidenceBindings: EvidenceBinding[];
    mentions?: ConceptMention[];
    relationPropositions?: RelationProposition[];
    research?: WebResearchReport;
  };
  semantic: {
    nodes: SemanticNode[];
    edges: SemanticEdge[];
    claims: SemanticClaim[];
    /** Derived interoperability view; not a fourth fact namespace. */
    learningPathProjection?: RoleLearningProjection;
  };
  process: {
    capsules?: ProcessCapsule[];
    scenarios: ProcessScenario[];
    nodes: ProcessNode[];
    edges: ProcessEdge[];
    bridges: SemanticBridge[];
  };
  snapshot: {
    id: string;
    asOf: string;
    status: "candidate" | "ready";
    sections: SnapshotSection[];
  };
  audit: {
    issues: AuditIssue[];
    researchTopics: ResearchTopic[];
    /** Non-blocking post-build inspection. Only hardBlockerIds affect protocol validity. */
    inspection?: {
      protocolValid: boolean;
      axes: {
        structuralValidity: number;
        semanticClarity: number;
        evidenceReadiness: number;
        temporalIntegrity: number;
        processCoverage: number;
        agentUsability: number;
      };
      core: { nodeCount: number; acceptedNodeCount: number; errorCount: number; unsupportedAcceptedCount: number };
      frontier: { candidateNodeCount: number; researchFindingCount: number; openTopicCount: number };
      coverage: {
        tasks: number;
        knowledgeSkills: number;
        tasksWithoutSkills: number;
        tasksWithoutProcess: number;
        evidenceCoverage: number;
        directEvidenceCoverage: number;
      };
      agentProbes: Array<{ id: string; label: string; status: "passed" | "warning" | "failed"; detail: string; targetIds: string[] }>;
      hardBlockerIds: string[];
    };
  };
  packages: {
    rolePackage: RolePackageManifest;
  };
  validation: ValidationReport;
  build?: {
    workflowVersion: "3.3" | "4.0" | "4.1" | "4.2" | "4.3" | "4.4";
    stage?: "kernel" | "semantic_enrichment" | "full_enrichment";
    enrichment?: {
      baseSnapshotId?: string;
      status: "queued" | "running" | "complete" | "degraded";
      completedLanes: Array<"capability" | "knowledge" | "skill_dependencies" | "process" | "inspection">;
      pendingLanes: Array<"capability" | "knowledge" | "skill_dependencies" | "process" | "inspection">;
      updatedAt: string;
    };
    workItems: BuildWorkItemSummary[];
    metrics: ColdStartBuildMetrics;
  };
};
