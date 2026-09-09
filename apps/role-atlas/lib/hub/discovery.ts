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
  nodeIndex: Array<{ id: string; label: string; type: string; aliases: string[]; summary?: string }>;
};

export function hubStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))] : [];
}

export function normalizeHubQuery(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, "");
}

export type HubSearchTarget = "role" | "task" | "all";
export const HUB_SEARCH_STRATEGY = "field-coverage.v2";
// Job suffixes and conversational boilerplate cannot establish occupational relevance.
const noise = /工程师|技术员|专员|岗位|职位|工作任务|典型任务|相关|我想|了解|请问|查找|搜索|推荐|有哪些|方向|engineer|specialist/giu;
const aliases: Array<[RegExp, string]> = [
  [/cloud\s*(?:computing|operations?)/giu, "云计算"], [/software\s*(?:quality assurance|testing)|\bqa\b/giu, "软件测试"],
  [/云维护/gu, "云运行维护"], [/运维/gu, "运行维护"], [/云平台/gu, "云计算"], [/数据库|\bdatabase\b/giu, "数据库"],
];
function searchable(value: string) {
  let result = value.normalize("NFKC").toLowerCase().replace(noise, " ");
  for (const [pattern, replacement] of aliases) result = result.replace(pattern, replacement);
  return result;
}
function terms(query: string) {
  const value = searchable(query);
  // Character bigrams retain Chinese technical compounds that ICU splits into single characters.
  return [...new Set(([...value.matchAll(/[a-z0-9][a-z0-9+#]*/giu)].map(match => match[0])).concat(
    (value.match(/[\p{Script=Han}]+/gu) || []).flatMap(run => Array.from({ length: Math.max(0, run.length - 1) }, (_, i) => run.slice(i, i + 2)))
  ))];
}
function textScore(query: string, value: string) {
  const words = terms(query), target = normalizeHubQuery(searchable(value)), normalized = normalizeHubQuery(searchable(query));
  if (!words.length || !target) return 0;
  if (target === normalized) return 100;
  if (normalized.length >= 2 && target.includes(normalized)) return 90;
  const hits = words.filter(word => target.includes(word));
  const coverage = hits.length / words.length;
  return coverage >= 0.65 ? Math.round(coverage * 70) : 0;
}
function roleQuery(query: string) {
  // Parenthetical qualifiers refine a role; do not make an unrelated shared qualifier a match.
  return query.replace(/[（(][^）)]*[）)]/gu, " ").trim();
}
function roleTextScore(query: string, label: string) {
  const name = roleQuery(query);
  const normalized = normalizeHubQuery(searchable(name));
  // Preserve the work domain: shared operations/development verbs cannot erase
  // the difference between cloud, system, network or software roles.
  const domain = normalized.split(/运行维护|开发|实施|管理|应用|设计|支持|测试/u)[0];
  if (domain && !normalizeHubQuery(searchable(label)).includes(domain)) return 0;
  return textScore(name, label);
}
export function searchHub(entries: HubEntry[], input: { query?: string; target?: HubSearchTarget; roleQuery?: string; category?: string; limit?: number; offset?: number } = {}) {
  const query = String(input.query || "").trim().slice(0, 500), target = input.target || "all";
  const classified = entries.map(entry => ({ ...entry, categories: classifyHubEntry(entry) }));
  const categories = HUB_TAXONOMY.map(category => category.label);
  const ranked = classified.flatMap(entry => {
    if (input.category && !entry.categories.includes(input.category)) return [];
    const roleMatch = (value: string) => Math.max(...[entry.title, ...entry.aliases,
      ...entry.nodeIndex.filter(node => ["market_role", "role"].includes(node.type)).flatMap(node => [node.label, ...node.aliases])]
      .map(label => roleTextScore(value, label)), 0);
    if (input.roleQuery?.trim() && !roleMatch(input.roleQuery)) return [];
    const title = roleTextScore(query, entry.title);
    const matchedAliases = entry.aliases.filter(alias => roleTextScore(query, alias) > 0);
    const exactPackageId = Boolean(query) && normalizeHubQuery(query) === normalizeHubQuery(entry.packageId);
    const roleScore = exactPackageId ? 100 : roleMatch(query);
    if (target === "all" && /工程师|技术员|专员|\bengineer\b/iu.test(query) && !roleScore) return [];
    const matchedNodes = entry.nodeIndex.flatMap(node => {
      const isTask = ["task", "typical_task"].includes(node.type);
      if (target === "role" || (target === "task" && !isTask)) return [];
      const score = Math.max(...[node.label, ...node.aliases].map(label => textScore(query, label)),
        isTask ? textScore(query, `${node.label} ${node.summary || ""}`) * 0.8 : 0);
      return score > 0 || (!query && target === "task") ? [{ ...node, score }] : [];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const matchedTasks = matchedNodes.filter(node => ["task", "typical_task"].includes(node.type));
    const score = target === "task" ? matchedTasks[0]?.score || 0 : roleScore * 2 + (matchedNodes[0]?.score || 0);
    if (query && !score) return [];
    if (target === "task" && !matchedTasks.length) return [];
    const reasons = [exactPackageId ? "匹配包 ID" : "", title > 0 ? "匹配岗位名称" : "", matchedAliases.length ? `匹配别名：${matchedAliases.slice(0, 2).join("、")}` : "",
      matchedNodes.length ? `匹配${target === "task" ? "任务" : "节点"}：${matchedNodes.slice(0, 3).map(node => node.label).join("、")}` : "",
      roleScore && !exactPackageId && !title && !matchedAliases.length ? "匹配岗位节点" : ""].filter(Boolean);
    return [{ entry, score, reasons, matchedNodes: matchedNodes.slice(0, 6), matchedTasks: matchedTasks.slice(0, 6),
      matchedTaskCount: matchedTasks.length }];
  }).sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, "zh") || a.entry.id.localeCompare(b.entry.id));
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(input.limit) || 20)));
  const offset = Math.max(0, Math.trunc(Number(input.offset) || 0));
  const categoryCounts = Object.fromEntries(categories.map(category => [category, classified.filter(entry => entry.categories.includes(category)).length]));
  return { query, target, strategy: HUB_SEARCH_STRATEGY, categories, categoryCounts, total: ranked.length, offset, limit, items: ranked.slice(offset, offset + limit),
    nextOffset: offset + limit < ranked.length ? offset + limit : null };
}
