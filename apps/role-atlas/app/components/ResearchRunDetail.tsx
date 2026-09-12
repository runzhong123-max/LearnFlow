import type { ResearchRun } from "@/lib/research/protocol";
import { researchViews } from "@/lib/research/views";
const stopLabels = { goal_reached: "目标已达到", insufficient_material: "资料不足", no_progress: "连续没有有效进展", budget_exhausted: "预算耗尽", cancelled: "用户取消", failed: "执行失败" };
const taskLabels = { queued: "待调查", running: "调查中", completed: "已完成", known_gap: "仍有缺口", failed: "执行失败" };
const changeLabels = { candidate: "候选", needs_review: "待审阅", adopted: "已采用", rejected: "未通过" };
const operationLabels = { add: "新增", revise: "修订", attach_evidence: "补充依据", split: "拆分", merge: "合并", replace: "替代", deprecate: "废弃" };
export default function ResearchRunDetail({ run }: { run?: ResearchRun }) {
  if (!run) return null;
  const views = researchViews(run);
  return <section aria-label="研究记录"><h3>研究记录</h3><p>{run.stopReason ? stopLabels[run.stopReason] : "研究进行中"} · {run.agenda.tasks.length} 个问题 · {run.agenda.revision} 次议程修订</p>
    {run.budget && <p>已记账 token：{run.budget.spent.tokens + run.budget.reserveSpent.tokens} · 搜索查询：{run.budget.spent.queries}</p>}
    <details><summary>议程与未解决事项</summary><ul>{run.agenda.tasks.map(task => <li key={task.id}>{task.question} · {taskLabels[task.status]}</li>)}</ul><ul>{run.agenda.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details>
    <details><summary>风险与后续调查 · {views.risks.length} 项</summary><p>{views.policy}</p>{views.radar.map(item => {
      const risk = views.risks.find(risk => risk.findingId === item.findingId)!;
      return <article key={item.findingId}><b>{risk.axis === "temporal" ? "时间变化" : "关系一致性"} · {item.question}</b><p>{item.expectedValue}</p><small>{risk.missingConcept ? `尚无对应对象：${risk.missingConcept}` : risk.affectedIds.join("、")}</small></article>;
    })}</details>
    <details><summary>改动与采用检查 · {run.changeSets.length} 组</summary>{run.changeSets.map(change => <article key={change.id}><b>{change.motivation} · {changeLabels[change.status]}</b><p>固定基线：{change.baseSnapshotId}</p><ul>{change.operations.map((operation, index) => <li key={index}>{operationLabels[operation.kind]} · {operation.targetId}{operation.replacementIds?.length ? ` → ${operation.replacementIds.join("、")}` : ""}</li>)}</ul><ul>{change.checks.map((check, index) => <li key={index}>{check.passed ? "通过" : "待处理"} · {check.reason}</li>)}</ul></article>)}</details>
  </section>;
}
