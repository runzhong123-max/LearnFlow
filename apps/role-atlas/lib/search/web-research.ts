import { stableHash } from "@/lib/build/compiler";
import type { ColdStartRequest, SourceInput, WebResearchReport, WebSearchCategory } from "@/lib/build/types";
import { boundaryHardRejects, boundaryScoreAdjustment, type BoundaryVerifier, type BoundaryVerdict } from "./boundary-verdicts";
import { SEARCH_PROVIDERS, type SearchProviderConfig } from "./providers";
import { researchRoleTitle } from "./role-query";

export type ResearchProgress = (event: {
  kind: "plan" | "search-started" | "search-retrying" | "search-completed" | "search-failed" | "source-fetched" | "source-deduplicated";
  payload: Record<string, unknown>;
}) => void;

export type PlannedQuery = { id: string; category: WebSearchCategory; query: string; priority: number };

type RawSearchResult = {
  title: string;
  url: string;
  content: string;
  snippet?: string;
  publishedAt?: string;
  publisher?: string;
  score?: number;
  extractionMethod?: "search_content" | "provider_extract" | "direct_fetch";
};

type ProviderSearchResponse = {
  results: RawSearchResult[];
  requestId?: string;
  responseTimeMs?: number;
  credits?: number;
};

type TavilyExtractResponse = {
  contentByUrl: Map<string, string>;
  requestId?: string;
  credits: number;
  failedCount: number;
};

function finiteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

class ProviderHttpError extends Error {
  constructor(public status: number, public retryAfterMs?: number) {
    super(`SEARCH_HTTP_${status}`);
  }
}

const TRACKING_PARAMS = [/^utm_/i, /^spm$/i, /^from$/i, /^source$/i, /^ref$/i, /^referrer$/i];

export function planRoleSearchQueries(request: ColdStartRequest): PlannedQuery[] {
  const role = researchRoleTitle(request.roleTitle);
  const market = request.market.trim() || "中国大陆";
  const focus = request.roleDescription.trim().slice(0, 180);
  const snapshotYear = Number(request.snapshotAsOf.slice(0, 4));
  const currentYear = Number.isInteger(snapshotYear) && snapshotYear >= 2000 && snapshotYear <= 2200
    ? snapshotYear
    : new Date().getUTCFullYear();
  const recentYears = `${currentYear - 1} ${currentYear}`;
  const specs: Array<[WebSearchCategory, string, number]> = [
    ["official_standard", `${market} ${role} 职业标准`, 10],
    ["job_market", `${market} ${role} 招聘 岗位职责`, 9],
    ["work_practice", `${role} 项目实践 工作流程 交付`, 8],
    ["technology", `${role} 官方技术文档 工具链 最佳实践 ${recentYears}`, 8],
    ["education", `${role} 课程标准 实训项目 学习路径 技能评价`, 7],
    ["future_signal", `${role} 行业趋势 技能变化 AI影响 ${recentYears}`, 6],
  ];
  if (focus) specs.push(["user_focus", `${role} ${focus} ${market}`, 9]);
  return specs.map(([category, query, priority], index) => ({
    id: `query:${stableHash(`${request.projectId}:${category}:${query}`)}`,
    category,
    query,
    priority: priority - index * 0.01,
  }));
}

function canonicalizeUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function isPublicUrl(raw: string) {
  const canonical = canonicalizeUrl(raw);
  if (!canonical) return false;
  const hostname = new URL(canonical).hostname.toLowerCase();
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (literal.includes(":")) return false;
  if (hostname === "localhost" || /\.(?:localhost|local|internal|lan|home\.arpa|test|example|invalid)$/.test(hostname)) return false;
  if (/^(?:0|10|127|169\.254|192\.0\.0|192\.0\.2|192\.168|198\.(?:18|19)|198\.51\.100|203\.0\.113)\./.test(hostname)) return false;
  const shared = hostname.match(/^100\.(\d+)\./);
  if (shared && Number(shared[1]) >= 64 && Number(shared[1]) <= 127) return false;
  const match = hostname.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return false;
  const firstOctet = Number(hostname.split(".")[0]);
  if (Number.isFinite(firstOctet) && firstOctet >= 224) return false;
  return true;
}

export function cleanText(value: string) {
  const cleaned = value
    .replace(/!\[[^\]]*\]\(data:image\/[^)]*\)/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[已移除电话号码]")
    .replace(/(?<!\d)\d{16,19}(?!\d)/g, "[已移除长数字账号]")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(热门关键字|相关推荐|猜你喜欢|全站热榜|创作者周榜|扫码关注|关注公众号|点击咨询|立即报名|免费领取|添加微信|联系电话|版权声明)(?:\s|[:：]|$)/iu.test(line))
    .filter((line) => !(line.length < 240 && /(加微信|扫码咨询|立即报名|限时优惠|领取资料|招生热线|报名咨询)/u.test(line)))
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned;
}

function mergeResultContent(current: RawSearchResult, incoming: RawSearchResult) {
  const chunks = new Map<string, string>();
  for (const content of [current.content, incoming.content]) {
    for (const chunk of content.split(/\s*\[\.\.\.\]\s*/u)) {
      const cleaned = cleanText(chunk);
      if (!cleaned) continue;
      const key = cleaned.toLocaleLowerCase();
      if (!chunks.has(key)) chunks.set(key, cleaned);
    }
  }
  const preferred = incoming.content.length > current.content.length ? incoming : current;
  return {
    ...preferred,
    content: [...chunks.values()].join(" [...] "),
    score: Math.max(current.score || 0, incoming.score || 0) || undefined,
    publishedAt: current.publishedAt || incoming.publishedAt,
    publisher: current.publisher || incoming.publisher,
  };
}

