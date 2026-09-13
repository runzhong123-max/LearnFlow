import { z } from "zod/v4";
import { compileRolePackage, stableHash } from "@/lib/build/compiler";
import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import { semanticNodeTypeSchema, type ColdStartBuildResult, type ColdStartRequest, type SemanticNode } from "@/lib/build/types";
import { taskDefinitionSchema } from "./task-schema";
import type { ChangeSet, ResearchRun } from "./protocol";
import type { ResearchTool } from "@/lib/agent/research-loop";
import type { ModelInvoker } from "@/lib/agent/model";
import { claimSchema, createEvidenceReviewer } from "@/lib/iteration/evidence-review";
import { applyGraphPatch } from "@/lib/risk/patch";

const nodeUpdate = z.object({ label: z.string().min(1).max(240), summary: z.string().min(1).max(4000), aliases: z.array(z.string().max(240)).default([]), type: semanticNodeTypeSchema.optional(), taskDefinition: taskDefinitionSchema.optional() });
const proposalSchema = z.object({ motivation: z.string().min(1).max(2000), findingRefs: z.array(z.string()).min(1).max(128), operations: z.array(z.object({ kind: z.enum(["add", "revise", "attach_evidence", "split", "merge", "replace", "deprecate"]), targetId: z.string().min(1), replacementIds: z.array(z.string()).default([]), nodes: z.array(nodeUpdate).max(128).default([]) })).min(1).max(128) });
async function baselineHash(base: ColdStartBuildResult) { return sha256Hex(canonicalStringify(base)); }
/** Supervisor-only tool. It saves proposals; it cannot adopt or publish a version. */
export function changeProposalTool(input: { base: ColdStartBuildResult; run: ResearchRun; save: () => Promise<void> }): ResearchTool {
  return { name: "submit_change_set", description: "提出一组固定基线上的原子改动。支持新增、修订、补证、拆分、合并、替代和废弃。targetId 为已知对象；新增节点由编译器分配稳定 ID。必须关联研究发现；本工具不采用版本。", args: {}, parameters: z.toJSONSchema(proposalSchema) as Record<string, unknown>, validate: value => proposalSchema.parse(value), run: async args => {
    const parsed = proposalSchema.parse(args);
    for (const operation of parsed.operations) for (const node of operation.nodes) {
      if (node.taskDefinition) for (const key of ["goal", "trigger", "inputs", "actors", "activities", "deliverables", "qualityCriteria", "exceptions"] as const) {
        node.taskDefinition[key].review = { status: "undetermined", reason: "生成者提供的内容需要独立复核" };
      }
    }
    if (parsed.findingRefs.some(id => !input.run.findings.some(finding => finding.id === id))) throw new Error("未知研究发现引用");
    const selected = new Set(input.run.intent.targetIds), known = new Set(input.base.semantic.nodes.map(node => node.id));
    for (const operation of parsed.operations) {
      if (!known.has(operation.targetId) || operation.replacementIds.some(id => !known.has(id))) throw new Error("改动对象或迁移目标不存在");
      if (input.run.intent.changeScope === "selected" && (!selected.has(operation.targetId) || operation.replacementIds.some(id => !selected.has(id)))) throw new Error("改动超出授权范围；可保存研究发现，扩大改动范围需要用户授权");
      if (["add", "split", "replace"].includes(operation.kind) && !operation.nodes.length) throw new Error("新增、拆分或替代必须提供新对象定义");
      if (operation.kind === "revise" && operation.nodes.length !== 1) throw new Error("修订必须提供一个新定义");
      if (["merge", "deprecate", "attach_evidence"].includes(operation.kind) && operation.nodes.length) throw new Error("合并、废弃和补证不接受替换定义");
      if (operation.kind === "revise" && operation.nodes[0]?.type && operation.nodes[0].type !== input.base.semantic.nodes.find(node => node.id === operation.targetId)?.type) throw new Error("修改对象类型需使用替代操作并保留身份迁移");
      if (operation.kind === "merge" && operation.replacementIds.length !== 1) throw new Error("合并必须指定一个稳定的保留对象");
    }
    const rootHash = await baselineHash(input.base), id = `change-set:${stableHash(`${rootHash}:${JSON.stringify(parsed)}`)}`;
    if (!input.run.changeSets.some(change => change.id === id)) input.run.changeSets.push({ id, baseSnapshotId: input.base.snapshot.id, baseRootHash: rootHash, motivation: parsed.motivation, findingRefs: parsed.findingRefs, targetIds: [...new Set(parsed.operations.map(operation => operation.targetId))], operations: parsed.operations.map(operation => ({ kind: operation.kind, targetId: operation.targetId, replacementIds: operation.replacementIds, payload: { nodes: operation.nodes } })), status: "candidate", checks: [] });
    await input.save(); return { summary: "候选改动已保存，编译和验收后才可能采用", data: { changeSetId: id, status: "candidate" } };
  } };
}
/** Apply a whole group to a copy. Invalid groups never partially modify the candidate. */
export async function compileResearchChanges(input: { base: ColdStartBuildResult; candidate: ColdStartBuildResult; request: ColdStartRequest; run: ResearchRun; reviewModel?: ModelInvoker; signal?: AbortSignal }) {
  let candidate = structuredClone(input.candidate);
  const migrations: Record<string, string> = {}, retired = new Set<string>();
  const hash = await baselineHash(input.base);
  for (const change of input.run.changeSets.filter(change => change.status === "candidate" && !change.checks.length)) {
    let draft = structuredClone(candidate);
    const localMigrations: Record<string, string> = {}, localRetired = new Set<string>();
    try {
      if (change.baseSnapshotId !== input.base.snapshot.id || change.baseRootHash !== hash) throw new Error("基线发生变化，需重新评估差异");
      const findings = change.findingRefs.map(id => input.run.findings.find(finding => finding.id === id));
      if (findings.some(finding => !finding || finding.review !== "supported" || !finding.claim.evidenceSpans.length)) throw new Error("改动依据尚未得到原文复核支持");
      const spans = findings.flatMap(finding => finding!.claim.evidenceSpans);
      if (spans.some(span => !draft.sources.segments.some(segment => segment.id === span.segmentId && segment.text.includes(span.quote)))) throw new Error("改动引用无法在当前资料库核对");
      for (const operation of change.operations) {
        const old = draft.semantic.nodes.find(node => node.id === operation.targetId);
        if (!old) throw new Error("改动对象已不存在");
        if (input.run.intent.changeScope === "selected" && !input.run.intent.targetIds.includes(old.id)) throw new Error("改动超出授权范围");
        const specs = z.object({ nodes: z.array(nodeUpdate) }).parse(operation.payload).nodes;
        const target = operation.replacementIds?.[0];
        if (operation.kind === "merge") {
          if (!target || (input.run.intent.changeScope === "selected" && !input.run.intent.targetIds.includes(target))) throw new Error("合并目标未授权");
          const patched = applyGraphPatch(draft, { id: change.id, baseSnapshotId: draft.snapshot.id, status: "proposed", iteration: 0, operations: [{ op: "merge_semantic_nodes", canonicalId: target, mergedIds: [old.id], reason: change.motivation, issueIds: [] }], targetIds: [old.id, target], issueIds: [], summary: change.motivation, createdAt: new Date().toISOString() });
          draft = patched.result; Object.assign(localMigrations, patched.referenceMigration); continue;
        }
        const created: SemanticNode[] = specs.map((spec, index) => ({ ...old, ...spec, type: spec.type || old.type, id: ["revise", "attach_evidence"].includes(operation.kind) ? old.id : `node:${stableHash(`${change.id}:${old.id}:${index}`)}`, evidenceBindingIds: [], evidenceSegmentIds: [...new Set(spans.map(span => span.segmentId))], lifecycle: "candidate", confidence: .5 }));
        for (const node of created.length ? created : operation.kind === "attach_evidence" ? [old] : []) {
          for (const span of spans) {
            const segment = draft.sources.segments.find(segment => segment.id === span.segmentId)!;
            const id = `ev:${stableHash(`${change.id}:${node.id}:${JSON.stringify(span)}`)}`;
            draft.sources.evidenceBindings.push({ id, targetId: node.id, fieldPath: "summary", sourceId: segment.sourceId, segmentId: segment.id, evidenceSpan: span, support: "inferred", method: "compiler", confidence: .5, assertionType: "research_inference", reviewStatus: "undetermined", adoptionStatus: "candidate", rationale: change.motivation });
            node.evidenceBindingIds.push(id);
          }
          const index = draft.semantic.nodes.findIndex(item => item.id === node.id);
          if (index >= 0) draft.semantic.nodes[index] = node; else draft.semantic.nodes.push(node);
        }
        if (["split", "replace", "deprecate"].includes(operation.kind)) {
          old.lifecycle = "rejected"; localRetired.add(old.id);
          operation.replacementIds = created.map(node => node.id);
          draft.semantic.edges.filter(edge => edge.source === old.id || edge.target === old.id).forEach(edge => { edge.lifecycle = "rejected"; });
          if (created.length === 1) localMigrations[old.id] = created[0].id;
        }
      }
      const compiled = compileRolePackage({ request: input.request, brief: draft.brief, assets: draft.sources.assets, segments: draft.sources.segments, semantic: { nodes: draft.semantic.nodes, edges: draft.semantic.edges, claims: draft.semantic.claims, bindings: draft.sources.evidenceBindings, tempToId: new Map() }, process: { ...draft.process, bindings: [] }, laneFailures: [], research: draft.sources.research, mentions: draft.sources.mentions, relationPropositions: draft.sources.relationPropositions });
      if (!compiled.validation.structural.passed) throw new Error("编译后的身份、引用或关系校验失败");
      // Review the actual replacement, not just the generator's justification.
      const lowImpact = change.operations.every(operation => ["revise", "attach_evidence"].includes(operation.kind));
      const claims = change.operations.flatMap(operation => {
        const node = compiled.semantic.nodes.find(node => node.id === operation.targetId);
        return node ? [claimSchema.parse({ id: `${change.id}:${node.id}`, statement: `${node.label}：${node.summary}`, kind: "inferred", expression: "synthesis", evidenceSpans: spans, applicability: `岗位边界：${input.base.brief.roleDescription}；对象类型：${node.type}` })] : [];
      });
      let reviewed = false;
      if (lowImpact && input.reviewModel && claims.length) {
        try {
          const review = await createEvidenceReviewer(input.reviewModel)({ claims, segments: compiled.sources.segments, signal: input.signal });
          reviewed = claims.every(claim => review?.verdicts.get(claim.id)?.verdict === "supported");
        } catch (error) {
          if (input.signal?.aborted) throw error;
          // Budget/execution failures preserve compiled work for review, never imply support.
        }
      }
      for (const binding of compiled.sources.evidenceBindings) {
        if (binding.rationale === change.motivation && binding.method === "compiler" && binding.adoptionStatus === "candidate") binding.reviewStatus = reviewed ? "supported" : "undetermined";
      }
      candidate = compiled; Object.assign(migrations, localMigrations); localRetired.forEach(id => retired.add(id));
      change.status = reviewed && input.run.intent.adoption === "automatic" ? "candidate" : "needs_review";
      change.checks.push({ layer: "integrity", passed: true, reason: "固定基线、授权对象及编译引用检查通过" }, { layer: "evidence", passed: reviewed, reason: reviewed ? "独立复核支持实际替换文本，仍须通过产品质量及版本采用政策" : "改动理由已复核，替换后的语义或身份迁移仍需审阅" });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      change.status = "rejected"; change.checks.push({ layer: "integrity", passed: false, reason: error instanceof Error ? error.message : "改动编译失败" });
    }
  }
  candidate.researchRun = input.run;
  return { candidate, migrations, retired: [...retired] };
}
