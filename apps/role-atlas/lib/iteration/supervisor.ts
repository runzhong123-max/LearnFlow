import { z } from "zod";
import type { ModelInvoker } from "@/lib/agent/model";
import { runResearchLoop, type ResearchTool, type ResearchLoopCheckpoint } from "@/lib/agent/research-loop";
import { invokeStructured } from "@/lib/build/model";
import { stableHash } from "@/lib/build/compiler";
import { researchTaskCardSchema, type ResearchTaskCard } from "./worker";
import type { IterationContract, IterationWorkItem } from "./types";

/** Supervisor proposes research branches; the compiler alone controls graph changes. */
const cardDraftSchema = z.object({
  workItemId: z.string().max(200).optional(),
  reason: z.string().max(4000).optional(),
  targetIds: z.array(z.string().max(240)).optional(),
  question: z.string().trim().min(4).max(4000),
  sourceClass: z.enum(["official_standard", "job_market", "primary_docs", "incident", "academic"]),
  queriesHint: z.array(z.string().trim().min(2).max(300)).max(8).default([]),
});
export type ResearchCardDraft = z.infer<typeof cardDraftSchema>;

const planSchema = z.object({ cards: z.array(cardDraftSchema).max(128) });

/** Cards per researchable work item, capped by the contract's own ceiling. */
export const MAX_CARDS_PER_PLAN = 128;
export const QUERIES_PER_CARD = 4;

export type SupervisorDegrade = {
  reason: string;
};

export function supervisorPrompt(input: {
  contract: IterationContract;
  workItems: IterationWorkItem[];
  context?: unknown;
}) {
  return {
    system: [
      "你是岗位研究主管。根据用户目标、图谱缺口和已有发现制定可执行的研究议程。",
      "你可以提出新问题、追踪相邻岗位、拆分合并任务并重规划。调查不等于获准修改图谱。优先支持项目转换、学生理解、重要内容覆盖。",
      "对每个工作项给出：一句可回答的研究问题、应当依据的证据类别、几条值得先试的检索方向。",
      "证据类别只能取：official_standard（官方标准与规范）、job_market（招聘市场）、primary_docs（一手技术文档）、incident（事故与复盘）、academic（学术资料）。",
      "研究问题必须能通过查资料回答，不要写“深入了解”“全面掌握”这类无法验证的目标。",
      "只输出 JSON，不要输出其它文字。",
    ].join("\n"),
    user: JSON.stringify({
      objective: input.contract.objective,
      mode: input.contract.mode,
      scope: input.contract.research, context: input.context,
      instruction: "已知工作项是线索，不是问题白名单。关联已知工作项时填写 workItemId；新方向省略该字段并填写 reason。保留尚未解决的重要问题。",
      workItems: input.workItems.map(item => ({
        workItemId: item.id,
        kind: item.kind,
        title: item.title,
        detail: item.detail,
        findingIds: item.findingIds,
      })),
    }),
  };
}

/** Stable identity derived from the work item, so a card can never be renamed into another. */
function cardId(workItemId: string) {
  return `research-card:${stableHash(workItemId)}`;
}

/** Evidence class inferred from the work item, used when the model gives nothing. */
function defaultSourceClass(item: IterationWorkItem): ResearchTaskCard["sourceClass"] {
  if (item.kind === "repair") return "official_standard";
  if (item.kind === "refresh") return "primary_docs";
  return "job_market";
}

/**
 * Deterministic plan: one card per researchable work item, asking the work
 * item's own title as the question. This is both the fallback when the model is
 * unavailable and the shape every model plan is validated against.
 */
export function deterministicCards(input: {
  contract: IterationContract;
  workItems: IterationWorkItem[];
}): ResearchTaskCard[] {
  const researchable = input.workItems.filter(item => item.requiresResearch);
  return researchable.slice(0, Math.min(input.contract.budgets.maxWorkItems, MAX_CARDS_PER_PLAN)).map(item => ({
    id: cardId(item.id),
    question: item.detail?.trim() || item.title,
    sourceClass: defaultSourceClass(item),
    why: { findingIds: item.findingIds, detail: item.title },
    queriesHint: [item.title],
    budget: { queries: QUERIES_PER_CARD },
  }));
}

