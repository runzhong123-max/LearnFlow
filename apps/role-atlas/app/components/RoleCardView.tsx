"use client";

import {
  BookOpenCheck,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Layers3,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useRef } from "react";

export type RoleCardNode = {
  id: string;
  type: string;
  label: string;
  summary: string;
  ring: number;
  lifecycle: "accepted" | "candidate" | "deprecated";
  assertion_refs: string[];
  evidence_summary: {
    binding_refs: string[];
    source_refs: string[];
    max_confidence: number;
    has_segment_evidence: boolean;
    temporal_status_counts: Record<string, number>;
  };
  data: Record<string, unknown>;
  packageId?: string;
  packageVersion?: string;
  snapshotId?: string;
  granularity?: "kernel" | "detail";
  defaultVisibility?: boolean;
  parentKernelId?: string;
  facets?: Array<{ label: string; nodeId?: string; summary?: string }>;
};

type RoleCardEdge = {
  source: string;
  target: string;
};

type CardDimension = {
  id: string;
  label: string;
  description: string;
  types: string[];
};

type Props = {
  nodes: RoleCardNode[];
  edges: RoleCardEdge[];
  selectedId: string;
  onSelect: (node: RoleCardNode) => void;
  onExploreTask?: (node: RoleCardNode) => void;
  onReference: (node: RoleCardNode) => void;
  onDragStart: (node: RoleCardNode) => void;
  onDragEnd: () => void;
};

const dimensions: CardDimension[] = [
  {
    id: "position",
    label: "产业与岗位位置",
    description: "产业链、岗位群、具体岗位与相邻岗位",
    types: ["industry_chain_node", "job_family", "occupation_standard", "market_role", "related_role"],
  },
  {
    id: "task",
    label: "典型工作任务",
    description: "能形成独立交付物、可观察工作结果的任务",
    types: ["task"],
  },
  {
    id: "capability",
    label: "岗位能力",
    description: "能够跨任务迁移的综合能力",
    types: ["capability"],
  },
  {
    id: "capability-unit",
    label: "能力单元",
    description: "可训练、可观察、可评价的能力组成",
    types: ["capability_unit"],
  },
  {
    id: "knowledge-skill",
    label: "知识点与技能点",
    description: "支撑任务完成与能力形成的学习对象",
    types: ["knowledge_skill"],
  },
];

const typeLabels: Record<string, string> = {
  market_role: "岗位",
  industry_chain_node: "产业链",
  job_family: "岗位群",
  occupation_standard: "职业标准",
  related_role: "关联岗位",
  task: "典型任务",
  capability: "岗位能力",
  capability_unit: "能力单元",
  knowledge_skill: "知识技能",
};

function formatValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.filter((item) => ["string", "number", "boolean"].includes(typeof item)).slice(0, 5).join("、");
  return "";
}

