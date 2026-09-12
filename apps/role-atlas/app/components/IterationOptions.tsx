"use client";
import { useId } from "react";
import { iterationModeOptions, iterationProfileOptions, parseIterationTargets, type IterationDraft, type IterationRunBrief } from "@/lib/iteration/brief";

export function IterationBrief({ brief }: { brief: IterationRunBrief }) {
  return <details className="iteration-run-brief"><summary>本轮配置 · {iterationModeOptions.find((item) => item.id === brief.mode)?.label || "自动判定"} · {iterationProfileOptions.find((item) => item.id === brief.initiativeProfile)?.label}</summary>
    <p>{brief.prompt || "未限定文字目标"}</p>
    <p>节点：{brief.targetIds.length ? brief.targetIds.join("、") : "未指定"}</p>
    <p>目标时点：{brief.targetAsOf || (brief.mode === "freshness" ? "执行当日" : "沿用当前快照")}</p>
    <p>{brief.webResearch ? "联网研究" : "不联网"} · 附加资料 {brief.sourceCount} 份 · {brief.learningPathProvided ? "重建时对齐学习路径" : "未附学习路径"}</p>
  </details>;
}

export default function IterationOptions({ value, onChange, disabled, nodes = [], selectedNodeIds = [] }: {
  value: IterationDraft; onChange: (value: IterationDraft) => void; disabled: boolean;
  nodes?: Array<{ id: string; label: string }>; selectedNodeIds?: string[];
}) {
  const targets = parseIterationTargets(value.targetIds);
  const groupId = useId();
  return <div className="iteration-options">
    <fieldset disabled={disabled}><legend>常见改进目标</legend><div className="iteration-option-grid">
      {iterationModeOptions.map(option => <label key={option.id} className={value.mode === option.id ? "chosen" : ""}><input type="radio" name={`${groupId}-goal`} checked={value.mode === option.id} onChange={() => onChange({ ...value, mode: option.id })} /><b>{option.label}</b></label>)}
    </div></fieldset>
    <label>改动范围<select disabled={disabled} value={value.initiativeProfile === "user_directed" || targets.length ? "selected" : "role"} onChange={event => onChange({ ...value, initiativeProfile: event.target.value === "selected" ? "user_directed" : "autonomous", ...(event.target.value === "role" ? { targetIds: "" } : {}) })}><option value="role">围绕目标检查整个岗位</option><option value="selected">仅改动选中对象及其支撑内容</option></select></label>
    <label>研究深度<select disabled={disabled} value={value.depth || "deep"} onChange={event => onChange({ ...value, depth: event.target.value as "focused" | "deep" })}><option value="deep">深入调查与反复完善</option><option value="focused">集中解决本次问题</option></select></label>
    <label>采用方式<select disabled={disabled} value={value.adoption || "automatic"} onChange={event => onChange({ ...value, adoption: event.target.value as "automatic" | "review" })}><option value="automatic">检查通过后自动采用，可回退</option><option value="review">先查看差异，再决定采用</option></select></label>
    <details className="iteration-scope" open={targets.length > 0 || undefined}><summary>研究节点 · {targets.length ? `已选 ${targets.length} 个` : "未限定"}</summary>
      <label>从当前图谱添加节点<select aria-label="添加研究节点" value="" disabled={disabled} onChange={(event) => { if (event.target.value) onChange({ ...value, targetIds: [...new Set([...targets, event.target.value])].join(", ") }); }}><option value="">选择节点…</option>{nodes.filter((node) => !targets.includes(node.id)).map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>
      <div className="iteration-targets">{targets.map((id) => <button type="button" key={id} disabled={disabled} title={id} aria-label={`移除研究节点 ${nodes.find((node) => node.id === id)?.label || id}`} onClick={() => onChange({ ...value, targetIds: targets.filter((target) => target !== id).join(", ") })}>{nodes.find((node) => node.id === id)?.label || id} ×</button>)}</div>
      <button type="button" className="iteration-use-selection" disabled={disabled || !selectedNodeIds.length} onClick={() => onChange({ ...value, targetIds: [...new Set([...targets, ...selectedNodeIds])].join(", ") })}>加入当前选中节点</button>
      <label>粘贴节点 ID（可选）<textarea aria-label="限定节点 ID" value={value.targetIds} disabled={disabled} onChange={(event) => onChange({ ...value, targetIds: event.target.value })} placeholder="支持空格、逗号或换行分隔" /></label>
      <small>调查可以读取关联背景；改动限于选中对象及其必要支撑，不会自动更改其他任务。</small>
    </details>
    <label>更新到目标时点（可选）<input type="date" aria-label="更新到目标时点" value={value.targetAsOf} disabled={disabled} onChange={(event) => onChange({ ...value, targetAsOf: event.target.value })} /><small>{value.mode === "freshness" ? "留空时核对到执行当日；没有证据增量时保留原快照。" : "留空沿用当前快照时点；指定日期会参与证据时效检查。"}</small></label>
  </div>;
}
