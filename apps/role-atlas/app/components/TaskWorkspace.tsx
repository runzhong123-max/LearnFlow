"use client";

import {
  BookOpenCheck,
  Network,
  Plus,
  Route,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { RoleCardNode } from "@/app/components/RoleCardView";
import WorkProcessForestView, { type WorkProcessPayload } from "@/app/components/WorkProcessForestView";

export type TaskPerspective = "relations" | "process";

export type TaskEdge = {
  id?: string;
  type: string;
  source: string;
  target: string;
  lifecycle?: "accepted" | "candidate" | "deprecated";
};

export type TaskViewBundle = {
  task: RoleCardNode;
  nodes: RoleCardNode[];
  edges: TaskEdge[];
  capabilities: RoleCardNode[];
  capabilityUnits: RoleCardNode[];
  knowledgeSkills: RoleCardNode[];
};

type Props = {
  nodes: RoleCardNode[];
  edges: TaskEdge[];
  workProcess?: WorkProcessPayload | null;
  taskId: string;
  query: string;
  selectedId: string;
  perspective: TaskPerspective;
  onTaskChange: (task: RoleCardNode) => void;
  onPerspectiveChange: (perspective: TaskPerspective) => void;
  onSelect: (node: RoleCardNode) => void;
  onReference: (node: RoleCardNode) => void;
  onDragStart: (node: RoleCardNode) => void;
  onDragEnd: () => void;
  onOpenEvidence: (nodes: RoleCardNode[]) => void;
  onConvert?: (task: RoleCardNode) => void;
  converting?: boolean;
  conversionHint?: string;
};

const includedTypes = new Set(["task", "capability", "capability_unit", "knowledge_skill"]);
const relationLabels: Record<string, string> = {
  requires_capability: "需要能力",
  demonstrated_in: "在任务中表现",
  has_unit: "包含能力单元",
  requires_knowledge: "需要知识技能",
  prerequisite_of: "前置于",
};

/* The radar reuses the semantic graph's LearnFlow categories, so a node keeps
   one colour whichever view you meet it in. */
const nodeColors: Record<string, { fill: string; stroke: string; text: string }> = {
  task: { fill: "#fff5dc", stroke: "#d4a743", text: "#8c6514" },
  capability: { fill: "#f1eefe", stroke: "#64529b", text: "#4d3f78" },
  capability_unit: { fill: "#f6f3fe", stroke: "#8570c4", text: "#5c4b8f" },
  knowledge_skill: { fill: "#e7f3eb", stroke: "#087a53", text: "#176947" },
};

function compareNodes(a: RoleCardNode, b: RoleCardNode) {
  return a.label.localeCompare(b.label, "zh-CN");
}

/**
 * Produces the task-centred projection consumed by both the radar view and the
 * process view. It deliberately keeps the immutable package IDs instead of
 * creating task-specific copies of semantic objects.
 */
export function buildTaskViewBundle(nodes: RoleCardNode[], edges: TaskEdge[], taskId: string): TaskViewBundle | null {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const task = nodeMap.get(taskId);
  if (!task || task.type !== "task") return null;

  const includedIds = new Set<string>([task.id]);
  const directEdges = edges.filter((edge) => edge.source === task.id || edge.target === task.id);
  for (const edge of directEdges) {
    const neighbourId = edge.source === task.id ? edge.target : edge.source;
    const neighbour = nodeMap.get(neighbourId);
    if (neighbour && includedTypes.has(neighbour.type)) includedIds.add(neighbour.id);
  }

  // A task can point to a capability while its observable units point back to
  // the task. Include both paths so the task radar remains complete regardless
  // of which legal relation form a package producer used.
  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    if (edge.type === "has_unit" && (includedIds.has(source.id) || includedIds.has(target.id))) {
      if (source.type === "capability" || source.type === "capability_unit") includedIds.add(source.id);
      if (target.type === "capability" || target.type === "capability_unit") includedIds.add(target.id);
    }
  }

  const relatedNodes = nodes.filter((node) => includedIds.has(node.id));
  const relatedEdges = edges.filter((edge) => includedIds.has(edge.source) && includedIds.has(edge.target));
  return {
    task,
    nodes: relatedNodes,
    edges: relatedEdges,
    capabilities: relatedNodes.filter((node) => node.type === "capability").sort(compareNodes),
    capabilityUnits: relatedNodes.filter((node) => node.type === "capability_unit").sort(compareNodes),
    knowledgeSkills: relatedNodes.filter((node) => node.type === "knowledge_skill").sort(compareNodes),
  };
}