function CardDimensionRow({
  dimension,
  nodes,
  relationCounts,
  selectedId,
  onSelect,
  onExploreTask,
  onReference,
  onDragStart,
  onDragEnd,
}: Props & { dimension: CardDimension; relationCounts: Map<string, number> }) {
  const laneRef = useRef<HTMLDivElement | null>(null);

  function moveLane(direction: -1 | 1) {
    laneRef.current?.scrollBy({ left: direction * Math.max(240, laneRef.current.clientWidth * 0.72), behavior: "smooth" });
  }

  return (
    <section className="role-card-dimension" aria-labelledby={`card-dimension-${dimension.id}`}>
      <header>
        <div>
          <span><Layers3 size={12} /> 维度 {String(dimensions.findIndex((item) => item.id === dimension.id) + 1).padStart(2, "0")}</span>
          <h2 id={`card-dimension-${dimension.id}`}>{dimension.label}</h2>
          <p>{dimension.description}</p>
        </div>
        <div className="role-card-row-actions">
          <b>{nodes.length} 张卡片</b>
          <button onClick={() => moveLane(-1)} aria-label={`向左浏览${dimension.label}`}><ChevronLeft size={14} /></button>
          <button onClick={() => moveLane(1)} aria-label={`向右浏览${dimension.label}`}><ChevronRight size={14} /></button>
        </div>
      </header>

      <div className="role-card-lane" ref={laneRef}>
        {nodes.map((node) => {
          const selected = selectedId === node.id;
          const detailRows = Object.entries(node.data)
            .map(([key, value]) => [key, formatValue(value)] as const)
            .filter(([, value]) => value)
            .slice(0, 3);
          return (
            <article
              className={`role-summary-card ${node.type} ${node.lifecycle} ${selected ? "selected" : ""}`}
              draggable
              key={node.id}
              onDragStart={() => onDragStart(node)}
              onDragEnd={onDragEnd}
            >
              <button className="role-card-select" onClick={() => onSelect(node)} aria-pressed={selected}>
                <span className="role-card-type">{typeLabels[node.type] || node.type}<i>{node.lifecycle === "accepted" ? "已接受" : node.lifecycle === "deprecated" ? "已废弃" : "待审"}</i></span>
                <h3>{node.label}</h3>
                <p>{node.summary}</p>
                <div className="role-card-metrics">
                  <span><ShieldCheck size={11} /><b>{node.evidence_summary.max_confidence.toFixed(2)}</b><small>置信</small></span>
                  <span><BookOpenCheck size={11} /><b>{node.evidence_summary.source_refs.length}</b><small>来源</small></span>
                  <span><GitBranch size={11} /><b>{relationCounts.get(node.id) || 0}</b><small>关系</small></span>
                </div>
                {selected && (detailRows.length > 0 || (node.facets?.length || 0) > 0) ? (
                  <div className="role-card-expanded">
                    {detailRows.map(([key, value]) => <span key={key}><b>{key.replaceAll("_", " ")}</b><small>{value}</small></span>)}
                    {(Array.isArray(node.data.courseMemberIds) ? node.facets : node.facets?.slice(0, 3))?.map((facet, index) => <span key={`${facet.nodeId || facet.label}:${index}`}><b>{Array.isArray(node.data.courseMemberIds) ? "岗位应用" : "侧面"}</b><small>{facet.label}</small></span>)}
                  </div>
                ) : null}
              </button>
              <footer>
                {node.type === "task" && onExploreTask
                  ? <button className="role-card-explore" onClick={() => onExploreTask(node)}><GitBranch size={11} /> 展开任务</button>
                  : <span>{node.granularity === "detail" ? "细节节点" : "核心节点"}</span>}
                <button onClick={() => onReference(node)}><Plus size={11} /> 引用到对话</button>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default function RoleCardView(props: Props) {
  const grouped = useMemo(() => {
    const assignedTypes = new Set(dimensions.flatMap((dimension) => dimension.types));
    const rows = dimensions
      .map((dimension) => ({ dimension, nodes: props.nodes.filter((node) => dimension.types.includes(node.type)) }))
      .filter((row) => row.nodes.length > 0);
    const otherNodes = props.nodes.filter((node) => !assignedTypes.has(node.type));
    if (otherNodes.length > 0) {
      rows.push({
        dimension: { id: "other", label: "其他语义对象", description: "尚未归入核心维度的岗位对象", types: [] },
        nodes: otherNodes,
      });
    }
    return rows;
  }, [props.nodes]);

  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of props.edges) {
      counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
    }
    return counts;
  }, [props.edges]);

  if (grouped.length === 0) return <div className="role-card-empty">没有匹配当前条件的岗位卡片。</div>;

  return (
    <div className="role-card-view">
      <header className="role-card-view-intro">
        <div><span>ROLE CARDS</span><h2>岗位卡片总览</h2></div>
        <p>上下浏览语义维度，左右浏览同维度节点。选择卡片可展开细节，拖动或点击可引用到对话。</p>
      </header>
      {grouped.map(({ dimension, nodes }) => (
        <CardDimensionRow
          {...props}
          dimension={dimension}
          nodes={nodes}
          relationCounts={relationCounts}
          key={dimension.id}
        />
      ))}
    </div>
  );
}