function qualityTier(url: string, category: WebSearchCategory, result?: Pick<RawSearchResult, "title" | "content">) {
  const host = new URL(url).hostname;
  const text = `${result?.title || ""}\n${result?.content.slice(0, 2_000) || ""}`;
  if (/\.gov\.cn$|gov\.cn$|moe\.gov\.cn$|stats\.gov\.cn$/i.test(host)) return "authoritative" as const;
  if (/\.edu\.cn$/i.test(host)) {
    return category === "official_standard" && /(国家|行业|职业|专业教学|课程)标准|规范|人才培养方案/u.test(text)
      ? "primary" as const
      : "secondary" as const;
  }
  if (category === "job_market" && /(^|\.)(career|careers|jobs|job)\./i.test(host)) return "primary" as const;
  if (category === "technology" && /(^|\.)(docs|developer|developers|learn)\./i.test(host)) return "primary" as const;
  if (/arxiv\.org$|doi\.org$/i.test(host)) return "primary" as const;
  if (/github\.com$/i.test(host)) {
    return category === "technology" && /(official|documentation|docs|sdk|api|framework|readme)/iu.test(text)
      ? "primary" as const
      : "contextual" as const;
  }
  if (/(bilibili|zhihu|csdn|nowcoder|juejin)\./i.test(host)) return "contextual" as const;
  if (category === "job_market" || category === "work_practice") return "contextual" as const;
  return "secondary" as const;
}

function strongestQualityTier(result: RawSearchResult, categories: WebSearchCategory[]) {
  const rank = { authoritative: 0, primary: 1, secondary: 2, contextual: 3 } as const;
  return [...new Set(categories)]
    .map((category) => qualityTier(result.url, category, result))
    .sort((left, right) => rank[left] - rank[right])[0] || "contextual";
}

function categoryFit(result: RawSearchResult, category: WebSearchCategory) {
  const text = cleanText(`${result.title}\n${result.content.slice(0, 4_000)}`);
  const patterns: Record<WebSearchCategory, RegExp> = {
    official_standard: /职业标准|专业教学标准|国家标准|行业标准|职业分类|产业政策|规范/u,
    job_market: /招聘|岗位职责|任职要求|职位描述|工作职责|招聘职位|\bresponsibilities\b|\bjob description\b|\bqualifications\b/iu,
    work_practice: /项目复盘|工作流程|典型任务|交付物|上线|部署|验收|故障|运维|研发流程/u,
    technology: /官方文档|技术文档|架构|接口|API|SDK|框架|模型|算法|工程实践|\breference\b|\bdocumentation\b/iu,
    education: /课程|实训|教学|学习路径|技能评价|人才培养/u,
    future_signal: /趋势|变化|影响|演进|未来|增长|替代|自动化/u,
    user_focus: /任务|能力|技能|交付|岗位|工作/u,
  };
  return patterns[category].test(text) ? 1 : 0.25;
}

function contentNoisePenalty(result: RawSearchResult) {
  const host = new URL(result.url).hostname;
  const text = `${result.title}\n${result.content.slice(0, 3_000)}`;
  let penalty = 0;
  if (/(bilibili|zhihu|csdn|nowcoder)\./i.test(host)) penalty += 0.08;
  if (/(报名|招生|加微信|付费课程|限时优惠|领取资料|面经|简历模板)/u.test(text)) penalty += 0.08;
  if (/(排行榜|十大|必看|保姆级|零基础|速成)/u.test(result.title)) penalty += 0.08;
  return Math.min(0.2, penalty);
}

const OCCUPATION_PATTERN = /[\p{Script=Han}A-Za-z0-9+#]{2,12}?(?:工程师|架构师|分析师|设计师|管理员|顾问|经理|专员|技术员|讲师|培训师)/gu;
const OCCUPATION_SUFFIX = /(?:工程师|架构师|分析师|设计师|管理员|顾问|经理|专员|技术员|讲师|培训师)$/u;

function occupationCore(value: string) {
  return cleanText(value).replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "").toLowerCase().replace(OCCUPATION_SUFFIX, "");
}

/** Occupations the result's own title is about. The boundary stage can only stay
 * stable if a page titled after a *different* occupation cannot ride on body
 * mentions of the target role. */
export function titledOccupations(title: string): string[] {
  return [...new Set((title.match(OCCUPATION_PATTERN) || [])
    .map(occupationCore).filter(core => core.length >= 2))];
}

/**
 * Penalty for sources whose title names an occupation outside the target role
 * boundary (e.g. a 系统架构师 or 安全工程师 page retrieved for 云运维工程师).
 * Body co-occurrence keeps such pages citable context only when they are
 * materially about the target role; the ranking penalty keeps them out of the
 * primary evidence set.
 */
export function foreignOccupationPenalty(result: Pick<RawSearchResult, "title" | "content">, roleTitle: string) {
  const targetCore = occupationCore(researchRoleTitle(roleTitle));
  if (targetCore.length < 2) return 0;
  const titled = titledOccupations(result.title);
  if (!titled.length) return 0;
  const alien = titled.filter(core => !core.includes(targetCore) && !targetCore.includes(core));
  if (!alien.length) return 0;
  // A page that still leads with the target role in its body is comparison
  // material, not boundary noise; halve the penalty instead of rejecting it.
  const body = cleanText(result.content.slice(0, 3_000)).replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "").toLowerCase();
  return body.includes(targetCore) ? 0.12 : 0.24;
}

