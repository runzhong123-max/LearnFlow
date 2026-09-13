import type { ColdStartBuildResult } from "@/lib/build/types";
const reviewLabels = { supported: "研究推断 · 复核支持", partially_supported: "候选学习建议 · 部分支持", conflicting: "候选学习建议 · 存在冲突", undetermined: "候选学习建议 · 尚无法判断" };
export default function LearningSupportDetail({ result, nodeIds }: { result?: ColdStartBuildResult; nodeIds: string[] }) {
  if (!result) return null;
  const selected = new Set(nodeIds);
  const claims = result.semantic.claims.filter(claim => claim.status !== "rejected" && ["requires_skill", "requires_knowledge"].includes(claim.predicate) && claim.assertionType === "research_inference" && (selected.has(claim.subjectId) || selected.has(claim.objectId || "")));
  if (!claims.length) return null;
  const label = (id: string) => result.semantic.nodes.find(node => node.id === id)?.label || id;
  return <details className="node-technical"><summary>学习支撑建议 · {claims.length} 条</summary><p>这些关系用于组织学习；候选建议与企业已证实的工作要求分别记录。</p>{claims.map(claim => <article key={claim.id}><p>{label(claim.subjectId)} ← {label(claim.objectId || "")}</p><small>{claim.reviewStatus ? reviewLabels[claim.reviewStatus] : "候选学习建议 · 未记录复核"}</small>{claim.limitations?.map((note, index) => <p key={index}>{note}</p>)}</article>)}</details>;
}
