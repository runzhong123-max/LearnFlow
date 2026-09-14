/** Display-only projection: readiness and publication decisions remain unchanged. */
export const draftHeadline = "岗位草稿已保存 · 可继续完善";

const fields: Record<string, string> = {
  goal: "工作目标", trigger: "任务的启动条件", inputs: "开展工作所需的输入资料",
  actors: "参与人员与职责", activities: "主要工作步骤", deliverables: "交付物",
  qualityCriteria: "交付物的检查标准", exceptions: "异常情况与处理方式",
  knowledge_skills: "任务所需的知识与技能", capabilities: "支撑任务的岗位能力", work_process: "任务对应的工作流程",
};
const checks: Record<string, string> = {
  structural: "岗位结构", semantic: "节点含义与关系", evidence: "来源证据", temporal: "资料时效", process: "工作流程",
};
export function draftGapLabel(raw: string): string {
  const check = /^基础检查未通过：(.+)$/.exec(raw);
  if (check && Object.hasOwn(checks, check[1])) return `${checks[check[1]]}仍有待核查项（此记录未提供具体问题，请查看对应内容或继续完善）`;
  const match = /^(.*): (\w+)(?::(review|evidence))?$/.exec(raw);
  if (!match || !Object.hasOwn(fields, match[2])) return raw;
  const [, task, field, reason] = match;
  return `${task}：${reason === "review" ? "需核实" : reason === "evidence" ? "需补充来源依据：" : "需补充或明确"}${fields[field]}`;
}
export const draftStopLabels: Record<string, string> = {
  insufficient_material: "现有资料尚不足以补齐剩余内容，本轮研究已暂停。",
  budget_exhausted: "本次研究预算已用完，已有成果已保留。",
  no_progress: "最近几轮未检测到剩余问题的实质改善，本轮研究已暂停；已有成果仍保留。",
  cancelled: "本轮研究已停止，已有成果仍保留。",
  failed: "本轮执行遇到错误，已有成果仍保留。",
};