const STALE_SENSITIVE: ReadonlySet<WebSearchCategory> = new Set(["job_market", "work_practice", "future_signal", "education"]);

/** Deterministic freshness decay for categories where a four-year-old page
 * describes a different market. Reference year stays injectable for tests. */
export function stalenessPenalty(result: Pick<RawSearchResult, "publishedAt">, category: WebSearchCategory, referenceYear = new Date().getUTCFullYear()) {
  if (!STALE_SENSITIVE.has(category) || !result.publishedAt) return 0;
  const year = Number(String(result.publishedAt).slice(0, 4));
  if (!Number.isInteger(year) || year < 2000 || year > referenceYear + 1) return 0;
  const age = referenceYear - year;
  if (age <= 2) return 0;
  return Math.min(0.16, 0.05 + (age - 2) * 0.03);
}

function roleRelevance(result: RawSearchResult, roleTitle: string) {
  const target = cleanText(researchRoleTitle(roleTitle)).replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "").toLowerCase();
  const haystack = cleanText(`${result.title}\n${result.content.slice(0, 3_000)}`).replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "").toLowerCase();
  if (!target || !haystack) return 0;
  if (haystack.includes(target)) return 1;
  const grams = new Set<string>();
  for (let index = 0; index <= target.length - 3; index += 1) grams.add(target.slice(index, index + 3));
  if (grams.size === 0) return haystack.includes(target) ? 1 : 0;
  const matched = [...grams].filter((gram) => haystack.includes(gram)).length;
  const core = target.replace(/(?:工程师|架构师|分析师|设计师|管理员|顾问|经理|engineer|developer|architect|analyst)$/iu, "");
  if (core.length >= 2 && core !== target) {
    const coreGrams = new Set<string>();
    const width = Math.min(3, core.length);
    for (let i = 0; i <= core.length - width; i++) coreGrams.add(core.slice(i, i + width));
    const coreMatch = [...coreGrams].filter(gram => haystack.includes(gram)).length / coreGrams.size;
    return coreMatch * 0.8 + matched / grams.size * 0.2;
  }
  return matched / grams.size;
}

function qualityScore(result: RawSearchResult, category: WebSearchCategory, roleTitle: string) {
  const tier = qualityTier(result.url, category, result);
  const tierScore = { authoritative: 1, primary: 0.9, secondary: 0.72, contextual: 0.65 }[tier];
  const contentScore = Math.min(result.content.length / 5_000, 1) * 0.16;
  const providerScore = Math.max(0, Math.min(result.score || 0.5, 1)) * 0.12;
  return Math.max(0, Math.min(1, tierScore * 0.45 + contentScore + providerScore
    + roleRelevance(result, roleTitle) * 0.2 + categoryFit(result, category) * 0.12
    - contentNoisePenalty(result) - foreignOccupationPenalty(result, roleTitle) - stalenessPenalty(result, category)));
}

function researchRelevance(result: RawSearchResult, roleTitle: string, queries: PlannedQuery[]) {
  const occupational = roleRelevance(result, roleTitle);
  // Official method documentation often never names the Chinese occupation.
  // Admit it only through distinctive technical terms in its actual query;
  // generic "API/docs/engineer" matches cannot admit an unrelated product page.
  if (qualityTier(result.url, "technology", result) !== "primary") return occupational;
  const haystack = `${result.title}\n${result.content.slice(0, 4_000)}`.toLowerCase();
  const generic = /^(?:official|documentation|docs?|reference|api|sdk|framework|engineer|engineering|developer|development|software|hardware|best|practice|practices|guide|tutorial|and|the|for|with|site|https?|www|com)$/;
  const focused = queries.filter(query => query.category === "technology").some(query => {
    const terms = [...new Set((query.query.toLowerCase().match(/\b[a-z][a-z0-9+#.-]{2,}\b/g) || []).filter(term => !generic.test(term)))];
    return terms.length > 0 && terms.filter(term => haystack.includes(term)).length / terms.length >= 0.6;
  });
  return focused ? Math.max(occupational, 0.65) : occupational;
}

function minimumRoleRelevance(categories: WebSearchCategory[]) {
  // Technology queries are especially prone to returning broadly related product
  // pages (for example PDM rankings) that only mention part of a role title. Keep
  // those pages out unless the result is materially tied to the target role.
  if (categories.length === 1 && categories[0] === "technology") return 0.4;
  return 0.2;
}

function isReadableContent(content: string) {
  if (content.length < 120 || /(PE){12}/u.test(content)) return false;
  if ([...content].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  })) return false;
  const common = content.match(/[\p{Script=Han}\p{Script=Latin}\p{N}\s，。；：、“”‘’（）()【】《》,.!?%+\-_/:[\]{}'"#@&=<>]/gu)?.length || 0;
  return common / content.length >= 0.86;
}

function withTimeout(signal: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

async function providerRequest(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 18_000) {
  const timeout = withTimeout(signal, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: timeout.signal });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
      const dateDelay = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : Number.NaN;
      const retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1_000)
        : Number.isFinite(dateDelay) ? Math.max(0, dateDelay) : undefined;
      throw new ProviderHttpError(response.status, retryAfterMs);
    }
    return await response.json() as Record<string, unknown>;
  } finally {
    timeout.dispose();
  }
}

function shouldRetrySearch(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  if (error instanceof ProviderHttpError) return error.status === 429 || error.status >= 500;
  const message = error instanceof Error ? error.message : String(error);
  if (/SEARCH_HTTP_(429|5\d\d)/.test(message)) return true;
  if (/abort|timed?\s*out|network|fetch failed/i.test(message)) return true;
  return error instanceof TypeError;
}

async function retryDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason || new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function searchWithRetry(input: {
  config: SearchProviderConfig;
  query: PlannedQuery;
  request: ColdStartRequest;
  signal?: AbortSignal;
  onProgress?: ResearchProgress;
}) {
  const search = input.config.provider === "glm" ? searchGlm : input.config.provider === "exa" ? searchExa : input.config.provider === "tavily" ? searchTavily : searchBocha;
  const maxAttempts = 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await search(input.config, input.query, input.request, input.signal);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetrySearch(error, input.signal)) throw error;
      input.onProgress?.({
        kind: "search-retrying",
        payload: {
          queryId: input.query.id,
          category: input.query.category,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          reason: safeFailure(error),
        },
      });
      const retryAfterMs = lastError instanceof ProviderHttpError ? lastError.retryAfterMs : undefined;
      await retryDelay(Math.min(retryAfterMs ?? 400 * attempt, 60_000), input.signal);
    }
  }
  throw lastError;
}

