/** Versioned, deterministic discovery taxonomy; never a publication or mastery decision. */
export const HUB_TAXONOMY_VERSION = "1.0.0";
export const HUB_TAXONOMY = [
  { id: "software", label: "软件与互联网", terms: ["软件", "前端", "后端", "全栈", "测试工程", "运维", "云平台", "software", "frontend", "backend", "devops", "qa engineer"] },
  { id: "ai-data", label: "人工智能与数据", terms: ["人工智能", "大模型", "机器学习", "算法", "数据", "llm", "ai engineer", "data", "machine learning"] },
  { id: "product-design", label: "产品与设计", terms: ["产品经理", "设计", "用户体验", "product manager", "designer", "ux", "ui"] },
  { id: "business", label: "运营与商业", terms: ["运营", "营销", "销售", "电商", "商务", "市场", "marketing", "sales", "operations"] },
  { id: "finance", label: "金融与财务", terms: ["金融", "财务", "会计", "审计", "银行", "证券", "保险", "finance", "accountant"] },
  { id: "manufacturing", label: "制造与工程", terms: ["机械", "制造", "自动化", "电气", "电子", "硬件", "汽车", "机器人", "manufacturing", "mechanical"] },
  { id: "health", label: "医疗与健康", terms: ["医疗", "医生", "护理", "护士", "药", "健康", "medical", "nurse"] },
  { id: "education", label: "教育与科研", terms: ["教师", "教育", "教学", "科研", "研究员", "teacher", "researcher"] },
  { id: "media", label: "文化与传媒", terms: ["传媒", "编辑", "记者", "影视", "艺术", "出版", "文案", "journalist", "editor"] },
  { id: "legal-admin", label: "法律与组织管理", terms: ["法律", "律师", "法务", "人力", "行政", "招聘", "公共管理", "lawyer", "human resources"] },
  { id: "construction", label: "建筑与环境", terms: ["建筑", "土木", "规划", "环境", "能源", "环保", "construction", "civil engineer"] },
  { id: "services", label: "生活服务与物流", terms: ["物流", "供应链", "采购", "运输", "餐饮", "旅游", "酒店", "农业", "农艺", "logistics", "hospitality"] },
  { id: "other", label: "其他／待归类", terms: [] },
] as const;

function matches(text: string, term: string) {
  const normalized = text.normalize("NFKC").toLowerCase();
  return /^[a-z ]+$/.test(term)
    ? new RegExp(`\\b${term.replace(/ /g, "\\s+")}\\b`, "u").test(normalized)
    : normalized.includes(term);
}

export function classifyHubEntry(input: { title: string; summary?: string; aliases?: string[]; categories?: string[] }): string[] {
  const explicit = [...new Set((input.categories || []).map(value => value.trim()).filter(Boolean))];
  const identity = [input.title, ...(input.aliases || [])].join(" ");
  const infer = (text: string) => HUB_TAXONOMY.filter(category => category.terms.some(term => matches(text, term))).map(category => category.label);
  // Identity wins over incidental tools or skills mentioned in a description.
  const primary = infer(identity);
  const inferred = primary.length ? primary : infer(input.summary || "");
  const mapped = infer(explicit.join(" "));
  const result = [...new Set([...explicit, ...mapped, ...inferred])];
  return result.length ? result : ["其他／待归类"];
}
