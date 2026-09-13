import { taskDefinitionSchema } from "@/lib/research/task-schema";
const labels = { goal: "工作目标", trigger: "触发条件", inputs: "工作输入", actors: "责任与协作", activities: "关键活动", deliverables: "交付物", qualityCriteria: "质量要求", exceptions: "常见异常" } as const;
const basisLabels = { public_material: "公开材料", synthesis: "研究综合", downstream_required: "需补充企业材料", unknown: "尚不明确" };
const reviewLabels = { supported: "复核支持", partially_supported: "部分支持", conflicting: "存在冲突", undetermined: "尚无法判断" };
export default function TaskDefinitionDetail({ value }: { value: unknown }) {
  const parsed = taskDefinitionSchema.safeParse(value);
  if (!parsed.success) return <p className="node-technical">此版本未提供结构化任务详情，可通过迭代补齐；已有内容保持原样。</p>;
  const definition = parsed.data;
  return <section aria-label="典型任务详情"><h3>任务详情</h3><dl>{Object.entries(labels).map(([key, label]) => {
    const field = definition[key as keyof typeof labels];
    return <div key={key}><dt><b>{label}</b> · <small>{basisLabels[field.basis]}</small></dt><dd>{field.text || "待调查"}
      <details><summary>研究依据 · {field.review ? reviewLabels[field.review.status] : "未复核"}</summary>
        <p>{field.review?.reason || "尚未记录复核意见"}</p>
        {field.evidence.map((span, index) => <blockquote key={`${span.segmentId}:${index}`}>{span.quote}<small>来源片段：{span.segmentId}</small></blockquote>)}
      </details></dd></div>;
  })}</dl>{definition.downstreamNeeds.length > 0 && <><h4>下游需补充</h4><ul>{definition.downstreamNeeds.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</section>;
}
