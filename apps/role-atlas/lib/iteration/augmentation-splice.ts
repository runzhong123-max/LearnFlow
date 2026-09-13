import type { ColdStartBuildResult, ColdStartRequest, EvidenceBinding, SemanticEdge, SemanticNode, SnapshotSection } from "@/lib/build/types";
import type { SemanticDraft } from "@/lib/build/model";
import { compileSemanticDraft } from "@/lib/build/compiler";
import { auditRoleSnapshot } from "@/lib/risk/audit";
import { validateAugmentation, type AugmentationProposal, type AugmentationReport } from "./augmentation";

/**
 * Splice a validated augmentation delta into an existing snapshot.
 *
 * The delta is compiled by the real compiler, never assembled by hand: a node
 * that the compiler did not build has no segment-level evidence binding and no
 * section membership, so the audit rejects it with `UNSUPPORTED_TARGET` and
 * `MISSING_SNAPSHOT_SECTION`. `compileSemanticDraft` is reused as-is; its
 * synthetic role node is dropped by selecting only the ids returned for the
 * proposal's own temp ids, which avoids guessing which node is synthetic.
 *
 * Sections whose membership changes are recomputed with the same rule the
 * compiler uses (compiler.ts `section()`), because a stale `itemIds` list is
 * exactly the kind of drift that makes a snapshot claim to cover something it
 * does not.
 */

export type AugmentationSpliceResult = {
  candidate: ColdStartBuildResult;
  report: AugmentationReport;
  /** Audit findings that exist after the splice but not before. */
  newErrors: string[];
  auditClean: boolean;
};

export const AUGMENTATION_DELTA_RUN_ID = "iteration:augmentation-delta";

/** Only the role identity is read, for the synthetic node this merge discards. */
function deltaRequest(base: ColdStartBuildResult): ColdStartRequest {
  return {
    runId: AUGMENTATION_DELTA_RUN_ID,
    projectId: base.brief.projectId,
    roleTitle: base.brief.roleTitle,
    roleDescription: base.brief.roleDescription,
    market: base.brief.market,
    audience: [],
    snapshotAsOf: base.snapshot.asOf,
    sources: [],
  } as ColdStartRequest;
}

/** Mirrors compiler.ts `section()`; kept in step by a regression on itemIds. */
function rebuildSection(section: SnapshotSection, nodes: SemanticNode[], bindings: EvidenceBinding[]): SnapshotSection {
  const itemIds = nodes.map(node => node.id);
  return {
    ...section,
    status: itemIds.length > 0 && nodes.every(node => node.evidenceBindingIds.some(bindingId => bindings.find(binding => binding.id === bindingId)?.support === "direct")) ? "stable" : "candidate",
    itemIds,
    evidenceBindingIds: [...new Set(nodes.flatMap(node => node.evidenceBindingIds))].filter(bindingId => bindings.some(binding => binding.id === bindingId)),
  };
}

const SECTION_NODE_TYPES: Record<string, SemanticNode["type"][]> = {
  "tasks": ["task"],
  "capabilities": ["capability", "capability_unit"],
  "knowledge-skills": ["knowledge_skill"],
};

function auditErrors(base: ColdStartBuildResult) {
  return new Set(auditRoleSnapshot(base).issues.filter(issue => issue.severity === "error").map(issue => `${issue.code}:${issue.targetIds.join(",")}`));
}