async function searchExa(config: SearchProviderConfig, query: PlannedQuery, _request: ColdStartRequest, signal?: AbortSignal): Promise<ProviderSearchResponse> {
  const payload = await providerRequest("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.apiKey },
    body: JSON.stringify({
      query: query.query,
      type: "auto",
      numResults: 5,
      moderation: true,
      contents: { text: { maxCharacters: 9_000 }, highlights: { maxCharacters: 1_500 } },
    }),
  }, signal);
  const results = Array.isArray(payload.results) ? payload.results as Array<Record<string, unknown>> : [];
  return { results: results.flatMap((item) => {
    const url = typeof item.url === "string" ? canonicalizeUrl(item.url) : null;
    if (!url || !isPublicUrl(url)) return [];
    const highlights = Array.isArray(item.highlights) ? item.highlights.filter((value): value is string => typeof value === "string").join("\n") : "";
    return [{
      title: String(item.title || url),
      url,
      content: cleanText(String(item.text || highlights || "")),
      snippet: highlights,
      publishedAt: typeof item.publishedDate === "string" ? item.publishedDate : undefined,
      publisher: typeof item.author === "string" ? item.author : undefined,
      score: typeof item.score === "number" ? item.score : undefined,
      extractionMethod: "search_content",
    }];
  }) };
}

async function searchTavily(config: SearchProviderConfig, query: PlannedQuery, request: ColdStartRequest, signal?: AbortSignal): Promise<ProviderSearchResponse> {
  const recent = query.category === "technology" || query.category === "future_signal";
  const payload = await providerRequest("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      "X-Project-ID": request.projectId,
      "X-Session-Id": request.runId,
    },
    body: JSON.stringify({
      query: query.query,
      search_depth: "advanced",
      chunks_per_source: 3,
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_usage: true,
      topic: "general",
      ...(recent ? { time_range: "year" } : {}),
      ...(/中国|china/i.test(request.market) ? { country: "china" } : {}),
    }),
  }, signal);
  const results = Array.isArray(payload.results) ? payload.results as Array<Record<string, unknown>> : [];
  const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : {};
  return {
    requestId: typeof payload.request_id === "string" ? payload.request_id : undefined,
    responseTimeMs: finiteNumber(payload.response_time) === undefined ? undefined : Math.round(finiteNumber(payload.response_time)! * 1_000),
    credits: finiteNumber(usage.credits),
    results: results.flatMap((item) => {
    const url = typeof item.url === "string" ? canonicalizeUrl(item.url) : null;
    if (!url || !isPublicUrl(url)) return [];
    return [{
      title: String(item.title || url),
      url,
      content: cleanText(String(item.content || "")),
      snippet: typeof item.content === "string" ? item.content : undefined,
      publishedAt: typeof item.published_date === "string" ? item.published_date : undefined,
      score: typeof item.score === "number" ? item.score : undefined,
      extractionMethod: "search_content",
    }];
  }),
  };
}

async function extractTavily(
  config: SearchProviderConfig,
  request: ColdStartRequest,
  intent: string,
  urls: string[],
  signal?: AbortSignal,
): Promise<TavilyExtractResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const payload = await providerRequest("https://api.tavily.com/extract", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "X-Project-ID": request.projectId,
          "X-Session-Id": request.runId,
        },
        body: JSON.stringify({
          urls,
          query: intent,
          chunks_per_source: 5,
          extract_depth: "basic",
          format: "markdown",
          timeout: 30,
          include_usage: true,
        }),
      }, signal, 40_000);
      const results = Array.isArray(payload.results) ? payload.results as Array<Record<string, unknown>> : [];
      const failed = Array.isArray(payload.failed_results) ? payload.failed_results.length : 0;
      const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : {};
      const contentByUrl = new Map<string, string>();
      for (const item of results) {
        const url = typeof item.url === "string" ? canonicalizeUrl(item.url) : null;
        if (!url) continue;
        const content = cleanText(String(item.raw_content || ""));
        if (content) contentByUrl.set(url, content);
      }
      return {
        contentByUrl,
        requestId: typeof payload.request_id === "string" ? payload.request_id : undefined,
        credits: finiteNumber(usage.credits) || 0,
        failedCount: Math.max(failed, urls.length - contentByUrl.size),
      };
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !shouldRetrySearch(error, signal)) throw error;
      const retryAfterMs = error instanceof ProviderHttpError ? error.retryAfterMs : undefined;
      await retryDelay(Math.min(retryAfterMs ?? 500 * attempt, 15_000), signal);
    }
  }
  throw lastError;
}

