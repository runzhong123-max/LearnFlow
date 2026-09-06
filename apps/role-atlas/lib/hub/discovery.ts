import { classifyHubEntry, HUB_TAXONOMY } from "./taxonomy";
/** Public discovery projection. No private project, draft release or source content is exported. */
export type HubEntry = {
  id: string;
  packageId: string;
  title: string;
  summary: string;
  aliases: string[];
  categories: string[];
  sourceCategories?: string[];
  audiences: string[];
  maintainerName: string;
  maintenanceKind: string;
  protocolRange: string;
  evidencePolicy: string;
  release: { id: string; packageVersion: string; snapshotId: string; rootHash: string; protocolVersion: string; snapshotAsOf: string; publishedAt: string | null };
  nodeIndex: Array<{ id: string; label: string; type: string; aliases: string[] }>;
};

export function hubStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))] : [];
}

export function normalizeHubQuery(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, "");
}

function terms(query: string) {
  return [...new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(query)]
    .filter(part => part.isWordLike).map(part => normalizeHubQuery(part.segment)).filter(part => part.length >= 2))];
}

function textScore(query: string, words: string[], value: string) {
  const target = normalizeHubQuery(value);
  if (!query || !target) return 0;
  if (target === query) return 20;
  if (target.length >= 2 && (target.includes(query) || query.includes(target))) return 12;
  return words.reduce((score, word) => score + (target.includes(word) ? 1 : 0), 0);
}

export function searchHub(entries: HubEntry[], input: { query?: string; category?: string; limit?: number; offset?: number } = {}) {
  const query = String(input.query || "").trim().slice(0, 500);
  const normalized = normalizeHubQuery(query);
  const words = terms(query);
  const classified = entries.map(entry => ({ ...entry, categories: classifyHubEntry(entry) }));
  const categories = HUB_TAXONOMY.map(category => category.label);
  const ranked = classified.flatMap(entry => {
    if (input.category && !entry.categories.includes(input.category)) return [];
    const title = Math.max(textScore(normalized, words, entry.title), textScore(normalized, words, entry.packageId));
    const aliases = entry.aliases.filter(alias => textScore(normalized, words, alias) > 0);
    const matchedNodes = entry.nodeIndex.map(node => ({ ...node,
      score: Math.max(...[node.label, ...node.aliases].map(label => textScore(normalized, words, label))),
    })).filter(node => node.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 6);
    const category = entry.categories.some(value => textScore(normalized, words, value) > 0);
    const sourceCategory = (entry.sourceCategories || []).some(value => textScore(normalized, words, value) > 0);
    const summary = textScore(normalized, words, entry.summary);
    const score = title * 10 + Math.max(0, ...aliases.map(alias => textScore(normalized, words, alias))) * 8
      + (matchedNodes[0]?.score || 0) * 3 + (category || sourceCategory ? 5 : 0) + summary;
    if (normalized && score === 0) return [];
    const reasons = [title > 0 ? "匹配岗位名称或包 ID" : "", aliases.length ? `匹配别名：${aliases.slice(0, 2).join("、")}` : "",
      matchedNodes.length ? `匹配节点：${matchedNodes.slice(0, 3).map(node => node.label).join("、")}` : "",
      category ? "匹配分类" : "", sourceCategory ? "匹配来源行业标签" : "", !title && !aliases.length && !matchedNodes.length && summary ? "匹配岗位简介" : ""].filter(Boolean);
    return [{ entry, score, reasons, matchedNodes }];
  }).sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, "zh") || a.entry.id.localeCompare(b.entry.id));
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(input.limit) || 20)));
  const offset = Math.max(0, Math.trunc(Number(input.offset) || 0));
  const categoryCounts = Object.fromEntries(categories.map(category => [category, classified.filter(entry => entry.categories.includes(category)).length]));
  return { query, categories, categoryCounts, total: ranked.length, offset, limit, items: ranked.slice(offset, offset + limit),
    nextOffset: offset + limit < ranked.length ? offset + limit : null };
}