export type ResearchSupervisor = {
  plan: (input: {
    contract: IterationContract;
    workItems: IterationWorkItem[];
    context?: unknown;
    tools?: ResearchTool[];
    checkpoint?: ResearchLoopCheckpoint;
    onCheckpoint?: (value: ResearchLoopCheckpoint) => Promise<void>;
    round: number;
    signal?: AbortSignal;
  }) => Promise<ResearchTaskCard[]>;
};

export function createResearchSupervisor(input: {
  model: ModelInvoker;
  onDegrade?: (degrade: SupervisorDegrade) => void;
}): ResearchSupervisor {
  return {
    async plan({ contract, workItems, signal, context, tools, checkpoint, onCheckpoint }) {
      const researchable = workItems.filter(item => item.requiresResearch);

      const fallback = () => deterministicCards({ contract, workItems: researchable });

      let drafts: ResearchCardDraft[] | undefined;
      try {
        const prompt = supervisorPrompt({ contract, workItems: researchable, context });
        const native = input.model.chat && tools?.length ? await runResearchLoop<{ cards: ResearchCardDraft[] }>({ model: input.model, checkpoint, onCheckpoint, system: `${prompt.system}\n可调用工具下钻资料、查看研究记录，最终返回 {"cards":[{"question":"可调查的问题","reason":"调查理由","sourceClass":"primary_docs","queriesHint":[]}]}。不要因无现存工作项而停止。`, task: prompt.user, tools, signal, budget: { maxTurns: 32, maxToolCalls: 128, maxTranscriptChars: 64_000 }, validateFinal: value => planSchema.parse(value) }) : undefined;
        if (native && !native.final) throw new Error(native.stopReason === "budget_exhausted" ? "RESEARCH_BUDGET_EXHAUSTED" : `SUPERVISOR_${native.stopReason}`);
        const parsed = native?.final || await invokeStructured({
          model: input.model,
          schema: planSchema,
          system: prompt.system,
          user: prompt.user,
          signal,
          thinking: "disabled",
          maxCompletionTokens: 12_000,
          timeoutMs: 25_000,
          totalTimeoutMs: 45_000,
        });
        // Only drafts for work items we actually submitted are honoured; a card
        // invented for an unknown item would study something never selected.
        drafts = parsed.cards;
        if (!drafts.length) {
          input.onDegrade?.({ reason: "模型没有为任何已提交工作项给出任务卡" });
          return fallback();
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.message.includes("BUDGET"))) throw error;
        input.onDegrade?.({ reason: error instanceof Error ? error.message.slice(0, 300) : "研究主管调用失败" });
        return fallback();
      }

      const ceiling = Math.min(contract.budgets.maxWorkItems, MAX_CARDS_PER_PLAN);
      const seen = new Set<string>();
      const cards: ResearchTaskCard[] = [];
      for (const draft of drafts) {
        if (cards.length >= ceiling) break;
        const item = researchable.find(candidate => candidate.id === draft.workItemId) || {
          id: `agenda:${stableHash(draft.question)}`, title: draft.question, findingIds: [],
        };
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        cards.push(researchTaskCardSchema.parse({
          id: cardId(item.id),
          question: draft.question,
          targetIds: contract.targetIds,
          inputRefs: draft.targetIds || [],
          sourceClass: draft.sourceClass,
          // Finding links, budget and identity come from code, never the draft.
          why: { findingIds: item.findingIds, detail: draft.reason || item.title },
          queriesHint: draft.queriesHint.slice(0, 8),
          budget: { queries: QUERIES_PER_CARD },
        }));
      }
      // Work items the model skipped still deserve research; a plan that silently
      // narrows the study would look like the checks found less than they did.
      for (const item of researchable) {
        if (cards.length >= ceiling) break;
        if (seen.has(item.id)) continue;
        cards.push(deterministicCards({ contract, workItems: [item] })[0]);
      }
      return cards;
    },
  };
}