export async function searchGlm(config: SearchProviderConfig, query: PlannedQuery, _request: ColdStartRequest, signal?: AbortSignal): Promise<ProviderSearchResponse> {
  const payload = await providerRequest("https://open.bigmodel.cn/api/paas/v4/web_search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      search_query: [...query.query.trim()].slice(0, 70).join(""),
      search_engine: config.engine || "search_pro",
      search_intent: false,
      ...(config.engine === "search_pro_quark" ? {} : { count: 10 }),
      search_recency_filter: "noLimit",
      request_id: crypto.randomUUID(),
    }),
  }, signal);
  if (payload.error || !Array.isArray(payload.search_result)) throw new Error("GLM_SEARCH_INVALID_RESPONSE");
  return {
    requestId: typeof payload.request_id === "string" ? payload.request_id : typeof payload.id === "string" ? payload.id : undefined,
    results: (payload.search_result as Array<Record<string, unknown>>).flatMap((item) => {
      if (!item || typeof item !== "object" || typeof item.link !== "string") return [];
      const url = canonicalizeUrl(item.link);
      if (!url || !isPublicUrl(url)) return [];
      const content = typeof item.content === "string" ? cleanText(item.content) : "";
      return [{ title: typeof item.title === "string" ? item.title : url, url, content, snippet: content,
        publishedAt: typeof item.publish_date === "string" ? item.publish_date : undefined,
        publisher: typeof item.media === "string" ? item.media : undefined,
        extractionMethod: "search_content" as const }];
    }),
  };
}

async function searchBocha(config: SearchProviderConfig, query: PlannedQuery, _request: ColdStartRequest, signal?: AbortSignal): Promise<ProviderSearchResponse> {
  const payload = await providerRequest("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ query: query.query, freshness: "noLimit", summary: true, count: 6 }),
  }, signal);
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const webPages = data.webPages && typeof data.webPages === "object" ? data.webPages as Record<string, unknown> : {};
  const results = Array.isArray(webPages.value) ? webPages.value as Array<Record<string, unknown>> : [];
  return { results: results.flatMap((item) => {
    const urlValue = typeof item.url === "string" ? item.url : typeof item.displayUrl === "string" ? item.displayUrl : "";
    const url = canonicalizeUrl(urlValue);
    if (!url || !isPublicUrl(url)) return [];
    const summary = String(item.summary || item.snippet || "");
    return [{
      title: String(item.name || item.title || url),
      url,
      content: cleanText(summary),
      snippet: summary,
      publishedAt: typeof item.datePublished === "string" ? item.datePublished : undefined,
      publisher: typeof item.siteName === "string" ? item.siteName : undefined,
      extractionMethod: "search_content",
    }];
  }) };
}

