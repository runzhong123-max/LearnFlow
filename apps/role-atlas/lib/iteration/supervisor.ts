import { z } from "zod";
import type { ModelInvoker } from "@/lib/agent/model";
import { invokeStructured } from "@/lib/build/model";
import { stableHash } from "@/lib/build/compiler";
import { researchTaskCardSchema, type ResearchTaskCard } from "./worker";
import type { IterationContract, IterationWorkItem } from "./types";

/**
 * Research supervisor: turns deterministic work items into research task cards.
 *
 * The deterministic planner already decided *what* must be investigated
 * (`planIterationWork`); this layer only decides *how to ask*. That division is
 * deliberate and is what keeps a supervisor from widening its own mandate:
 *
 *   code owns  — which work items get research, each card's identity, its
 *                finding links, its scope, and its budget ceiling
 *   model owns — the research question in words, the evidence class to draw on,
 *                and which queries are worth trying first
 *
 * A card carries no node targets of its own; scope travels through the work item
 * it came from. A model that "helpfully" names extra nodes therefore cannot
 * widen a study, because there is no field for it to do so.
 *
 * Unlike the boundary and evidence reviewers, a supervisor failure does not
 * disable research: the repository's precedent for planning is to degrade to a
 * deterministic plan and say so (`coursePlannerDegraded`), not to skip the work.
 */

const cardDraftSchema = z.object({
  workItemId: z.string().min(1).max(200),
  question: z.string().trim().min(4).max(600),
  sourceClass: z.enum(["official_standard", "job_market", "primary_docs", "incident", "academic"]),
  queriesHint: z.array(z.string().trim().min(2).max(300)).max(8).default([]),
});
export type ResearchCardDraft = z.infer<typeof cardDraftSchema>;

const planSchema = z.object({ cards: z.array(cardDraftSchema).max(40) });

/** Cards per researchable work item, capped by the contract's own ceiling. */
export const MAX_CARDS_PER_PLAN = 12;
export const QUERIES_PER_CARD = 4;

export type SupervisorDegrade = {
  reason: string;
};

export function supervisorPrompt(input: {
  contract: IterationContract;
  workItems: IterationWorkItem[];
}) {
  return {
    system: [
      "你是一名岗位研究主管，把已经确定的检查工作项翻译成研究任务卡。",
      "你不决定研究什么——工作项已经由确定性检查决定；你只决定怎么问。",
      "对每个工作项给出：一句可回答的研究问题、应当依据的证据类别、几条值得先试的检索方向。",
      "证据类别只能取：official_standard（官方标准与规范）、job_market（招聘市场）、primary_docs（一手技术文档）、incident（事故与复盘）、academic（学术资料）。",
      "研究问题必须能通过查资料回答，不要写“深入了解”“全面掌握”这类无法验证的目标。",
      "只输出 JSON，不要输出其它文字。",
    ].join("\n"),
    user: JSON.stringify({
      objective: input.contract.objective,
      mode: input.contract.mode,
      instruction: "为下列工作项各给一张任务卡，workItemId 必须原样使用给出的 id。",
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
    round: number;
    signal?: AbortSignal;
  }) => Promise<ResearchTaskCard[]>;
};

export function createResearchSupervisor(input: {
  model: ModelInvoker;
  onDegrade?: (degrade: SupervisorDegrade) => void;
}): ResearchSupervisor {
  return {
    async plan({ contract, workItems, signal }) {
      const researchable = workItems.filter(item => item.requiresResearch);
      if (!researchable.length) return [];
      const fallback = () => deterministicCards({ contract, workItems: researchable });

      let drafts: ResearchCardDraft[] | undefined;
      try {
        const prompt = supervisorPrompt({ contract, workItems: researchable });
        const parsed = await invokeStructured({
          model: input.model,
          schema: planSchema,
          system: prompt.system,
          user: prompt.user,
          signal,
          thinking: "disabled",
          maxCompletionTokens: 3_000,
          timeoutMs: 25_000,
          totalTimeoutMs: 45_000,
        });
        // Only drafts for work items we actually submitted are honoured; a card
        // invented for an unknown item would study something never selected.
        const requested = new Map(researchable.map(item => [item.id, item]));
        drafts = parsed.cards.filter(card => requested.has(card.workItemId));
        if (!drafts.length) {
          input.onDegrade?.({ reason: "模型没有为任何已提交工作项给出任务卡" });
          return fallback();
        }
      } catch (error) {
        input.onDegrade?.({ reason: error instanceof Error ? error.message.slice(0, 300) : "研究主管调用失败" });
        return fallback();
      }

      const ceiling = Math.min(contract.budgets.maxWorkItems, MAX_CARDS_PER_PLAN);
      const seen = new Set<string>();
      const cards: ResearchTaskCard[] = [];
      for (const draft of drafts) {
        if (cards.length >= ceiling) break;
        const item = researchable.find(candidate => candidate.id === draft.workItemId);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        cards.push(researchTaskCardSchema.parse({
          id: cardId(item.id),
          question: draft.question,
          sourceClass: draft.sourceClass,
          // Finding links, budget and identity come from code, never the draft.
          why: { findingIds: item.findingIds, detail: item.title },
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
