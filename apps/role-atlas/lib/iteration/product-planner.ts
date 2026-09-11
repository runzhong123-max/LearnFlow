import { z } from "zod";
import type { ModelInvoker } from "@/lib/agent/model";
import { invokeStructured } from "@/lib/build/model";
import { buildRiskPackage, radarItemSchema, type RiskPackage } from "./products";
import { augmentationProposalSchema, type AugmentationProposal } from "./augmentation";
import { claimSchema } from "./evidence-review";
import type { IterationProductProposal } from "./types";

/**
 * Assemble the product planner that runs at finalization.
 *
 * The planner asks a model for the parts a model is actually qualified to
 * propose — which risks are worth hypothesising, which gaps are worth deepening,
 * which points are missing — and nothing else. Everything measurable is filled
 * in here from code:
 *
 *   code owns  — the base snapshot each augmentation must target, the
 *                deterministic audit findings in the risk package, its metrics,
 *                and the promotion of a proposal into an accepted product
 *   model owns — hypotheses, scan directions, candidate points, wording
 *
 * A model that returns nothing, or fails, yields `undefined`: the result then
 * carries no `products` field at all, exactly as before this feature existed.
 */

const riskHypothesisSchema = z.object({
  domain: z.string().trim().min(2).max(120),
  claims: z.array(claimSchema).max(20).default([]),
});

const proposalSchema = z.object({
  riskDomains: z.array(riskHypothesisSchema).max(12).default([]),
  radarItems: z.array(radarItemSchema).max(40).default([]),
  /** Node/edge drafts only; identity, base and gates are applied by code. */
  augmentations: z.array(z.object({
    motivation: z.string().trim().min(1).max(1_000),
    nodes: z.array(z.object({
      tempId: z.string().min(1).max(120),
      type: z.enum(["knowledge_skill", "capability", "capability_unit", "task", "market_role"]),
      label: z.string().trim().min(2).max(120),
      summary: z.string().trim().min(1).max(1_000),
      aliases: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
      evidenceSegmentIds: z.array(z.string().min(1).max(160)).max(12).default([]),
      learningKind: z.enum(["knowledge", "skill", "hybrid"]).optional(),
      learningDefinition: z.object({
        scopeNote: z.string().trim().min(1).max(500),
        assessmentCriteria: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
      }).optional(),
    })).max(20).default([]),
    edges: z.array(z.object({
      from: z.string().min(1).max(220),
      to: z.string().min(1).max(220),
      type: z.enum(["requires_skill", "requires_capability", "requires_knowledge", "has_unit", "performs", "contains"]),
      evidenceSegmentIds: z.array(z.string().min(1).max(160)).max(12).default([]),
    })).max(40).default([]),
  })).max(8).default([]),
});

export function productPrompt(input: {
  objective: string;
  mode: string;
  /** Only these segments may be cited; code rejects anything else afterwards. */
  evidence: Array<{ segmentId: string; excerpt: string }>;
  nodeIds: string[];
  findings: Array<{ code: string; title: string; detail: string; targetIds: string[] }>;
}) {
  return {
    system: [
      "你是一名岗位图谱维护研究员，为本轮迭代提出三类候选产物。全部是**候选**，不是结论。",
      "1) 风险假设：给出值得进一步核实的风险域，每个风险域下写若干条可证伪的断言。",
      "   每条断言必须带 falsifier（什么证据会推翻它）；kind=observed 时必须附至少一条原文片段，否则该条会被丢弃。",
      "2) 深化方向：给出值得继续深化的方向，必须写明具体缺口信号与受影响节点 id。",
      "3) 增补候选：缺少的节点与关系。原子知识点必须提供 scopeNote 与非空 assessmentCriteria，且只能引用给定片段 id。",
      "只引用下面给出的 segmentId 与节点 id；编造的 id 会被丢弃。不要输出任何结论性措辞。",
      "只输出 JSON，不要输出其它文字。",
    ].join("\n"),
    user: JSON.stringify({
      objective: input.objective,
      mode: input.mode,
      instruction: "按上述三类给出候选。没有把握的部分留空，不要用常识补齐。",
      availableSegments: input.evidence,
      availableNodeIds: input.nodeIds,
      findings: input.findings,
    }),
  };
}

export type ProductPlanner = (input: {
  contract: { objective: string; mode: string };
  base: import("@/lib/build/types").ColdStartBuildResult;
  candidate: import("@/lib/build/types").ColdStartBuildResult;
  claims: Array<{ claim: unknown; verification: string; note: string }>;
  round: number;
  signal?: AbortSignal;
}) => Promise<IterationProductProposal | undefined>;

/**
 * A planner failure propagates: the graph already catches it, emits
 * `productsFailed`, and leaves the result shape untouched. Swallowing it here
 * would make a broken planner indistinguishable from one that proposed nothing.
 */
export function buildProductPlanner(input: {
  model: ModelInvoker;
  /** Audit findings for the round; become the risk package's trusted layer. */
  issues?: readonly unknown[];
}): ProductPlanner {
  return async ({ contract, candidate, signal }) => {
    const evidence = candidate.sources.segments.slice(0, 40).map(segment => ({
      segmentId: segment.id,
      excerpt: segment.text.slice(0, 200),
    }));
    const prompt = productPrompt({
      objective: contract.objective,
      mode: contract.mode,
      evidence,
      nodeIds: candidate.semantic.nodes.map(node => node.id).slice(0, 80),
      findings: (candidate.audit?.issues || []).slice(0, 40).map(issue => ({
        code: issue.code, title: issue.title, detail: issue.detail, targetIds: issue.targetIds,
      })),
    });
    const parsed = await invokeStructured({
      model: input.model,
      schema: proposalSchema,
      system: prompt.system,
      user: prompt.user,
      signal,
      thinking: "disabled",
      maxCompletionTokens: 4_000,
      timeoutMs: 30_000,
      totalTimeoutMs: 50_000,
    });

    // The base is the round's candidate, never something the model named: an
    // augmentation aimed at another baseline would bind evidence to nodes that
    // do not exist. Code supplies it so the gate can actually pass or refuse.
    const augmentations: AugmentationProposal[] = parsed.augmentations.map(draft => augmentationProposalSchema.parse({
      baseSnapshotId: candidate.snapshot.id,
      motivation: draft.motivation,
      nodes: draft.nodes.map(node => ({ ...node, confidence: 0.6 })),
      edges: draft.edges.map(edge => ({ ...edge, confidence: 0.6 })),
      attachedTo: [],
    }));

    const riskPackage: RiskPackage | undefined = parsed.riskDomains.length || (input.issues || []).length
      ? buildRiskPackage({
        baseSnapshotId: candidate.snapshot.id,
        generatedAt: new Date().toISOString(),
        // Deterministic findings come from code, never from the model.
        issues: input.issues || [],
        domains: parsed.riskDomains,
      }).package
      : undefined;

    const proposal: IterationProductProposal = {
      ...(riskPackage ? { riskPackage } : {}),
      ...(parsed.radarItems.length ? { radarItems: parsed.radarItems } : {}),
      ...(augmentations.length ? { augmentations } : {}),
    };
    return Object.keys(proposal).length ? proposal : undefined;
  };
}