async function fetchReadablePage(result: RawSearchResult, signal?: AbortSignal) {
  if (result.content.length >= 900 || !isPublicUrl(result.url) || new URL(result.url).protocol !== "https:") return result;
  const timeout = withTimeout(signal, 12_000);
  try {
    let currentUrl = result.url;
    let response: Response | null = null;
    for (let redirect = 0; redirect < 4; redirect += 1) {
      if (!isPublicUrl(currentUrl)) return result;
      response = await fetch(currentUrl, {
        headers: { "user-agent": "RoleAtlasResearchBot/0.1 (+source-indexing; contact project owner)" },
        redirect: "manual",
        signal: timeout.signal,
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) return result;
      currentUrl = new URL(location, currentUrl).toString();
      response = null;
    }
    if (!response?.ok || !isPublicUrl(currentUrl)) return result;
    const type = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/json|application\/xml|text\/xml/i.test(type)) return result;
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 900_000) return result;
    const text = (await response.text()).slice(0, 900_000);
    const cleaned = cleanText(text).slice(0, 14_000);
    return cleaned.length > result.content.length ? { ...result, content: cleaned, extractionMethod: "direct_fetch" as const } : result;
  } catch {
    return result;
  } finally {
    timeout.dispose();
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function safeFailure(error: unknown) {
  const text = error instanceof Error ? error.message : "SEARCH_FAILED";
  if (/401|403/.test(text)) return "搜索 API Key 无效或没有权限";
  if (/429/.test(text)) return "搜索厂商限流";
  if (/432|433/.test(text)) return "搜索厂商额度或付费上限已用尽";
  if (/abort/i.test(text)) return "搜索超时或已取消";
  return "搜索请求失败";
}

export async function researchRoleSources(input: {
  request: ColdStartRequest;
  config: SearchProviderConfig;
  queries?: PlannedQuery[];
  planStrategy?: "model_assisted" | "deterministic";
  plannerFallbackReason?: string;
  signal?: AbortSignal;
  onProgress?: ResearchProgress;
  sourceLimit?: number;
  verifyBoundaries?: BoundaryVerifier;
}): Promise<{ sources: SourceInput[]; report: WebResearchReport }> {
  const startedAt = new Date().toISOString();
  const queries = input.queries?.length ? input.queries : planRoleSearchQueries(input.request);
  input.onProgress?.({
    kind: "plan",
    payload: {
      provider: input.config.provider,
      strategy: input.planStrategy || "deterministic",
      fallbackReason: input.plannerFallbackReason,
      queries,
    },
  });
  const failures: WebResearchReport["failures"] = [];
  const byQuery = await mapLimit(queries, 4, async (query) => {
    input.onProgress?.({ kind: "search-started", payload: { queryId: query.id, category: query.category, query: query.query } });
    try {
      const response = await searchWithRetry({ config: input.config, query, request: input.request, signal: input.signal, onProgress: input.onProgress });
      input.onProgress?.({
        kind: "search-completed",
        payload: {
          queryId: query.id,
          category: query.category,
          resultCount: response.results.length,
          requestId: response.requestId,
          responseTimeMs: response.responseTimeMs,
          credits: response.credits,
        },
      });
      return { query, response, results: response.results };
    } catch (error) {
      const message = safeFailure(error);
      failures.push({ queryId: query.id, message });
      input.onProgress?.({ kind: "search-failed", payload: { queryId: query.id, category: query.category, message } });
      return { query, response: { results: [] } as ProviderSearchResponse, results: [] as RawSearchResult[] };
    }
  });

  const candidates = byQuery.flatMap(({ query, results }) => results.map((result) => ({ query, result })));

  const deduped = new Map<string, { query: PlannedQuery; result: RawSearchResult; queryIds: string[]; categories: WebSearchCategory[] }>();
  let duplicateCount = 0;
  for (const candidate of candidates) {
    if (candidate.result.content.length < 40) continue;
    const key = canonicalizeUrl(candidate.result.url) || candidate.result.url;
    const existing = deduped.get(key);
    if (existing) {
      duplicateCount += 1;
      existing.queryIds.push(candidate.query.id);
      existing.categories.push(candidate.query.category);
      existing.result = mergeResultContent(existing.result, candidate.result);
      input.onProgress?.({ kind: "source-deduplicated", payload: { url: key, queryIds: existing.queryIds } });
    } else deduped.set(key, { ...candidate, queryIds: [candidate.query.id], categories: [candidate.query.category] });
  }

  type DedupedCandidate = { query: PlannedQuery; result: RawSearchResult; queryIds: string[]; categories: WebSearchCategory[] };
  const contentDeduped = new Map<string, DedupedCandidate>();
  const contentDuplicates: Array<{ item: DedupedCandidate; duplicateOf: string }> = [];
  for (const item of deduped.values()) {
    const fingerprint = stableHash(cleanText(item.result.content).slice(0, 8_000));
    const existing = contentDeduped.get(fingerprint);
    if (existing) {
      duplicateCount += 1;
      contentDuplicates.push({ item, duplicateOf: existing.result.url });
      existing.queryIds.push(...item.queryIds);
      existing.categories.push(...item.categories);
      input.onProgress?.({ kind: "source-deduplicated", payload: { url: item.result.url, duplicateOf: existing.result.url, reason: "content_hash" } });
    } else contentDeduped.set(fingerprint, item);
  }

  const ranked = [...contentDeduped.values()]
    .map((item) => ({
      ...item,
      relevance: researchRelevance(item.result, input.request.roleTitle, queries.filter(query => item.queryIds.includes(query.id))),
      score: qualityScore(item.result, item.query.category, input.request.roleTitle) + item.query.priority / 100,
      boundaryVerdict: undefined as BoundaryVerdict | undefined,
    }))
    .sort((left, right) => right.score - left.score);

  // Agent boundary pass: the model classifies how each leading candidate
  // relates to the target occupation's boundary. Verdicts can only demote or
  // reject; on any failure the deterministic heuristics alone decide.
  if (input.verifyBoundaries && ranked.length) {
    const verdicts = await input.verifyBoundaries({
      roleTitle: input.request.roleTitle,
      market: input.request.market,
      roleDescription: input.request.roleDescription,
      candidates: ranked.slice(0, 48).map((item) => ({
        url: item.result.url,
        title: item.result.title,
        domain: new URL(item.result.url).hostname,
        excerpt: cleanText(item.result.content).slice(0, 600),
      })),
      signal: input.signal,
    }).catch(() => undefined);
    if (verdicts?.size) {
      for (const item of ranked) {
        const verdict = verdicts.get(item.result.url);
        if (!verdict) continue;
        item.boundaryVerdict = verdict;
        item.score = Math.max(0, item.score + boundaryScoreAdjustment(verdict));
      }
      ranked.sort((left, right) => right.score - left.score);
    }
  }
  const perDomain = new Map<string, number>();
  const selected: typeof ranked = [];
  const selectedUrls = new Set<string>();
  const limit = Math.max(6, Math.min(input.sourceLimit || 64, 64));
  const accept = (item: (typeof ranked)[number]) => {
    if (selectedUrls.has(item.result.url) || selected.length >= limit) return false;
    if (item.relevance < minimumRoleRelevance(item.categories)) return false;
    // A non-authoritative page titled after a different occupation (架构师 /
    // 安全工程师 / 培训讲师 …) without target-role substance is boundary noise,
    // not comparison material; keep it out of the selected evidence set.
    // Authoritative standards often legitimately name a neighbouring occupation
    // (e.g. 国家职业标准), so they are only down-ranked, never hard-rejected.
    const tier = strongestQualityTier(item.result, item.categories);
    if (foreignOccupationPenalty(item.result, input.request.roleTitle) >= 0.2 && (tier === "secondary" || tier === "contextual")) return false;
    // The model boundary pass may veto a low-tier page it confidently places
    // outside the target occupation, even when the title heuristic missed it.
    if (boundaryHardRejects(item.boundaryVerdict, tier)) return false;
    const host = new URL(item.result.url).hostname;
    const count = perDomain.get(host) || 0;
    if (count >= 4) return false;
    selected.push(item);
    selectedUrls.add(item.result.url);
    perDomain.set(host, count + 1);
    return true;
  };
  for (const category of [...new Set(queries.map((query) => query.category))]) {
    if (selected.some((item) => item.categories.includes(category))) continue;
    for (const candidate of ranked.filter((item) => item.categories.includes(category))) {
      if (accept(candidate)) break;
    }
  }
  for (const item of ranked) accept(item);

  if (input.config.provider !== "tavily") {
    const enriched = await mapLimit(selected, 5, async (item) => {
      const result = await fetchReadablePage(item.result, input.signal);
      input.onProgress?.({ kind: "source-fetched", payload: { queryId: item.query.id, url: result.url, chars: result.content.length, method: result.extractionMethod || "search_content" } });
      return { item, result };
    });
    for (const { item, result } of enriched) item.result = result;
  }

  const extractRequestIdsByUrl = new Map<string, string[]>();
  let extractRequestedSourceCount = 0;
  let extractedSourceCount = 0;
  let extractFailedSourceCount = 0;
  let extractCredits = 0;
  let extractRequestCount = 0;
  if (input.config.provider === "tavily" && selected.length > 0) {
    const batches: Array<typeof selected> = [];
    // A single 16-20 URL extract request creates an all-or-nothing latency
    // cliff. Small batches preserve successful pages when one domain stalls,
    // while two concurrent requests keep the wall-clock cost bounded.
    for (let index = 0; index < selected.length; index += 4) {
      batches.push(selected.slice(index, index + 4));
    }
    const extractionIntent = cleanText([
      input.request.roleTitle,
      input.request.roleDescription.slice(0, 220),
      "岗位职责 典型工作任务 工作流程 交付物 任职要求 能力 知识技能 职业教育",
    ].filter(Boolean).join(" ")).slice(0, 480);
    const extractionResults = await mapLimit(batches, 2, async (items, batchIndex) => {
      const urls = items.map((item) => item.result.url);
      extractRequestedSourceCount += urls.length;
      extractRequestCount += 1;
      try {
        const extracted = await extractTavily(input.config, input.request, extractionIntent, urls, input.signal);
        return { batchIndex, items, extracted };
      } catch (error) {
        const message = `正文抽取失败，保留搜索片段：${safeFailure(error)}`;
        failures.push({ queryId: `extract:batch-${batchIndex + 1}`, message });
        return { batchIndex, items, extracted: null };
      }
    });
    for (const { batchIndex, items, extracted } of extractionResults) {
      if (!extracted) {
        extractFailedSourceCount += items.length;
        continue;
      }
      extractCredits += extracted.credits;
      extractFailedSourceCount += extracted.failedCount;
      if (extracted.failedCount > 0) {
        failures.push({
          queryId: `extract:batch-${batchIndex + 1}`,
          message: `${extracted.failedCount} 个来源正文抽取失败，已保留可读搜索片段。`,
        });
      }
      for (const item of items) {
        const content = extracted.contentByUrl.get(item.result.url);
        if (content && isReadableContent(content)) {
          extractedSourceCount += 1;
          item.result.content = content;
          item.result.extractionMethod = "provider_extract";
          input.onProgress?.({ kind: "source-fetched", payload: { queryId: item.query.id, url: item.result.url, chars: content.length, method: "tavily_extract" } });
        } else if (content) extractFailedSourceCount += 1;
        if (extracted.requestId) extractRequestIdsByUrl.set(item.result.url, [extracted.requestId]);
      }
    }
    for (const item of selected.filter((candidate) => candidate.result.extractionMethod !== "provider_extract")) {
      input.onProgress?.({ kind: "source-fetched", payload: { queryId: item.query.id, url: item.result.url, chars: item.result.content.length, method: "search_content_fallback" } });
    }
  }

  const fetchedAt = new Date().toISOString();
  const finalSelected = selected.filter((item) => item.result.content.length >= 120 && isReadableContent(item.result.content));
  const finalSelectedUrls = new Set(finalSelected.map((item) => item.result.url));
  const sources: SourceInput[] = finalSelected.map(({ result, queryIds, categories, score }) => ({
    title: result.title.slice(0, 240),
    content: result.content.slice(0, 14_000),
    kind: "public_document",
    locator: result.url,
    observedAt: result.publishedAt || fetchedAt,
    publisher: result.publisher,
    domain: new URL(result.url).hostname,
    publishedAt: result.publishedAt,
    fetchedAt,
    sourceTier: strongestQualityTier(result, categories),
    queryIds: [...new Set(queryIds)],
    searchCategories: [...new Set(categories)],
    retrievalScore: Math.min(1, score),
    provider: input.config.provider,
    providerRequestIds: [...new Set([
      ...queryIds.flatMap((queryId) => {
        const requestId = byQuery.find((item) => item.query.id === queryId)?.response.requestId;
        return requestId ? [requestId] : [];
      }),
      ...(extractRequestIdsByUrl.get(result.url) || []),
    ])],
    extractionMethod: result.extractionMethod || "search_content",
  }));
  const candidateAudit: WebResearchReport["candidates"] = [
    ...ranked.map((item) => {
      const domain = new URL(item.result.url).hostname;
      let disposition: WebResearchReport["candidates"][number]["disposition"];
      const candidateTier = strongestQualityTier(item.result, item.categories);
      if (finalSelectedUrls.has(item.result.url)) disposition = "selected";
      else if (selectedUrls.has(item.result.url)) disposition = "unreadable";
      // Name the boundary reason before the generic relevance floor: a low-tier
      // page titled after another occupation was rejected because of what it is,
      // and the audit should say so.
      else if (foreignOccupationPenalty(item.result, input.request.roleTitle) >= 0.2
        && ["secondary", "contextual"].includes(candidateTier)) disposition = "foreign_occupation";
      else if (boundaryHardRejects(item.boundaryVerdict, candidateTier)) disposition = "foreign_occupation";
      else if (item.relevance < minimumRoleRelevance(item.categories)) disposition = "low_relevance";
      else if ((perDomain.get(domain) || 0) >= 2) disposition = "domain_limit";
      else disposition = "source_limit";
      return {
        title: item.result.title.slice(0, 240),
        url: item.result.url,
        domain,
        queryIds: [...new Set(item.queryIds)],
        categories: [...new Set(item.categories)],
        providerScore: item.result.score,
        relevanceScore: item.relevance,
        rankingScore: item.score,
        disposition,
        boundaryVerdict: item.boundaryVerdict
          ? { relation: item.boundaryVerdict.relation, confidence: item.boundaryVerdict.confidence, note: item.boundaryVerdict.note }
          : undefined,
      };
    }),
    ...contentDuplicates.map(({ item, duplicateOf }) => ({
      title: item.result.title.slice(0, 240),
      url: item.result.url,
      domain: new URL(item.result.url).hostname,
      queryIds: [...new Set(item.queryIds)],
      categories: [...new Set(item.categories)],
      providerScore: item.result.score,
      relevanceScore: roleRelevance(item.result, input.request.roleTitle),
      rankingScore: qualityScore(item.result, item.query.category, input.request.roleTitle) + item.query.priority / 100,
      disposition: "duplicate_content" as const,
      duplicateOf,
    })),
  ];
  const failedQueryIds = new Set(failures.map((failure) => failure.queryId));
  const categoryCoverage: WebResearchReport["categoryCoverage"] = [...new Set(queries.map((query) => query.category))].map((category) => {
    const categoryQueries = queries.filter((query) => query.category === category);
    const candidateUrls = new Set(candidates.filter((candidate) => candidate.query.category === category).map((candidate) => candidate.result.url));
    const selectedSourceCount = sources.filter((source) => source.searchCategories?.includes(category)).length;
    const allFailed = categoryQueries.length > 0 && categoryQueries.every((query) => failedQueryIds.has(query.id));
    return {
      category,
      queryCount: categoryQueries.length,
      candidateCount: candidateUrls.size,
      selectedSourceCount,
      status: selectedSourceCount > 0 ? "covered" : allFailed ? "failed" : "missing",
    };
  });
  const searchCredits = byQuery.reduce((total, item) => total + (item.response.credits || 0), 0);
  return {
    sources,
    report: {
      provider: input.config.provider,
      providerName: SEARCH_PROVIDERS[input.config.provider].name,
      planStrategy: input.planStrategy || "deterministic",
      plannerFallbackReason: input.plannerFallbackReason,
      startedAt,
      completedAt: fetchedAt,
      queries: queries.map((query) => ({
        id: query.id,
        category: query.category,
        query: query.query,
        resultCount: byQuery.find((item) => item.query.id === query.id)?.results.length || 0,
        requestId: byQuery.find((item) => item.query.id === query.id)?.response.requestId,
        responseTimeMs: byQuery.find((item) => item.query.id === query.id)?.response.responseTimeMs,
        credits: byQuery.find((item) => item.query.id === query.id)?.response.credits,
      })),
      selectedSourceCount: sources.length,
      candidateCount: candidates.length,
      deduplicatedCount: duplicateCount,
      candidates: candidateAudit,
      categoryCoverage,
      failures,
      extraction: input.config.provider === "tavily" ? {
        requestCount: extractRequestCount,
        requestedSourceCount: extractRequestedSourceCount,
        extractedSourceCount,
        failedSourceCount: extractFailedSourceCount,
        requestIds: [...new Set([...extractRequestIdsByUrl.values()].flat())],
      } : undefined,
      usage: input.config.provider === "tavily" ? {
        searchCredits,
        extractCredits,
        totalCredits: searchCredits + extractCredits,
      } : undefined,
    },
  };
}

export async function testSearchProvider(config: SearchProviderConfig, signal?: AbortSignal) {
  const request: ColdStartRequest = {
    runId: "test-search-provider",
    projectId: "test-search-provider",
    roleTitle: "软件工程师",
    roleDescription: "",
    market: "中国大陆",
    audience: ["高职学生"],
    snapshotAsOf: new Date().toISOString().slice(0, 10),
    sources: [],
  };
  const query = planRoleSearchQueries(request)[0];
  const search = config.provider === "glm" ? searchGlm : config.provider === "exa" ? searchExa : config.provider === "tavily" ? searchTavily : searchBocha;
  const startedAt = Date.now();
  const response = await search(config, query, request, signal);
  return { resultCount: response.results.length, latencyMs: Date.now() - startedAt };
}
