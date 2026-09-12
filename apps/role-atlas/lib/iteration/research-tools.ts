import { ResearchSourceStore } from "@/lib/research/source-store";
import type { BudgetLedger } from "./budget-ledger";
import type { ColdStartRequest, SourceAsset, SourceSegment } from "@/lib/build/types";
import type { BoundaryVerifier } from "@/lib/search/boundary-verdicts";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { researchRoleSources, fetchReadablePage } from "@/lib/search/web-research";
import type { ResearchTool } from "@/lib/agent/research-loop";

/**
 * Concrete tools for the bounded research loop.
 *
 * Each adapter binds one capability the repository already has — retrieval and
 * source reading — to the `ResearchTool` contract, and each returns a **bounded,
 * structured** observation rather than raw payloads. That is the whole point of
 * the boundary: long text stays out of the agent's context unless the agent asks
 * for a specific segment by id.
 *
 * Tools are read-only by construction. None of them writes to a snapshot, and
 * none of them can enlarge what a study is allowed to touch: scope comes from
 * the work item behind the task card, not from a tool argument.
 */

/** Keep one call from draining the whole search budget in a single turn. */
export const MAX_QUERIES_PER_SEARCH_CALL = 3;
/** Excerpt budget per source, so an observation stays small enough to reason over. */
export const SOURCE_EXCERPT_CHARS = 600;
export const MAX_EXCERPTS_PER_CALL = 6;

