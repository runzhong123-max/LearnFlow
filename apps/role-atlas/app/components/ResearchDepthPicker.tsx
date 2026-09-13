"use client";
import "./research-depth.css";
import { depthProfiles, researchDepths, type ResearchDepth } from "@/lib/research/depth";
export default function ResearchDepthPicker({ value, onChange, disabled }: { value: ResearchDepth; onChange: (value: ResearchDepth) => void; disabled?: boolean }) {
  return <label className="research-depth-picker">研究深度<select aria-label="研究深度" value={value} disabled={disabled} onChange={event => onChange(event.target.value as ResearchDepth)}>{researchDepths.map(depth => <option value={depth} key={depth}>{depthProfiles[depth].label}</option>)}</select><small>{{ low: "先完成核心内容，集中解决关键缺口。", medium: "核对常见场景、职责边界与关键依据。", high: "深入检查反证、遗漏与知识技能连接。", max: "充分比较不同情境，追查重要异常和薄弱内容。" }[value]}</small><small>{depthProfiles[value].effort}；实际取决于资料与缺口。四档都要求完整连接，研究中可停止并保留成果。</small></label>;
}
