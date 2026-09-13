import type { ConceptMention, SourceAsset, SourceSegment } from "./types";
import { estimateTokens, normalizeConcept, type TaskGroup } from "./workflow";

const knowledgeRoles = new Set(["role_boundary", "official_standard", "job_market", "work_practice", "workspace_observation", "technology_primary", "education"]);

function terms(text: string) {
  const normalized = normalizeConcept(text);
  return [...new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, i) => normalized.slice(i, i + 2)))];
}

/** Budgeted model context only. The stored source and its immutable ID are unchanged. */
export function selectKnowledgeContext(input: {
  group: TaskGroup;
  segments: SourceSegment[];
  assets: SourceAsset[];
  mentions: ConceptMention[];
  maxTokens?: number;
}) {
  const budget = Math.max(1, input.maxTokens ?? 9_600);
  const perSegmentBudget = Math.max(1, Math.min(2_800, Math.floor(budget / Math.max(2, input.group.tasks.length * 2))));
  const assets = new Map(input.assets.map(asset => [asset.id, asset]));
  const taskTerms = input.group.tasks.map(task => terms(`${task.label} ${task.summary}`));
  const overlap = (text: string, index: number) => {
    const normalized = normalizeConcept(text);
    return taskTerms[index].filter(term => normalized.includes(term)).length;
  };
  const candidates = input.segments.flatMap((segment, ordinal) => {
    const asset = assets.get(segment.sourceId);
    if (asset?.qualification?.status === "quarantined") return [];
    const directFor = input.group.tasks.map(task => task.evidenceSegmentIds.includes(segment.id));
    const primary = asset?.qualification?.evidenceRoles.includes("technology_primary") || false;
    if (!directFor.some(Boolean) && !asset?.qualification?.evidenceRoles.some(role => knowledgeRoles.has(role))) return [];
    const quotes = input.mentions.filter(m => m.sourceSegmentId === segment.id && m.kind === "knowledge_skill")
      .map(m => m.evidenceSpan?.quote || m.surfaceForm).filter(Boolean);
    let windows = [{ text: segment.text, start: 0, directFor }];
    if (estimateTokens(segment.text) > perSegmentBudget) {
      const text = segment.text;
      // A long unbroken HTML paragraph must not consume the entire lane budget.
      // Every window is a continuous verbatim substring, never a synthetic quote.
      const starts = new Set([0, Math.max(0, text.length - perSegmentBudget)]);
      for (let start = 0; start < text.length; start += Math.max(1, Math.floor(perSegmentBudget / 2))) starts.add(start);
      for (const quote of quotes) { const at = text.indexOf(quote); if (at >= 0) starts.add(Math.max(0, at - 80)); }
      windows = input.group.tasks.flatMap((_, index) => {
        if (directFor.some(Boolean) && !directFor[index]) return [];
        const best = [...starts].map(start => ({ start, text: text.slice(start, start + perSegmentBudget) }))
          .map(window => ({ ...window, score: overlap(window.text, index) + quotes.filter(q => window.text.includes(q)).length * 2 }))
          .sort((a, b) => b.score - a.score || a.start - b.start)[0];
        return [{ ...best, directFor: directFor.map((isDirect, i) => isDirect && i === index) }];
      });
    }
    return windows.flatMap(window => {
      const relevance = input.group.tasks.map((_, index) => overlap(window.text, index));
      if (!window.directFor.some(Boolean) && !relevance.some(score => score >= 2)) return [];
      return [{ key: `${segment.id}:${window.start}`, segment: { ...segment, text: window.text, excerptStart: window.start }, ordinal,
        directFor: window.directFor, primary, relevance, size: estimateTokens(window.text), mentionScore: quotes.some(quote => window.text.includes(quote)) ? 6 : 0 }];
    });
  });
  const selected: SourceSegment[] = [];
  const used = new Set<string>();
  const sourceCounts = new Map<string, number>();
  let tokens = 0;
  const takeBest = (items: typeof candidates, taskIndex?: number) => {
    const next = items.filter(c => !used.has(c.key) && tokens + c.size <= budget)
      .sort((a, b) => {
        const score = (c: typeof a) => (taskIndex === undefined ? Math.max(...c.relevance) : c.relevance[taskIndex])
          + c.mentionScore + (c.primary ? 8 : 0) - (sourceCounts.get(c.segment.sourceId) || 0) * 12;
        return score(b) - score(a) || a.ordinal - b.ordinal;
      })[0];
    if (!next) return false;
    selected.push(next.segment); used.add(next.key); tokens += next.size;
    sourceCounts.set(next.segment.sourceId, (sourceCounts.get(next.segment.sourceId) || 0) + 1);
    return true;
  };
  // Reserve room for each task's own evidence AND relevant primary documentation.
  // Repeated paragraphs from one JD cannot crowd out a second task or its methods.
  input.group.tasks.forEach((_, i) => takeBest(candidates.filter(c => c.directFor[i]), i));
  input.group.tasks.forEach((_, i) => takeBest(candidates.filter(c => c.primary && c.relevance[i] >= 2), i));
  while (selected.length < 10 && takeBest(candidates)) { /* bounded fill */ }
  return selected;
}
