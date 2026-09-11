import type { ColdStartRequest, SourceAsset, SourceSegment } from "@/lib/build/types";
import type { BoundaryVerifier } from "@/lib/search/boundary-verdicts";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { researchRoleSources } from "@/lib/search/web-research";
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
}): ResearchTool {
  const maxQueries = Math.max(1, Math.min(input.maxQueriesPerCall || MAX_QUERIES_PER_SEARCH_CALL, 8));
  return {
    name: "search_web",
    description: "按一条检索式查找岗位资料，返回入选来源的标题与可引用片段。",
    args: { query: "一条检索式；一次只查一条，避免同一轮塞入多个方向" },
    run: async (args, context) => {
      const query = String(args.query || "").trim();
      if (!query) throw new Error("search_web 需要一条非空检索式");
      // 类别由代码给定：agent 只决定“问什么”，不决定“按哪一类证据计费”。
      const planned = Array.from({ length: maxQueries }, (_, index) => ({
        id: `agent-query:${index}`,
        category: "technology" as const,
        query,
        priority: index + 1,
      }));
      const researched = await researchRoleSources({
        request: input.request,
        config: input.config,
        queries: planned.slice(0, maxQueries),
        planStrategy: "deterministic",
        verifyBoundaries: input.verifyBoundaries,
        signal: context.signal,
      });
      const excerpts = researched.sources.slice(0, MAX_EXCERPTS_PER_CALL).map(source => ({
        locator: source.locator,
        title: source.title,
        // 片段 id 由确定性摄取分配；agent 只能用这里给出的 id 引用原文。
        excerpt: clampText(String(source.content || ""), SOURCE_EXCERPT_CHARS),
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
  const byId = new Map(input.segments.map(segment => [segment.id, segment]));
  const assetById = new Map((input.assets || []).map(asset => [asset.id, asset]));
  return {
    name: "read_source",
    description: "按片段 id 读取本轮已收集的原文片段，或按关键词在其中查找。",
    args: {
      segmentId: "可选：已知的片段 id，精确读取该片段",
      query: "可选：在已收集片段中查找的关键词",
      limit: `可选：最多返回多少条（上限 ${MAX_EXCERPTS_PER_CALL}）`,
    },
    run: async (args) => {
      const limit = Math.max(1, Math.min(Number(args.limit) || 3, MAX_EXCERPTS_PER_CALL));
      const segmentId = String(args.segmentId || "").trim();
      if (segmentId) {
        const segment = byId.get(segmentId);
        if (!segment) throw new Error(`片段 ${segmentId} 不在本轮已收集的来源中；不要引用未检索到的片段`);
        const asset = assetById.get(segment.sourceId);
        return {
          summary: `片段 ${segmentId} 的原文如下。`,
          data: {
            segmentId,
            sourceTitle: asset?.title || "",
            locator: asset?.locator || segment.locator || "",
            quote: clampText(segment.text, SOURCE_EXCERPT_CHARS * 2),
          },
        };
      }
      const query = String(args.query || "").trim();
      if (!query) throw new Error("read_source 需要 segmentId 或 query 之一");
      const matched = input.segments.filter(segment => segment.text.includes(query)).slice(0, limit);
      if (!matched.length) {
        return { summary: `已收集的片段里没有出现“${query}”。这不代表事实不存在，只代表本轮资料未覆盖。` };
      }
      return {
        summary: `在 ${matched.length} 条已收集片段中命中“${query}”。`,
        data: {
          matches: matched.map(segment => ({
            segmentId: segment.id,
            sourceTitle: assetById.get(segment.sourceId)?.title || "",
            quote: clampText(segment.text, SOURCE_EXCERPT_CHARS),
          })),
        },
      };
    },
  };
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
  return [createSourceReadTool(input)];
}

export function createResearchToolset(input: {
  request: ColdStartRequest;
  config: SearchProviderConfig;
  segments: SourceSegment[];
  assets?: SourceAsset[];
  verifyBoundaries?: BoundaryVerifier;
}): ResearchTool[] {
  return [
    createSearchTool({
      request: input.request,
      config: input.config,
      verifyBoundaries: input.verifyBoundaries,
    }),
    createSourceReadTool({ segments: input.segments, assets: input.assets }),
  ];
}
