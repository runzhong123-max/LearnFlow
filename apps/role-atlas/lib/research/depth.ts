/** Research effort changes the questions and cadence, never the delivery criteria. */
export const researchDepths = ["low", "medium", "high", "max"] as const;
export type ResearchDepth = typeof researchDepths[number];
export const depthProfiles = {
  low: { label: "Low · 聚焦", effort: "较少时间与消耗", parallelQuestions: 2, turnsPerBatch: 4, instruction: "围绕用户目标和核心典型任务，优先使用已有可靠材料。补齐完整任务、能力单元、知识技能及连接；只追查阻碍理解和交付的缺口，不扩展外围趋势。" },
  medium: { label: "Medium · 标准", effort: "适中的时间与消耗", parallelQuestions: 3, turnsPerBatch: 6, instruction: "覆盖核心任务及常见工作场景，交叉核对职责边界与关键依据，调查常见异常、交接和学习支撑缺口。" },
  high: { label: "High · 深入", effort: "通常需要更多时间与消耗", parallelQuestions: 4, turnsPerBatch: 8, instruction: "在完整核心内容上，对照不同来源和工作情境，主动寻找反证、边界混淆、遗漏任务和知识技能断链。复核可转换性、学生表达与重要覆盖，按有价值的缺口续研。" },
  max: { label: "Max · 充分", effort: "通常耗时最长、消耗最多", parallelQuestions: 4, turnsPerBatch: 12, instruction: "充分追踪有依据的研究分支，对照相邻岗位、不同企业情境和时间变化，主动核查反例与少见但高影响的异常。反复修订薄弱内容；没有新问题或有效进展时结束，不为凑篇幅、次数或用量继续。" },
} satisfies Record<ResearchDepth, { label: string; effort: string; parallelQuestions: number; turnsPerBatch: number; instruction: string }>;
export function normalizeResearchDepth(value?: unknown): ResearchDepth {
  return value === "focused" ? "low" : researchDepths.includes(value as ResearchDepth) ? value as ResearchDepth : "high";
}
export function researchDepthContext(depth?: ResearchDepth) {
  const value = normalizeResearchDepth(depth);
  return { depth: value, instruction: depthProfiles[value].instruction, completion: "所有深度均需完整任务接口、能力与能力单元、知识技能及有效连接。依据不足必须保留缺口。深度不扩大改动权限，实际用量与时间不是完成指标。" };
}