function TaskBrief({ summary }: { summary: string }) {
  // Older packages encode these fields in the summary. Only separate a complete
  // labelled suffix; free-form or incomplete descriptions remain intact.
  const match = summary.match(/^([\s\S]*?)[（(]对象[:：]([\s\S]*?)[；;]交付[:：]([\s\S]*?)[；;]完成标准[:：]([\s\S]*?)[）)]\s*$/);
  if (!match) return <p className="task-purpose">{summary}</p>;
  return <>
    <p className="task-purpose">{match[1]}</p>
    <dl className="task-brief-fields">
      <div><dt>工作对象</dt><dd>{match[2]}</dd></div>
      <div><dt>交付结果</dt><dd>{match[3]}</dd></div>
      <div><dt>完成标准</dt><dd>{match[4]}</dd></div>
    </dl>
  </>;
}

function compactLabel(label: string, max = 16) {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

function ringPositions(nodes: RoleCardNode[], radius: number, offset = -Math.PI / 2) {
  return new Map(nodes.map((node, index) => {
    const angle = offset + (Math.PI * 2 * index) / Math.max(1, nodes.length);
    return [node.id, { x: 500 + Math.cos(angle) * radius, y: 390 + Math.sin(angle) * radius }];
  }));
}

function TaskRelationshipRadar({ bundle, selectedId, onSelect }: { bundle: TaskViewBundle; selectedId: string; onSelect: (node: RoleCardNode) => void }) {
  const positions = useMemo(() => {
    const result = new Map<string, { x: number; y: number }>([[bundle.task.id, { x: 500, y: 390 }]]);
    for (const [id, position] of ringPositions(bundle.capabilities, 142, -Math.PI / 2)) result.set(id, position);
    for (const [id, position] of ringPositions(bundle.capabilityUnits, 232, -Math.PI / 2 + 0.18)) result.set(id, position);
    for (const [id, position] of ringPositions(bundle.knowledgeSkills, 322, -Math.PI / 2 + 0.08)) result.set(id, position);
    return result;
  }, [bundle]);

  return (
    <div className="task-radar-panel">
      <svg viewBox="0 0 1000 780" role="img" aria-label={`${bundle.task.label}与能力、能力单元、知识技能的关系雷达图`}>
        <circle className="task-radar-ring capability-ring" cx="500" cy="390" r="142" />
        <circle className="task-radar-ring unit-ring" cx="500" cy="390" r="232" />
        <circle className="task-radar-ring skill-ring" cx="500" cy="390" r="322" />
        <text className="task-radar-ring-label" x="500" y="239">岗位能力</text>
        <text className="task-radar-ring-label" x="500" y="149">能力单元</text>
        <text className="task-radar-ring-label" x="500" y="59">知识点 / 技能点</text>

        <g className="task-radar-edges">
          {bundle.edges.map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            return (
              <line key={edge.id || `${edge.source}:${edge.type}:${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={edge.lifecycle === "candidate" ? "candidate" : ""}>
                <title>{relationLabels[edge.type] || edge.type}</title>
              </line>
            );
          })}
        </g>

        {bundle.nodes.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const center = node.id === bundle.task.id;
          const palette = nodeColors[node.type] || nodeColors.task;
          const width = center ? 184 : 126;
          const height = center ? 62 : 40;
          return (
            <g
              key={node.id}
              className={`task-radar-node ${node.type} ${selectedId === node.id ? "selected" : ""}`}
              transform={`translate(${position.x}, ${position.y})`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(node)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(node); }}
            >
              <title>{`${node.label}：${node.summary}`}</title>
              <rect x={-width / 2} y={-height / 2} width={width} height={height} rx={center ? 18 : 12} fill={palette.fill} stroke={palette.stroke} />
              <text fill={palette.text} textAnchor="middle" dominantBaseline="middle" fontSize={center ? 15 : 11} fontWeight={center ? 800 : 700}>{compactLabel(node.label, center ? 20 : 15)}</text>
            </g>
          );
        })}
      </svg>
      <div className="task-radar-legend">
        <span><i className="task-dot" />典型任务</span>
        <span><i className="capability-dot" />岗位能力</span>
        <span><i className="unit-dot" />能力单元</span>
        <span><i className="skill-dot" />知识技能</span>
        <small>点击节点查看详情；虚线表示候选关系。</small>
      </div>
    </div>
  );
}

function TaskRelatedSummary({ bundle, selectedId, onSelect, onReference }: { bundle: TaskViewBundle; selectedId: string; onSelect: (node: RoleCardNode) => void; onReference: (node: RoleCardNode) => void }) {
  const groups = [
    { label: "岗位能力", nodes: bundle.capabilities },
    { label: "能力单元", nodes: bundle.capabilityUnits },
    { label: "知识点与技能点", nodes: bundle.knowledgeSkills },
  ];
  return (
    <aside className="task-related-summary" aria-label="任务关联对象清单">
      <header><Network size={16} /><span><b>完成任务需要什么</b><small>选择能力或知识技能，查看具体要求</small></span></header>
      <div className="task-related-scroll">
        {groups.map((group) => (
          <section key={group.label}>
            <h3>{group.label}<span>{group.nodes.length}</span></h3>
            {group.nodes.length ? group.nodes.map((node) => (
              <article className={selectedId === node.id ? "selected" : ""} key={node.id}>
                <button onClick={() => onSelect(node)}><b>{node.label}</b><small>{node.summary}</small></button>
                <button aria-label={`引用${node.label}`} onClick={() => onReference(node)}><Plus size={11} /></button>
              </article>
            )) : <p>当前岗位包尚未建立这一层关系。</p>}
          </section>
        ))}
      </div>
    </aside>
  );
}

export default function TaskWorkspace({
  nodes,
  edges,
  workProcess,
  taskId,
  query,
  selectedId,
  perspective,
  onTaskChange,
  onPerspectiveChange,
  onSelect,
  onReference,
  onDragStart,
  onDragEnd,
  onOpenEvidence,
  onConvert,
  converting = false,
  conversionHint,
}: Props) {
  const tasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return nodes.filter((node) => node.type === "task" && (!needle || `${node.label} ${node.summary}`.toLowerCase().includes(needle))).sort(compareNodes);
  }, [nodes, query]);
  const bundle = useMemo(() => buildTaskViewBundle(nodes, edges, taskId), [nodes, edges, taskId]);
  const indexRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const index = indexRef.current;
    const active = index?.querySelector<HTMLButtonElement>("button.active");
    if (index && active) {
      const offset = active.getBoundingClientRect().left - index.getBoundingClientRect().left;
      index.scrollLeft += offset - (index.clientWidth - active.offsetWidth) / 2;
    }
  }, [taskId, tasks]);
  useEffect(() => { detailRef.current?.scrollTo({ top: 0 }); }, [taskId]);

  if (!bundle) return <div className="task-workspace-empty">当前岗位包还没有可展开的典型工作任务。</div>;

  const relationCount = bundle.edges.length;
  const sourceCount = new Set(bundle.nodes.flatMap((node) => node.evidence_summary.source_refs)).size;
  const scenarioCount = workProcess?.workProcess.scenarios.filter((scenario) => scenario.task_refs.includes(bundle.task.id)).length || 0;
  return (
    <div className="task-workspace">
      <aside className="task-index" aria-label="典型工作任务">
        <header><h2>典型工作任务</h2><p>{tasks.length} 项任务 · 选择一项，了解工作与能力要求</p></header>
        <div className="task-index-scroll" ref={indexRef}>
          {tasks.map((task, index) => (
            <button className={task.id === bundle.task.id ? "active" : ""} aria-pressed={task.id === bundle.task.id} title={task.label} key={task.id} onClick={() => onTaskChange(task)}>
              <i>{String(index + 1).padStart(2, "0")}</i>
              <span><b>{task.label}</b></span>
            </button>
          ))}
        </div>
      </aside>

      <section className="task-detail" ref={detailRef} aria-label={bundle.task.label}>
        <header className="task-detail-header">
          <div className="task-detail-copy">
            <span>任务说明 <em>{bundle.task.lifecycle === "accepted" ? "已接受" : bundle.task.lifecycle === "deprecated" ? "已弃用" : "候选 · 待核实"}</em></span>
            <h2>{bundle.task.label}</h2>
            <TaskBrief summary={bundle.task.summary} />
          </div>
          <div className="task-detail-actions">
            {onConvert && <button type="button" disabled={converting} onClick={() => onConvert(bundle.task)}>{converting ? "正在准备转换…" : "转为学习任务 →"}</button>}
            <button className="secondary" onClick={() => onOpenEvidence(bundle.nodes)}><BookOpenCheck size={13} /> 查看证据</button>
            <button className="secondary" draggable onDragStart={() => onDragStart(bundle.task)} onDragEnd={onDragEnd} onClick={() => onReference(bundle.task)}><Plus size={13} /> 引用任务</button>
          </div>
          <details className="task-research-details" key={bundle.task.id}>
            <summary><BookOpenCheck size={14} /> {sourceCount} 个关联来源 <span>研究依据与使用说明</span></summary>
            <div className="task-detail-facts">
              <span><b>{bundle.task.evidence_summary.max_confidence.toFixed(2)}</b><small>任务置信（非掌握程度）</small></span>
              <span><b>{relationCount}</b><small>结构关系</small></span>
              <span><b>{scenarioCount}</b><small>事理场景</small></span>
            </div>
            {conversionHint && <p className="task-conversion-hint">{conversionHint}</p>}
          </details>
        </header>

        <nav className="task-perspectives" aria-label="典型任务视角">
          <button aria-pressed={perspective === "relations"} className={perspective === "relations" ? "active" : ""} onClick={() => onPerspectiveChange("relations")}><Network size={13} /><span><b>能力要求</b><small>需要具备什么</small></span></button>
          <button aria-pressed={perspective === "process"} className={perspective === "process" ? "active" : ""} onClick={() => onPerspectiveChange("process")}><Route size={13} /><span><b>工作过程</b><small>如何完成 · {scenarioCount} 个事理场景</small></span></button>
        </nav>

        <div className={`task-perspective-stage ${perspective}`}>
          {perspective === "relations" ? (
            <div className="task-relation-layout">
              <TaskRelatedSummary bundle={bundle} selectedId={selectedId} onSelect={onSelect} onReference={onReference} />
              <details className="task-radar-disclosure" key={bundle.task.id}>
                <summary><Network size={15} /> 关系雷达 <span>展开查看能力之间的连接</span></summary>
                <TaskRelationshipRadar bundle={bundle} selectedId={selectedId} onSelect={onSelect} />
              </details>
            </div>
          ) : workProcess && scenarioCount > 0 ? (
            <WorkProcessForestView
              payload={workProcess}
              query=""
              taskId={bundle.task.id}
              semanticNodes={nodes}
              taskKnowledgeSkills={bundle.knowledgeSkills}
              selectedId={selectedId}
              embedded
              onSelect={onSelect}
              onReference={onReference}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ) : <div className="task-process-empty"><Route size={24} /><h3>工作过程待补充</h3><p>这项任务尚未建立具体场景、操作步骤与交付物。可在研究对话中引用任务，补充工作过程。</p><button onClick={() => onReference(bundle.task)}><Plus size={14} /> 引用任务到研究对话</button></div>}
        </div>
      </section>
    </div>
  );
}
