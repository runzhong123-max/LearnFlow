import { z } from "zod/v4";

export const SEARCH_PROVIDER_SESSION_KEY = "role-atlas.search-provider-config.v1";
export const searchProviderIds = ["glm", "exa", "tavily", "bocha"] as const;
export type SearchProviderId = (typeof searchProviderIds)[number];

export type SearchProviderDefinition = {
  id: SearchProviderId;
  name: string;
  description: string;
  docsUrl: string;
  keyPlaceholder: string;
};

export const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProviderDefinition> = {
  glm: {
    id: "glm",
    name: "智谱 GLM 搜索",
    description: "智谱 Web Search API，默认使用高阶搜索，返回可追溯链接、摘要和发布时间。",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/tools/web-search",
    keyPlaceholder: "智谱开放平台 API Key",
  },
  exa: {
    id: "exa",
    name: "Exa",
    description: "语义检索与正文提取能力较强，适合技术资料、论文和官方文档。",
    docsUrl: "https://docs.exa.ai/reference/search",
    keyPlaceholder: "exa-...",
  },
  tavily: {
    id: "tavily",
    name: "Tavily",
    description: "高级搜索后对入选 URL 定向抽取，支持请求追踪、来源过滤与用量审计。",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    keyPlaceholder: "tvly-...",
  },
  bocha: {
    id: "bocha",
    name: "博查 AI 搜索",
    description: "中文网页覆盖较好，适合国内岗位、政策、招聘和产业资料。",
    docsUrl: "https://open.bochaai.com/",
    keyPlaceholder: "sk-...",
  },
};

export const searchProviderConfigSchema = z.object({
  provider: z.enum(searchProviderIds),
  apiKey: z.string().min(8).max(512),
  engine: z.enum(["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"]).optional(),
});

export type SearchProviderConfig = z.infer<typeof searchProviderConfigSchema>;

export function defaultSearchProviderConfig(): SearchProviderConfig {
  return { provider: "glm", apiKey: "" };
}