function clampText(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Retrieval tool. One query per call by design: the loop runs one tool call per
 * turn, and forcing a single query keeps each turn's observation attributable to
 * a query the agent actually chose.
 */
export function createSearchTool(input: {
  request: ColdStartRequest;
  config: SearchProviderConfig;
  verifyBoundaries?: BoundaryVerifier;
  maxQueriesPerCall?: number;
  store?: ResearchSourceStore;
  ledger?: BudgetLedger;
  onBudget?: () => Promise<void>;
}): ResearchTool {
  const store = input.store || new ResearchSourceStore();
  return {
    name: "search_web",
    description: "按实际检索式调查岗位或相邻背景资料，返回来源与可引用片段。检索结果不扩大图谱改动权限。",
    args: { query: "实际检索式", category: "可选来源类别：official_standard/job_market/work_practice/technology/education/future_signal/user_focus" },
    run: async (args, context) => {
      const query = String(args.query || "").trim();
      if (!query) throw new Error("search_web 需要一条非空检索式");
      const categories = ["official_standard", "job_market", "work_practice", "technology", "education", "future_signal", "user_focus"] as const;
      const category = categories.find(item => item === args.category) || "user_focus";
      const charge = input.ledger?.reserve("general", { queries: 1 });
      if (charge && charge.granted.queries < 1) throw new Error("RESEARCH_BUDGET_EXHAUSTED");
      await input.onBudget?.();
      const planned = [{ id: `agent-query:${context.turn}`, category, query, priority: 1 }];
      const researched = await researchRoleSources({
        request: input.request,
        investigationScope: "background",
        config: input.config,
        queries: planned,
        planStrategy: "deterministic",
        verifyBoundaries: input.verifyBoundaries,
        signal: context.signal,
      });
      const ingested = store.ingest(input.request, researched.sources);
      const excerpts = ingested.slice(0, MAX_EXCERPTS_PER_CALL).map(segment => ({
        segmentId: segment.id, sourceId: segment.sourceId,
        locator: store.assets.find(asset => asset.id === segment.sourceId)?.locator,
        excerpt: segment.text.slice(0, SOURCE_EXCERPT_CHARS),
        truncated: segment.text.length > SOURCE_EXCERPT_CHARS,
        nextOffset: segment.text.length > SOURCE_EXCERPT_CHARS ? SOURCE_EXCERPT_CHARS : null,
      }));
      if (!excerpts.length) {
        return { summary: `“${query}”没有选入任何来源（可能被边界判定淘汰或检索失败）。不要重复同一检索式。` };
      }
      return {
        summary: `“${query}”选入 ${researched.sources.length} 条来源，以下为可引用片段。`,
        data: {
          selectedSourceCount: researched.report?.selectedSourceCount ?? researched.sources.length,
          failures: researched.report?.failures ?? [],
          excerpts,
          sourceIndex: ingested.map(segment => ({ segmentId: segment.id, sourceId: segment.sourceId })),
        },
      };
    },
  };
}

/**
 * Source reading tool. Reads only from segments the caller already holds, so it
 * cannot pull in material the round never retrieved, and it answers by segment
 * id so a claim can cite exactly what was read.
 */
export function createSourceReadTool(input: {
  segments: SourceSegment[];
  assets?: SourceAsset[];
}): ResearchTool {

  return {
    name: "read_source",
    description: "按片段 id 读取本轮已收集的原文片段，或按关键词在其中查找。",
    args: {
      segmentId: "可选：已知的片段 id，精确读取该片段",
      offset: "字符位置，默认 0，使用返回的 nextOffset 继续读取",
      cursor: "关键词匹配列表位置，默认 0",
      query: "可选：在已收集片段中查找的关键词",
      limit: `可选：最多返回多少条（上限 ${MAX_EXCERPTS_PER_CALL}）`,
    },
    run: async (args) => {
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const cursor = Math.max(0, Math.floor(Number(args.cursor) || 0));
      const limit = Math.max(1, Math.min(Number(args.limit) || 3, MAX_EXCERPTS_PER_CALL));
      const segmentId = String(args.segmentId || "").trim();
      if (segmentId) {
        const segment = input.segments.find(item => item.id === segmentId);
        if (!segment) throw new Error(`片段 ${segmentId} 不在本轮已收集的来源中；不要引用未检索到的片段`);
        const asset = input.assets?.find(item => item.id === segment.sourceId);
        return {
          summary: `片段 ${segmentId} 的记录如下；先核对 contentKind，转述与研究笔记不能冒充来源原话。`,
          data: {
            segmentId,
            sourceTitle: asset?.title || "",
            contentKind: segment.excerptType === "close_paraphrase" ? "source_paraphrase" : segment.excerptType === "research_note" ? "research_note" : asset?.extractionMethod === "search_content" ? "search_excerpt" : "source_body",
            excerptType: segment.excerptType,
            locator: asset?.locator || segment.locator || "",
            quote: segment.text.slice(offset, offset + 6000),
            offset, totalCharacters: segment.text.length,
            nextOffset: offset + 6000 < segment.text.length ? offset + 6000 : null,
          },
        };
      }
      const query = String(args.query || "").trim();
      if (!query) throw new Error("read_source 需要 segmentId 或 query 之一");
      const matched = input.segments.filter(segment => segment.text.includes(query)).slice(cursor, cursor + limit);
      if (!matched.length) {
        return { summary: `已收集的片段里没有出现“${query}”。这不代表事实不存在，只代表本轮资料未覆盖。` };
      }
      return {
        summary: `在 ${matched.length} 条已收集片段中命中“${query}”。`,
        data: {
          nextCursor: cursor + limit < input.segments.filter(segment => segment.text.includes(query)).length ? cursor + limit : null,
          matches: matched.map(segment => ({
            segmentId: segment.id,
            sourceTitle: input.assets?.find(item => item.id === segment.sourceId)?.title || "",
            quote: segment.text.slice(0, SOURCE_EXCERPT_CHARS),
            nextOffset: segment.text.length > SOURCE_EXCERPT_CHARS ? SOURCE_EXCERPT_CHARS : null,
          })),
        },
      };
    },
  };
}

export function createSourceIndexTool(input: { assets: SourceAsset[]; segments: SourceSegment[] }): ResearchTool {
  return { name: "list_sources", description: "分页浏览共享资料库的来源索引。使用 nextOffset 继续；再用 read_source 读取原文。", args: { offset: "来源位置", sourceId: "可选：展开一个来源的全部片段索引" }, run: async args => {
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    if (args.sourceId) {
      const segments = input.segments.filter(segment => segment.sourceId === args.sourceId);
      return { summary: "来源片段索引", data: { segments: segments.slice(offset, offset + 30).map(segment => ({ id: segment.id, characters: segment.text.length })), nextOffset: offset + 30 < segments.length ? offset + 30 : null } };
    }
    return { summary: "共享资料库索引", data: { sources: input.assets.slice(offset, offset + 20).map(asset => ({ id: asset.id, title: asset.title, locator: asset.locator, segmentCount: input.segments.filter(segment => segment.sourceId === asset.id).length })), nextOffset: offset + 20 < input.assets.length ? offset + 20 : null } };
  } };
}

/** The tool set a research worker runs with, in a stable order. */
/**
 * Tools that work without any search provider: an agent can still read what the
 * round already retrieved, which is what makes research possible when联网 is
 * disabled but supplemental sources exist.
 */
export function createReadOnlyToolset(input: {
  segments: SourceSegment[];
  assets?: SourceAsset[];
}): ResearchTool[] {
  return [createSourceIndexTool({ assets: input.assets || [], segments: input.segments }), createSourceReadTool(input)];
}

export function createResearchToolset(input: {
  request: ColdStartRequest;
  config: SearchProviderConfig;
  segments: SourceSegment[];
  assets?: SourceAsset[];
  verifyBoundaries?: BoundaryVerifier;
  store?: ResearchSourceStore;
  ledger?: BudgetLedger;
  onBudget?: () => Promise<void>;
}): ResearchTool[] {
  const store = input.store || new ResearchSourceStore(input.assets, input.segments);
  return [
    createSourceIndexTool(store),
    { name: "fetch_source", description: "获取已知来源的正文并立即入库。正文与搜索摘要分别保留；超过获取上限或无法读取时明确返回失败。", args: { sourceId: "资料库中的来源 ID" }, run: async (args, context) => {
      const asset = store.assets.find(asset => asset.id === args.sourceId);
      if (!asset?.locator?.startsWith("https://")) throw new Error("只能获取资料库中具有 HTTPS 地址的已知来源");
      const page = await fetchReadablePage({ title: asset.title, url: asset.locator, content: "" }, context.signal, true);
      if (!page.content) throw new Error("未取得完整可读正文；来源可能不可访问、格式不支持或超过 900 KB 上限，现有摘要不能当作完整正文");
      const parts = [];
      for (let offset = 0; offset < page.content.length; offset += 60_000) parts.push({ title: asset.title, locator: `${asset.locator.split("#")[0]}#atlas-part-${offset}`, content: page.content.slice(offset, offset + 60_000), kind: asset.kind, fetchedAt: new Date().toISOString(), extractionMethod: "direct_fetch" as const, publisher: asset.publisher, publishedAt: asset.publishedAt });
      const segments = store.ingest(input.request, parts);
      await input.onBudget?.();
      return { summary: "正文已入库，可按引用和位置连续读取", data: { contentKind: "body", totalCharacters: page.content.length, segmentIds: segments.map(segment => segment.id), fetchedFrom: asset.locator } };
    } },
    createSearchTool({
      store, ledger: input.ledger, onBudget: input.onBudget,
      request: input.request,
      config: input.config,
      verifyBoundaries: input.verifyBoundaries,
    }),
    createSourceReadTool({ segments: store.segments, assets: store.assets }),
  ];
}