export function applyAugmentation(input: {
  base: ColdStartBuildResult;
  proposal: AugmentationProposal;
}): AugmentationSpliceResult {
  const report = validateAugmentation(input);
  if (!report.acceptedNodes.length && !report.acceptedEdges.length) {
    return { candidate: input.base, report, newErrors: [], auditClean: true };
  }

  const base = input.base;
  /**
   * The compiler resolves edges through proposal-local temp ids only, so a
   * delta edge attaching to an existing node would silently vanish. Compile a
   * closed subgraph instead: the delta nodes plus a reference stand-in for every
   * base node they attach to. The stand-ins are collapsed back onto their
   * original ids afterwards, which keeps the compiler the sole constructor of
   * both edges and evidence bindings.
   */
  const REFERENCE_PREFIX = "augmentation-ref:";
  const deltaTempIds = new Set(report.acceptedNodes.map(node => node.tempId));
  const referenced = new Set<string>();
  for (const edge of report.acceptedEdges) {
    for (const ref of [edge.from, edge.to]) {
      if (!deltaTempIds.has(ref) && base.semantic.nodes.some(node => node.id === ref)) referenced.add(ref);
    }
  }
  const referees = base.semantic.nodes.filter(node => referenced.has(node.id));
  const referenceTempId = (id: string) => `${REFERENCE_PREFIX}${id}`;

  const draft: SemanticDraft = {
    roleSummary: "",
    nodes: [
      ...referees.map(node => ({
        tempId: referenceTempId(node.id),
        type: node.type,
        label: node.label,
        summary: node.summary,
        aliases: [...node.aliases],
        evidenceSegmentIds: [...node.evidenceSegmentIds],
        evidenceSpans: [],
        mentionIds: [],
        confidence: node.confidence,
      })),
      ...report.acceptedNodes.map(node => ({
        tempId: node.tempId,
        type: node.type,
        label: node.label,
        summary: node.summary,
        aliases: node.aliases,
        evidenceSegmentIds: node.evidenceSegmentIds,
        evidenceSpans: [],
        mentionIds: [],
        confidence: node.confidence,
        ...(node.learningKind ? { learningKind: node.learningKind } : {}),
        ...(node.learningDefinition ? { learningDefinition: node.learningDefinition } : {}),
      })),
    ] as SemanticDraft["nodes"],
    edges: report.acceptedEdges.map(edge => ({
      sourceTempId: referenced.has(edge.from) ? referenceTempId(edge.from) : edge.from,
      targetTempId: referenced.has(edge.to) ? referenceTempId(edge.to) : edge.to,
      type: edge.type,
      evidenceSegmentIds: edge.evidenceSegmentIds,
      confidence: edge.confidence,
    })) as SemanticDraft["edges"],
  };

  const compiled = compileSemanticDraft({
    request: deltaRequest(base),
    draft,
    segments: base.sources.segments,
    assets: base.sources.assets,
  });

  // Collapse stand-ins onto the ids they stand for, so a spliced edge points at
  // the real base node instead of a duplicate.
  const collapse = new Map<string, string>();
  for (const node of referees) {
    const compiledId = compiled.tempToId.get(referenceTempId(node.id));
    if (compiledId) collapse.set(compiledId, node.id);
  }
  const remap = (id: string) => collapse.get(id) || id;

  // Keep only what was produced for this proposal. Anything else — notably the
  // synthetic role node the compiler prepends, and the stand-ins themselves —
  // is not part of the delta.
  const wantedIds = new Set<string>();
  for (const node of report.acceptedNodes) {
    const id = compiled.tempToId.get(node.tempId);
    if (id) wantedIds.add(id);
  }
  const existingNodeIds = new Set(base.semantic.nodes.map(node => node.id));
  const newNodes = compiled.nodes.filter(node => wantedIds.has(node.id) && !existingNodeIds.has(node.id));
  const mergedNodeIds = new Set([...existingNodeIds, ...newNodes.map(node => node.id)]);

  const existingEdgeIds = new Set(base.semantic.edges.map(edge => edge.id));
  const newEdges: SemanticEdge[] = compiled.edges
    .map(edge => ({ ...edge, source: remap(edge.source), target: remap(edge.target) }))
    .filter(edge => !existingEdgeIds.has(edge.id) && mergedNodeIds.has(edge.source) && mergedNodeIds.has(edge.target));

  const existingBindingIds = new Set(base.sources.evidenceBindings.map(binding => binding.id));
  const touchedIds = new Set<string>([
    ...newNodes.map(node => node.id),
    ...newEdges.flatMap(edge => [edge.id, edge.source, edge.target]),
  ]);
  const newBindings = compiled.bindings
    .map(binding => ({ ...binding, targetId: remap(binding.targetId) }))
    .filter(binding => !existingBindingIds.has(binding.id) && touchedIds.has(binding.targetId));

  const nodes = [...base.semantic.nodes, ...newNodes];
  const edges = [...base.semantic.edges, ...newEdges];
  const evidenceBindings = [...base.sources.evidenceBindings, ...newBindings];

  const candidate: ColdStartBuildResult = {
    ...base,
    semantic: { ...base.semantic, nodes, edges },
    sources: { ...base.sources, evidenceBindings },
    snapshot: {
      ...base.snapshot,
      sections: base.snapshot.sections.map(section => {
        const types = SECTION_NODE_TYPES[section.id];
        if (!types) return section;
        return rebuildSection(section, nodes.filter(node => node.type && types.includes(node.type) && node.lifecycle !== "rejected"), evidenceBindings);
      }),
    },
  };

  const before = auditErrors(base);
  const newErrors = [...auditErrors(candidate)].filter(code => !before.has(code));
  return { candidate, report, newErrors, auditClean: newErrors.length === 0 };
}
