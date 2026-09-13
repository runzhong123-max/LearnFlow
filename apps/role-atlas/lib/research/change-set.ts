import { stableHash } from "@/lib/build/compiler";
import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import type { ColdStartBuildResult } from "@/lib/build/types";
import type { ChangeSet, ResearchRun } from "./protocol";

/** Describe the compiler's entire candidate against one immutable baseline. */
export async function describeChangeSet(input: { base: ColdStartBuildResult; candidate: ColdStartBuildResult; run: ResearchRun; passed: boolean; reasons: string[]; migrations?: Record<string, string> }): Promise<ChangeSet> {
  const baseRootHash = await sha256Hex(canonicalStringify(input.base));
  const baseline = [...input.base.semantic.nodes, ...input.base.semantic.edges, ...input.base.semantic.claims, ...input.base.process.nodes, ...input.base.process.edges, ...input.base.process.scenarios, ...input.base.process.bridges];
  const candidate = [...input.candidate.semantic.nodes, ...input.candidate.semantic.edges, ...input.candidate.semantic.claims, ...input.candidate.process.nodes, ...input.candidate.process.edges, ...input.candidate.process.scenarios, ...input.candidate.process.bridges];
  const old = new Map(baseline.map(object => [object.id, object])), current = new Map(candidate.map(object => [object.id, object]));
  const operations: ChangeSet["operations"] = [];
  for (const object of candidate) {
    const previous = old.get(object.id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(object)) operations.push({ kind: previous ? "revise" : "add", targetId: object.id, payload: object });
  }
  for (const object of baseline) if (!current.has(object.id)) {
    const replacement = input.migrations?.[object.id];
    operations.push({ kind: replacement ? "merge" : "deprecate", targetId: object.id, replacementIds: replacement ? [replacement] : [], payload: { previous: object, reason: input.reasons.join("；") } });
  }
  const needsReview = input.run.intent.adoption === "review" || input.run.findings.some(finding => finding.review === "conflicting");
  return { id: `change-set:${stableHash(`${baseRootHash}:${JSON.stringify(operations)}`)}`, baseSnapshotId: input.base.snapshot.id, baseRootHash: baseRootHash,
    motivation: input.run.intent.objective || "改进岗位理解", targetIds: input.run.intent.targetIds, findingRefs: input.run.findings.map(finding => finding.id), operations,
    status: !input.passed ? "rejected" : needsReview ? "needs_review" : "candidate",
    checks: [{ layer: "integrity", passed: input.candidate.validation.structural.passed, reason: "引用、身份、关系与固定基线由编译及版本事务校验" }, { layer: "evidence", passed: !input.run.findings.some(finding => finding.review === "conflicting"), reason: "复核意见与采用状态独立；语义冲突需要审阅" }, { layer: "quality", passed: input.passed, reason: input.reasons.join("；") }] };
}
/** Unify traceable graph claims with research findings; missing concepts stay in the research record. */
export function linkResearchFindings(result: ColdStartBuildResult, run: ResearchRun) {
  const ids = new Set(result.semantic.nodes.map(node => node.id));
  for (const finding of run.findings) {
    const subjectId = finding.claim.affectedNodeIds.find(id => ids.has(id));
    if (!subjectId) continue;
    if (run.intent.changeScope === "selected" && !run.intent.targetIds.includes(subjectId)) continue;
    const spans = finding.claim.evidenceSpans.filter(span => result.sources.segments.some(segment => segment.id === span.segmentId && segment.text.includes(span.quote)));
    if (spans.length !== finding.claim.evidenceSpans.length || !spans.length) continue;
    const claimId = `claim:${stableHash(finding.id)}`;
    if (result.semantic.claims.some(claim => claim.id === claimId)) continue;
    const assertionType = finding.claim.expression === "synthesis" ? "cross_source_synthesis" as const : finding.claim.expression === "inference" || finding.claim.kind !== "observed" ? "research_inference" as const : "direct_fact" as const;
    const bindings = spans.map(span => ({ id: `ev:${stableHash(`${claimId}:${JSON.stringify(span)}`)}`, targetId: claimId, fieldPath: "value", sourceId: result.sources.segments.find(segment => segment.id === span.segmentId)!.sourceId, segmentId: span.segmentId, evidenceSpan: span, support: assertionType === "direct_fact" ? "direct" as const : "inferred" as const, method: "model_extraction" as const, confidence: finding.claim.confidence, assertionType, supportRole: finding.claim.evidenceRelations?.find(relation => relation.segmentId === span.segmentId)?.relation || "supports", reviewStatus: finding.review, adoptionStatus: "candidate" as const }));
    result.sources.evidenceBindings.push(...bindings);
    result.semantic.claims.push({ id: claimId, subjectId, predicate: "research_observation", value: finding.claim.statement, status: finding.review === "conflicting" ? "disputed" : "candidate", evidenceSegmentIds: spans.map(span => span.segmentId), evidenceBindingIds: bindings.map(binding => binding.id), confidence: finding.claim.confidence, assertionType, researchFindingId: finding.id, reviewStatus: finding.review, adoptionStatus: "candidate", limitations: finding.claim.limitations });
  }
  result.researchRun = structuredClone(run);
}
