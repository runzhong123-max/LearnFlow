/** Computer-specialty job directions. Discovery only; never publication or mastery. */
export const HUB_TAXONOMY_VERSION = "2.0.0";
export const HUB_TAXONOMY = [
  { id: "software", label: "软件开发", terms: ["软件开发", "软件工程", "前端", "后端", "全栈", "移动应用", "应用开发", "游戏开发", "程序员", "web开发", "java", "python", "frontend", "front-end", "backend", "back-end", "full stack", "software developer", "software engineer"] },
  { id: "testing", label: "软件测试", terms: ["软件测试", "测试工程", "测试开发", "质量保障", "质量保证", "自动化测试", "qa", "sdet", "software tester", "test engineer"] },
  { id: "network", label: "网络与运维", terms: ["网络工程", "网络运维", "网络管理", "系统运维", "运维工程", "系统管理", "linux", "network engineer", "network administrator", "system administrator"] },
  { id: "cloud", label: "云计算", terms: ["云计算", "云维护", "云运维", "云平台", "云原生", "云架构", "容器平台", "devops", "sre", "cloud", "kubernetes"] },
  { id: "security", label: "网络安全", terms: ["网络安全", "信息安全", "数据安全", "安全运维", "安全工程", "渗透测试", "安全运营", "cybersecurity", "security engineer", "penetration tester"] },
  { id: "data", label: "数据技术", terms: ["大数据", "数据分析", "数据开发", "数据工程", "数据治理", "数据库", "数据仓库", "商业智能", "data engineer", "data analyst", "data scientist", "dba", "bi engineer"] },
  { id: "ai", label: "人工智能", terms: ["人工智能", "大模型", "机器学习", "深度学习", "算法工程", "计算机视觉", "自然语言处理", "智能体", "agent", "llm", "ai", "machine learning", "mlops"] },
  { id: "iot", label: "物联网与嵌入式", terms: ["物联网", "嵌入式", "单片机", "固件", "智能硬件", "iot", "embedded", "firmware"] },
  { id: "digital-media", label: "数字媒体与交互设计", terms: ["数字媒体", "交互设计", "界面设计", "用户体验设计", "游戏美术", "技术美术", "三维建模", "ui设计", "ux设计", "ui designer", "ux designer", "technical artist"] },
  { id: "it-support", label: "IT技术支持", terms: ["技术支持", "桌面运维", "桌面支持", "信息系统实施", "软件实施", "系统集成", "it support", "help desk", "helpdesk"] },
  { id: "other", label: "待归类", terms: [] },
] as const;

function matches(text: string, term: string) {
  const normalized = text.normalize("NFKC").toLowerCase();
  return /^[a-z0-9 -]+$/.test(term)
    ? new RegExp(`\\b${term.replace(/ /g, "\\s+")}\\b`, "u").test(normalized)
    : normalized.includes(term);
}

function infer(text: string): string[] {
  let found = HUB_TAXONOMY.filter(category => category.terms.some(term => matches(text, term)));
  // A specialized engineering role is not automatically generic software or network work.
  if (found.some(category => !["software", "network"].includes(category.id))) {
    found = found.filter(category => !["software", "network"].includes(category.id));
  }
  return found.map(category => category.label);
}

export function classifyHubEntry(input: { title: string; summary?: string; aliases?: string[]; categories?: string[] }): string[] {
  const title = infer(input.title);
  if (title.length) return title;
  const aliases = infer((input.aliases || []).join(" "));
  if (aliases.length) return aliases;
  // Only canonical directions may be supplied explicitly. Old industry tags remain
  // source metadata, not extra navigation categories. Do not infer from prose such as
  // “不拼算法”, “负责设计系统”, or descriptions of neighboring roles.
  const explicit = HUB_TAXONOMY.filter(category => category.id !== "other" && input.categories?.includes(category.label));
  return explicit.length ? explicit.map(category => category.label) : ["待归类"];
}
