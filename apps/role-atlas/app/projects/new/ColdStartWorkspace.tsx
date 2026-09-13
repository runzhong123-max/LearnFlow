"use client";

import ResearchRunDetail from "@/app/components/ResearchRunDetail";

import {
  AlertTriangle,
  ArrowLeft,
  BookOpenCheck,
  Check,
  CircleX,
  FileText,
  GitBranch,
  Globe2,
  Layers3,
  Network,
  Pause,
  Play,
  SearchCheck,
  Settings,
  Sparkles,
  Square,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import SourceMaterials from "@/app/components/SourceMaterials";
import type { SourceInput } from "@/lib/build/types";
import ResearchAudit from "@/app/components/ResearchAudit";
import type { BuildEvent } from "@/lib/build/events";
import type { AuditIssue, BuildWorkItemSummary, ColdStartBuildResult, LearningPathGraphInput, ProcessNode, ProcessScenario, SemanticEdge, SemanticNode, SnapshotSection } from "@/lib/build/types";
import { PROVIDERS, PROVIDER_SESSION_KEY, type ProviderConfig } from "@/lib/providers";
import { SEARCH_PROVIDERS, SEARCH_PROVIDER_SESSION_KEY, type SearchProviderConfig } from "@/lib/search/providers";
import type { RuntimeConfigStatus } from "@/lib/runtime-config";
import { getWorkspaceSkillDefinition, isWorkspaceSkillId, type WorkspaceSkillId } from "@/lib/skills/workspace";

type View = "semantic" | "process" | "snapshot" | "evidence";
type PhaseStatus = "pending" | "running" | "done" | "degraded" | "failed";

const phases = [
  ["boundary", "岗位边界"],
  ["sources", "来源与证据"],
  ["semantic", "岗位结构"],
  ["process", "事理森林"],
  ["snapshot", "岗位快照"],
  ["package", "岗位包校验"],
] as const;

const buildKindLabels: Partial<Record<BuildEvent["kind"], string>> = {
  "build.run.started": "冷启动运行开始",
  "build.boundary.stabilized": "形成岗位边界与默认假设",
  "build.plan.created": "建立并行构建计划",
  "build.research.plan.created": "规划多来源联网检索",
  "build.search.started": "发起联网查询",
  "build.search.retrying": "暂时失败，正在有限重试",
  "build.search.completed": "联网查询返回结果",
  "build.search.failed": "联网查询保守降级",
  "build.source.fetched": "抓取并清洗来源正文",
  "build.source.deduplicated": "合并重复来源",
  "build.research.completed": "联网研究通道完成",
  "build.source.registered": "登记来源",
  "build.source.segmented": "来源完成稳定分段",
  "build.source.qualified": "判定来源可承担的证据角色",
  "build.work_item.queued": "工作项进入调度队列",
  "build.work_item.started": "模型工作项开始",
  "build.work_item.completed": "模型工作项完成",
  "build.work_item.failed": "模型工作项局部失败",
  "build.task_barrier.completed": "稳定任务骨架形成",
  "build.fast_snapshot.completed": "快速任务骨架快照已保存",
  "build.kernel.completed": "岗位内核已保存，可进入工作台",
  "build.enrichment.queued": "事理与技能依赖后台增量已排队",
  "build.enrichment.started": "后台增量开始",
  "build.enrichment.semantic.completed": "知识技能与依赖子版本完成",
  "build.enrichment.process.completed": "事理森林增量完成",
  "build.targeted_research.started": "针对知识缺口发起补研",
  "build.targeted_research.completed": "知识缺口补研完成",
  "build.evidence.bound": "证据绑定完成",
  "build.lane.started": "启动模型抽取分支",
  "build.lane.completed": "模型抽取分支完成",
  "build.reasoning.delta": "模型思考增量",
  "build.semantic.patch": "岗位结构完成规范化",
  "build.process.patch": "事理森林完成规范化",
  "build.audit.issue.created": "发现审计问题",
  "build.inspection.started": "开始非阻断结构检查",
  "build.inspection.finding.created": "形成结构发现与研究线索",
  "build.inspection.completed": "结构检查与 Agent 探针完成",
  "build.snapshot.section.drafted": "岗位快照章节形成",
  "build.package.compile.started": "开始编译统一岗位包",
  "build.package.compile.completed": "岗位包三命名空间编译完成",
  "build.package.validation.completed": "岗位包校验完成",
  "build.run.completed": "冷启动运行完成",
  "build.run.failed": "冷启动运行失败",
};

function profileLabel(profile: BuildEvent["profile"]) {
  return { structural: "结构", semantic: "语义", evidence: "证据", temporal: "时间", process: "事理", system: "系统" }[profile];
}

function shortLabel(value: string, limit = 10) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function semanticLooksIncomplete(result: ColdStartBuildResult) {
  const types = new Set(result.semantic.nodes.map((node) => node.type));
  return !types.has("task") || !types.has("capability") || !types.has("knowledge_skill")
    || result.semantic.edges.length === 0
    || result.audit.issues.some((issue) => issue.code === "LANE_FALLBACK" && /语义/u.test(issue.detail));
}

function processLooksIncomplete(result: ColdStartBuildResult) {
  return result.process.scenarios.length === 0
    || result.process.scenarios.some((scenario) => /招聘|求职|应聘|面试|面经|学习路径|课程|培训|教程|视频/u.test(`${scenario.label}${scenario.summary}`))
    || result.audit.issues.some((issue) => issue.code === "LANE_FALLBACK" && /事理/u.test(issue.detail));
}

function resultLooksIncomplete(result: ColdStartBuildResult) {
  return semanticLooksIncomplete(result) || processLooksIncomplete(result);
}

function formatDuration(value: unknown) {
  const milliseconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  return milliseconds < 1_000 ? `${Math.max(1, Math.round(milliseconds))} ms` : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`;
}

function workItemOf(event: BuildEvent) {
  return event.payload.workItem as BuildWorkItemSummary | undefined;
}

function laneLabel(lane: string) {
  if (lane === "search-planning") return "联网检索规划";
  if (lane.startsWith("mention:")) return "来源分片抽取";
  if (lane.startsWith("task-barrier")) return "任务聚类与规范化";
  if (lane.startsWith("knowledge:")) return "按任务派生知识技能";
  if (lane.startsWith("capability:")) return "跨任务归纳能力";
  if (lane.startsWith("process:")) return "按任务展开事理场景";
  return lane;
}

function buildEventDetail(event: BuildEvent) {
  const item = workItemOf(event);
  if (item) {
    const duration = item.actualDurationMs === undefined ? "" : ` · ${formatDuration(item.actualDurationMs)}`;
    const cache = item.cacheHit ? " · 命中缓存" : "";
    return `${laneLabel(item.lane)} · 输入约 ${item.estimatedInputTokens} tokens · 输出上限 ${item.maxOutputTokens}${duration}${cache}`;
  }
  if (event.kind === "build.source.registered") return String(event.payload.title || "");
  if (event.kind === "build.source.qualified") {
    const qualification = event.payload.qualification as { status?: string; evidenceRoles?: string[] } | undefined;
    return `${qualification?.status || "待定"} · ${qualification?.evidenceRoles?.join("、") || "仅作上下文"}`;
  }
  if (event.kind === "build.task_barrier.completed") return `${String(event.payload.taskCount || 0)} 个稳定任务 · ${String(event.payload.taskGroupCount || 0)} 个任务组 · ${formatDuration(event.payload.durationMs)}`;
  if (event.kind === "build.fast_snapshot.completed") {
    const fast = event.payload.result as ColdStartBuildResult | undefined;
    return fast ? `${fast.semantic.nodes.filter((node) => node.type === "task").length} 个任务 · ${fast.snapshot.id}` : "已写入不可变候选版本";
  }
  if (event.kind === "build.targeted_research.started" || event.kind === "build.targeted_research.completed") return `${String(event.payload.queryCount || 0)} 条定点查询${event.payload.selectedSourceCount === undefined ? "" : ` · 新增 ${String(event.payload.selectedSourceCount)} 个来源`}`;
  if (event.kind === "build.lane.started") return `${String(event.payload.lane || "")} · 并行限界处理`;
  if (event.kind === "build.lane.completed") return `${String(event.payload.lane || "")} · ${event.payload.degraded ? "部分失败，已保留其余产物" : "完成"}${event.payload.durationMs ? ` · ${formatDuration(event.payload.durationMs)}` : ""}`;
  if (event.kind === "build.process.patch") return `${String((event.payload.scenarios as unknown[] | undefined)?.length || 0)} 棵任务锚定场景已形成`;
  if (event.kind === "build.inspection.finding.created") return String((event.payload.finding as { title?: string } | undefined)?.title || "");
  return "";
}

function displayAxisValue(key: string, value: number, result: ColdStartBuildResult) {
  const types = new Set(result.semantic.nodes.map((node) => node.type));
  const semanticCoverage = ["task", "capability", "knowledge_skill"].filter((type) => types.has(type as SemanticNode["type"])).length / 3;
  if (key === "structuralValidity") return Math.min(value, result.semantic.edges.length ? 35 + semanticCoverage * 65 : semanticCoverage * 20);
  if (key === "semanticClarity") return Math.min(value, semanticCoverage * 100);
  if (key === "processCoverage" && !types.has("task")) return 0;
  if (key === "agentUsability" && resultLooksIncomplete(result)) return Math.min(value, 45);
  return value;
}

type ColdStartInitialQuery = {
  project?: string;
  conversation?: string;
  role?: string;
  description?: string;
  market?: string;
  skill?: string;
};

export default function ColdStartWorkspace({ initialQuery, embedded = false, onClose, onSettingsRequest }: { initialQuery: ColdStartInitialQuery; embedded?: boolean; onClose?: () => void; onSettingsRequest?: () => void }) {
  const requestedSkill = initialQuery.skill || null;
  const [roleTitle, setRoleTitle] = useState(initialQuery.role || "");
  const [roleDescription, setRoleDescription] = useState(initialQuery.description || "");
  const [market, setMarket] = useState(initialQuery.market || "中国大陆");
  const [materials, setMaterials] = useState<SourceInput[]>([]);
  const [materialsBusy, setMaterialsBusy] = useState(false);
  const [webResearch, setWebResearch] = useState(true);
  const [view, setView] = useState<View>("semantic");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [phaseState, setPhaseState] = useState<Record<string, PhaseStatus>>(() => Object.fromEntries(phases.map(([id]) => [id, "pending"])));
  const [semanticNodes, setSemanticNodes] = useState<SemanticNode[]>([]);
  const [semanticEdges, setSemanticEdges] = useState<SemanticEdge[]>([]);
  const [processScenarios, setProcessScenarios] = useState<ProcessScenario[]>([]);
  const [processNodes, setProcessNodes] = useState<ProcessNode[]>([]);
  const [snapshotSections, setSnapshotSections] = useState<SnapshotSection[]>([]);
  const [issues, setIssues] = useState<AuditIssue[]>([]);
  const [reasoning, setReasoning] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ColdStartBuildResult | null>(null);
  const [projectId, setProjectId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const skillIntent: WorkspaceSkillId | null = isWorkspaceSkillId(requestedSkill) ? requestedSkill : null;
  const [configuredRuntime, setConfiguredRuntime] = useState({ model: "正在检查…", modelReady: false, search: "正在检查…", searchReady: false });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let sessionModel = "";
    let sessionSearch = "";
    try {
      const model = JSON.parse(sessionStorage.getItem(PROVIDER_SESSION_KEY) || "null") as ProviderConfig | null;
      if (model?.apiKey && PROVIDERS[model.provider]) sessionModel = `${PROVIDERS[model.provider].name} · 会话配置`;
    } catch { sessionStorage.removeItem(PROVIDER_SESSION_KEY); }
    try {
      const search = JSON.parse(sessionStorage.getItem(SEARCH_PROVIDER_SESSION_KEY) || "null") as SearchProviderConfig | null;
      if (search?.apiKey && SEARCH_PROVIDERS[search.provider]) sessionSearch = `${SEARCH_PROVIDERS[search.provider].name} · 会话配置`;
    } catch { sessionStorage.removeItem(SEARCH_PROVIDER_SESSION_KEY); }
    const controller = new AbortController();
    fetch("/api/runtime-config", { signal: controller.signal })
      .then((response) => response.json() as Promise<RuntimeConfigStatus>)
      .then((status) => setConfiguredRuntime({
        model: sessionModel || (status.model.configured ? `${PROVIDERS[status.model.provider].name} · 开发环境` : "未配置"),
        modelReady: Boolean(sessionModel || status.model.configured),
        search: sessionSearch || (status.search.configured ? `${SEARCH_PROVIDERS[status.search.provider].name} · 开发环境` : "未配置"),
        searchReady: Boolean(sessionSearch || status.search.configured),
      }))
      .catch(() => setConfiguredRuntime({ model: sessionModel || "状态读取失败", modelReady: Boolean(sessionModel), search: sessionSearch || "状态读取失败", searchReady: Boolean(sessionSearch) }));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const existingProjectId = initialQuery.project;
    if (!existingProjectId) return;
    const controller = new AbortController();
    fetch(`/api/projects/${encodeURIComponent(existingProjectId)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as {
          error?: string;
          project?: { title: string; description: string; market: string };
          conversations?: Array<{ id: string }>;
          result?: ColdStartBuildResult | null;
        };
        if (!response.ok || !payload.project) throw new Error(payload.error || "项目读取失败。");
        const preferredConversation = initialQuery.conversation;
        const resolvedConversation = preferredConversation && payload.conversations?.some((item) => item.id === preferredConversation)
          ? preferredConversation
          : payload.conversations?.[0]?.id || "";
        setProjectId(existingProjectId);
        setConversationId(resolvedConversation);
        setRoleTitle(payload.project.title);
        setRoleDescription(payload.project.description);
        setMarket(payload.project.market);
        if (payload.result) {
          setResult(payload.result);
          setSemanticNodes(payload.result.semantic.nodes);
          setSemanticEdges(payload.result.semantic.edges);
          setProcessScenarios(payload.result.process.scenarios);
          setProcessNodes(payload.result.process.nodes);
          setSnapshotSections(payload.result.snapshot.sections);
          setIssues(payload.result.audit.issues);
          setPhaseState(Object.fromEntries(phases.map(([id]) => [id,
            id === "semantic" && semanticLooksIncomplete(payload.result!) || id === "process" && processLooksIncomplete(payload.result!) ? "degraded" : "done",
          ])));
        }
      })
      .catch((cause) => {
        if (cause instanceof Error && cause.name !== "AbortError") setError(cause.message || "项目读取失败。");
    });
    return () => controller.abort();
  }, [initialQuery.conversation, initialQuery.project]);

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const byRing = new Map<number, SemanticNode[]>();
    semanticNodes.forEach((node) => byRing.set(node.ring, [...(byRing.get(node.ring) || []), node]));
    for (const [ring, nodes] of byRing) {
      const radius = [0, 92, 165, 225, 258][Math.min(ring, 4)];
      nodes.forEach((node, index) => {
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(nodes.length, 1) + ring * 0.09;
        map.set(node.id, { x: 380 + Math.cos(angle) * radius, y: 280 + Math.sin(angle) * radius });
      });
    }
    return map;
  }, [semanticNodes]);

  function setPhase(id: string, status: PhaseStatus) {
    setPhaseState((current) => ({ ...current, [id]: status }));
  }

  function applyEvent(event: BuildEvent) {
    if (event.kind !== "build.reasoning.delta") setEvents((current) => [...current, event].slice(-100));
    if (event.kind === "build.run.started") setPhase("boundary", "running");
    if (event.kind === "build.research.plan.created") setPhase("sources", "running");
    if (event.kind === "build.boundary.stabilized") { setPhase("boundary", "done"); setPhase("sources", "running"); }
    if (event.kind === "build.source.segmented") setPhase("sources", "running");
    if (event.kind === "build.task_barrier.completed") setPhase("semantic", "running");
    if (event.kind === "build.fast_snapshot.completed") {
      const fast = event.payload.result as ColdStartBuildResult;
      setResult(fast);
      setSemanticNodes(fast.semantic.nodes);
      setSemanticEdges(fast.semantic.edges);
      setSnapshotSections(fast.snapshot.sections);
      setIssues(fast.audit.issues);
      setPhase("snapshot", "done");
    }
    if (event.kind === "build.kernel.completed") {
      const kernel = event.payload.result as ColdStartBuildResult;
      setResult(kernel);
      setSemanticNodes(kernel.semantic.nodes);
      setSemanticEdges(kernel.semantic.edges);
      setSnapshotSections(kernel.snapshot.sections);
      setIssues(kernel.audit.issues);
      setPhase("semantic", "done");
      setPhase("snapshot", "done");
      setPhase("package", event.payload.preview ? "running" : "done");
    }
    if (event.kind === "build.targeted_research.started") setPhase("sources", "running");
    if (event.kind === "build.targeted_research.completed") setPhase("sources", "done");
    if (event.kind === "build.work_item.started") {
      const stage = workItemOf(event)?.stage || "";
      if (stage === "source-mention-extraction") setPhase("sources", "running");
      if (stage === "task-normalization" || stage === "task-consolidation" || stage.includes("knowledge") || stage.includes("capability")) setPhase("semantic", "running");
      if (stage.includes("process")) setPhase("process", "running");
    }
    if (event.kind === "build.lane.started") {
      const phase = String(event.payload.parentLane || event.payload.lane || "").split(":")[0];
      if (phase === "semantic" || phase === "process") setPhase(phase, "running");
    }
    if (event.kind === "build.lane.completed") {
      const lane = String(event.payload.lane || "");
      if (lane === "semantic" || lane === "process") setPhase(lane, event.payload.degraded ? "degraded" : "done");
    }
    if (event.kind === "build.reasoning.delta") {
      const laneName = String(event.payload.lane || "");
      setReasoning((current) => ({ ...current, [laneName]: `${current[laneName] || ""}${String(event.payload.delta || "")}` }));
    }
    if (event.kind === "build.semantic.patch") {
      const nodes = (event.payload.nodes || []) as SemanticNode[];
      const types = new Set(nodes.map((node) => node.type));
      const taskSkeleton = event.payload.phase === "task-skeleton";
      setPhase("semantic", taskSkeleton ? "running" : event.payload.degraded || !types.has("task") || !types.has("capability") || !types.has("knowledge_skill") ? "degraded" : "done");
      setSemanticNodes(nodes);
      setSemanticEdges((event.payload.edges || []) as SemanticEdge[]);
    }
    if (event.kind === "build.process.patch") {
      const progressive = event.payload.phase === "skeleton" || event.payload.phase === "scenario-expanded" && event.payload.partial;
      setPhase("process", progressive ? "running" : event.payload.degraded || !(event.payload.scenarios as unknown[] | undefined)?.length ? "degraded" : "done");
      setProcessScenarios((event.payload.scenarios || []) as ProcessScenario[]);
      setProcessNodes((event.payload.nodes || []) as ProcessNode[]);
    }
    if (event.kind === "build.evidence.bound") setPhase("sources", "done");
    if (event.kind === "build.audit.issue.created") setIssues((current) => [...current, event.payload.issue as AuditIssue]);
    if (event.kind === "build.snapshot.section.drafted") {
      setPhase("snapshot", "running");
      const section = event.payload.section as SnapshotSection;
      setSnapshotSections((current) => [...current.filter((item) => item.id !== section.id), section]);
    }
    if (event.kind === "build.package.compile.started") setPhase("package", "running");
    if (event.kind === "build.package.validation.completed") {
      setPhase("snapshot", "done");
      setPhase("package", "done");
    }
    if (event.kind === "build.run.completed") {
      const completed = event.payload.result as ColdStartBuildResult;
      setResult(completed);
      setIssues(completed.audit.issues);
      setSemanticNodes(completed.semantic.nodes);
      setSemanticEdges(completed.semantic.edges);
      setPhase("package", completed.deliveryReadiness && !completed.deliveryReadiness.ready ? "degraded" : "done");
    }
    if (event.kind === "build.run.failed") {
      setError(String(event.payload.message || "冷启动运行失败。"));
      setPhaseState((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value === "running" ? "failed" : value])));
    }
  }

  async function startBuild(options?: { reuseProjectSources?: boolean }) {
    if (running || materialsBusy || roleTitle.trim().length < 2) return;
    const rawProvider = sessionStorage.getItem(PROVIDER_SESSION_KEY);
    let providerConfig: ProviderConfig | undefined;
    if (rawProvider) {
      try { providerConfig = JSON.parse(rawProvider) as ProviderConfig; }
      catch { setError("模型配置无效，请重新保存。"); return; }
    }
    let searchConfig: SearchProviderConfig | undefined;
    if (webResearch && !options?.reuseProjectSources) {
      const rawSearch = sessionStorage.getItem(SEARCH_PROVIDER_SESSION_KEY);
      if (rawSearch) {
        try { searchConfig = JSON.parse(rawSearch) as SearchProviderConfig; }
        catch { setError("联网搜索配置无效，请重新保存。"); return; }
      }
    }

    setRunning(true);
    setError("");
    setEvents([]);
    setSemanticNodes([]);
    setSemanticEdges([]);
    setProcessScenarios([]);
    setProcessNodes([]);
    setSnapshotSections([]);
    setIssues([]);
    setReasoning({});
    setResult(null);
    setPhaseState(Object.fromEntries(phases.map(([id]) => [id, "pending"])));
    const controller = new AbortController();
    abortRef.current = controller;
    const runId = crypto.randomUUID();
    let activeProjectId = projectId;
    let activeConversationId = conversationId;
    try {
      if (!activeProjectId) {
        activeProjectId = crypto.randomUUID();
        activeConversationId = crypto.randomUUID();
        const projectResponse = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: activeProjectId,
            conversationId: activeConversationId,
            conversationMode: "iteration",
            title: roleTitle.trim(),
            description: roleDescription.trim(),
            market: market.trim() || "中国大陆",
          }),
        });
        if (!projectResponse.ok) throw new Error((await projectResponse.json().catch(() => ({})) as { error?: string }).error || "项目创建失败。");
        setProjectId(activeProjectId);
        setConversationId(activeConversationId);
        window.history.replaceState(null, "", `/projects/new?project=${encodeURIComponent(activeProjectId)}&conversation=${encodeURIComponent(activeConversationId)}`);
      } else if (result) {
        activeConversationId = crypto.randomUUID();
        const conversationResponse = await fetch(`/api/projects/${encodeURIComponent(activeProjectId)}/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ id: activeConversationId, title: `版本构建 · ${new Date().toLocaleString("zh-CN", { hour12: false })}`, pinToActive: false, mode: "iteration" }),
        });
        if (!conversationResponse.ok) throw new Error((await conversationResponse.json().catch(() => ({})) as { error?: string }).error || "新版本会话创建失败。");
        setConversationId(activeConversationId);
        window.history.replaceState(null, "", `/projects/new?project=${encodeURIComponent(activeProjectId)}&conversation=${encodeURIComponent(activeConversationId)}`);
      }
      const learningPathGraph = await fetch("/data/learnflow-learning-path.json", { signal: controller.signal })
        .then(async (pathResponse) => pathResponse.ok ? await pathResponse.json() as LearningPathGraphInput : undefined)
        .catch(() => undefined);
      const response = await fetch("/api/build-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          build: {
            runId,
            projectId: activeProjectId,
            roleTitle: roleTitle.trim(),
            roleDescription: roleDescription.trim(),
            market: market.trim() || "中国大陆",
            audience: ["高职学生", "教师"],
            snapshotAsOf: new Date().toISOString().slice(0, 10),
            sources: materials,
            learningPathGraph,
          },
          conversationId: activeConversationId,
          providerConfig,
          searchConfig,
          webResearch: webResearch && !options?.reuseProjectSources,
          reuseProjectSources: Boolean(options?.reuseProjectSources),
        }),
      });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || `请求失败（${response.status}）`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let kernelResult: ColdStartBuildResult | null = null;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
          const event = JSON.parse(line) as BuildEvent;
          if ((event.kind === "build.kernel.completed" && !event.payload.preview) || (event.kind === "build.run.completed" && (event.payload.result as ColdStartBuildResult)?.deliveryReadiness?.ready)) kernelResult = event.payload.result as ColdStartBuildResult;
          applyEvent(event);
        });
        if (done) break;
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer) as BuildEvent;
        if ((event.kind === "build.kernel.completed" && !event.payload.preview) || (event.kind === "build.run.completed" && (event.payload.result as ColdStartBuildResult)?.deliveryReadiness?.ready)) kernelResult = event.payload.result as ColdStartBuildResult;
        applyEvent(event);
      }
      if (kernelResult && (kernelResult as ColdStartBuildResult).deliveryReadiness?.ready) {
        window.location.assign(`/projects/${encodeURIComponent(activeProjectId)}?conversation=${encodeURIComponent(activeConversationId)}`);
      } else if (kernelResult) {
        sessionStorage.setItem(`role-atlas.pending-enrichment:${activeProjectId}`, JSON.stringify({
          baseSnapshotId: (kernelResult as ColdStartBuildResult).snapshot.id,
          enrichmentRunId: `${crypto.randomUUID()}:enrichment`,
          roleTitle: roleTitle.trim(),
          roleDescription: roleDescription.trim(),
          market: market.trim() || "中国大陆",
          conversationId: activeConversationId,
          webResearch: webResearch && !options?.reuseProjectSources,
        }));
        window.location.assign(`/projects/${encodeURIComponent(activeProjectId)}?conversation=${encodeURIComponent(activeConversationId)}&enrich=1`);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "冷启动请求失败。");
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const incomplete = result ? resultLooksIncomplete(result) : false;
  const fastSnapshotActive = result?.build?.stage === "kernel";
  const evidenceTargets = result ? [
    ...result.semantic.nodes,
    ...result.semantic.edges,
    ...result.process.scenarios,
    ...result.process.nodes,
    ...result.process.edges,
  ] : [];
  const directTargetIds = new Set(result?.sources.evidenceBindings.filter((binding) => binding.support === "direct").map((binding) => binding.targetId) || []);
  const directCoverage = evidenceTargets.length ? evidenceTargets.filter((target) => directTargetIds.has(target.id)).length / evidenceTargets.length : 0;

  const Shell = embedded ? "div" : "main";
  return (
    <Shell className={`cold-shell${embedded ? " embedded-operation" : ""}`}>
      <aside className="cold-brief">
        <header className="cold-brand"><span><Network size={16} /></span><div><b>Role Atlas</b><small>完整岗位包冷启动</small></div></header>
        {embedded && onClose ? <button type="button" className="cold-back" onClick={onClose}><ArrowLeft size={13} /> 返回当前岗位</button> : <Link className="cold-back" href="/"><ArrowLeft size={13} /> 返回当前岗位</Link>}
        <section className="cold-form">
          <div className="cold-kicker">PROJECT BRIEF</div>
          <h1>{projectId ? "继续构建岗位项目" : "新建岗位项目"}</h1>
          <p>先确认必要边界。其余不确定信息由 Agent 研究，无法自行解决时才生成问题。</p>
          {skillIntent ? (
            <div className="cold-skill-intent">
              <Sparkles size={13} />
              <span><b>已选择「{getWorkspaceSkillDefinition(skillIntent).label}」技能</b><small>{getWorkspaceSkillDefinition(skillIntent).description}</small></span>
            </div>
          ) : null}
          <label><span>岗位或岗位方向 *</span><input value={roleTitle} disabled={running} onChange={(event) => setRoleTitle(event.target.value)} placeholder="例如：大模型应用工程师" /></label>
          <label><span>你想重点了解什么</span><textarea value={roleDescription} disabled={running} onChange={(event) => setRoleDescription(event.target.value)} placeholder="可以很模糊，例如：想了解开发智能体的工作" /></label>
          <label><span>市场范围</span><input value={market} disabled={running} onChange={(event) => setMarket(event.target.value)} /></label>
          <div className="cold-source-heading"><b>可选资料或工作区摘录</b><small>不提供也可开始，但只会形成待研究候选</small></div>
          <label className="cold-web-toggle">
            <span><Globe2 size={13} /><b>自主联网研究</b><small>按来源类别并行搜索、抓取、去重并建立来源索引</small></span>
            <input type="checkbox" checked={webResearch} disabled={running} onChange={(event) => setWebResearch(event.target.checked)} />
          </label>
          <div className="cold-provider-summary">
            <span className={configuredRuntime.modelReady ? "ready" : "missing"}><b>生成模型</b><small>{configuredRuntime.model}</small></span>
            <span className={!webResearch || configuredRuntime.searchReady ? "ready" : "missing"}><b>联网搜索</b><small>{webResearch ? configuredRuntime.search : "本轮关闭"}</small></span>
            {(!configuredRuntime.modelReady || (webResearch && !configuredRuntime.searchReady)) ? embedded && onSettingsRequest ? <button type="button" onClick={onSettingsRequest}>去配置</button> : <Link href="/settings">去配置</Link> : null}
          </div>
          <SourceMaterials value={materials} onChange={setMaterials} disabled={running} onBusyChange={setMaterialsBusy} />
          {error ? <div className="cold-error"><AlertTriangle size={13} />{error}{/模型/.test(error) ? embedded && onSettingsRequest ? <button type="button" onClick={onSettingsRequest}>去设置</button> : <Link href="/settings">去设置</Link> : null}</div> : null}
          {running ? <button className="cold-start stop" onClick={() => abortRef.current?.abort()}><Square size={12} /> 停止本轮构建</button> : <button className="cold-start" disabled={materialsBusy || roleTitle.trim().length < 2} onClick={() => void startBuild()}><Play size={13} /> 研究并交付完整首版</button>}
          {result && !running ? <button className="cold-start" onClick={() => void startBuild({ reuseProjectSources: true })}><Layers3 size={13} /> 复用已有资料继续研究</button> : null}
          {result && projectId ? <Link className="cold-open-project" href={skillIntent === "snapshot-iteration" && result.deliveryReadiness?.ready !== false ? `/snapshots/${encodeURIComponent(result.snapshot.id)}/iterate?profile=co_guided&project=${encodeURIComponent(projectId)}&conversation=${encodeURIComponent(conversationId)}` : `/projects/${projectId}?conversation=${conversationId}`}>{skillIntent === "snapshot-iteration" && result.deliveryReadiness?.ready !== false ? "进入岗位快照迭代" : "打开项目工作台"} <ArrowLeft size={12} /></Link> : null}
        </section>
      </aside>

      <section className="cold-main">
        <header className="cold-main-header">
          <div><span>ROLE PACKAGE BUILD</span><h2>{roleTitle.trim() || "等待确定岗位"}</h2></div>
          {result?.deliveryReadiness && !result.deliveryReadiness.ready && <aside role="status"><b>研究草稿 · 尚未交付完整首版</b><p>可补充材料后继续研究；停止原因和依据见研究记录。</p><ul>{result.deliveryReadiness.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></aside>}
          <div className={`cold-status ${running ? "running" : incomplete ? "degraded" : result ? "done" : ""}`}><i />{running ? (fastSnapshotActive ? "快速快照已保存 · 正在展开" : "正在构建") : incomplete ? "构建不完整 · 需要修复" : result ? (result.validation.publishable ? "可发布候选" : "候选包待研究") : "尚未开始"}</div>
        </header>
        <nav className="cold-tabs">
          <button className={view === "semantic" ? "active" : ""} onClick={() => setView("semantic")}><Network size={12} />岗位结构 <small>{semanticNodes.length}</small></button>
          <button className={view === "process" ? "active" : ""} onClick={() => setView("process")}><Workflow size={12} />事理森林 <small>{processScenarios.length}</small></button>
          <button className={view === "snapshot" ? "active" : ""} onClick={() => setView("snapshot")}><FileText size={12} />岗位快照 <small>{snapshotSections.length}</small></button>
          <button className={view === "evidence" ? "active" : ""} onClick={() => setView("evidence")}><BookOpenCheck size={12} />证据与审计 <small>{issues.length}</small></button>
        </nav>
        {incomplete && !running ? <div className="cold-incomplete"><AlertTriangle size={15} /><span><b>本轮只形成了部分候选产物</b><small>缺失的任务、能力、知识技能、关系或事理分支没有被伪装成成功；请查看右侧降级步骤与“证据与审计”。</small></span></div> : null}
        <div className="cold-stage">
          {view === "semantic" ? (
            semanticNodes.length > 0 ? <svg className="cold-graph" viewBox="0 0 760 560" role="img" aria-label="冷启动中的岗位结构图">
              <g className="cold-edges">{semanticEdges.map((edge) => { const source = positions.get(edge.source); const target = positions.get(edge.target); return source && target ? <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} /> : null; })}</g>
              {semanticNodes.map((node) => { const point = positions.get(node.id)!; return <g className={`cold-node ${node.type}`} key={node.id} transform={`translate(${point.x} ${point.y})`}><circle r={node.ring === 0 ? 38 : 20} /><text y={node.ring === 0 ? 3 : 36}>{shortLabel(node.label, node.ring === 0 ? 14 : 9)}</text></g>; })}
            </svg> : <ColdEmpty icon={<Network size={25} />} title="岗位将从这里逐层涌现" detail="来源完成分段后，语义 Lane 会生成任务、能力、知识技能和关系，再经过同维度聚类。" />
          ) : view === "process" ? (
            processScenarios.length > 0 ? <div className="cold-forest">{processScenarios.map((scenario) => <article key={scenario.id}><header><span>{scenario.knowledgeState}</span><h3>{scenario.label}</h3><p>{scenario.summary}</p></header><div>{processNodes.filter((node) => node.scenarioId === scenario.id).sort((a, b) => (a.sequenceHint || 0) - (b.sequenceHint || 0)).map((node, index) => <div className={`cold-event ${node.kind}`} key={node.id}><i>{String(index + 1).padStart(2, "0")}</i><span><b>{node.label}</b><small>{node.kind} · {node.summary}</small></span></div>)}</div></article>)}</div> : <ColdEmpty icon={<Workflow size={25} />} title="事理森林与语义图并行生成" detail="场景、事件、对象、参与者、交付物、分支和返工会保持独立层，并桥接到稳定任务。" />
          ) : view === "snapshot" ? (
            snapshotSections.length > 0 ? <div className="cold-sections">{snapshotSections.map((section, index) => <article key={section.id}><span>{String(index + 1).padStart(2, "0")} · {section.status}</span><h3>{section.title}</h3><p>{section.summary}</p><footer>{section.itemIds.length} 对象 · {section.evidenceBindingIds.length} 证据绑定</footer></article>)}</div> : <ColdEmpty icon={<FileText size={25} />} title="快照不是另一份自由生成文本" detail="它将在双图归并和交叉审计后，从同一事实层逐章节编译。" />
          ) : (
            result || issues.length > 0 ? <div className="cold-evidence-view">
              <div className="cold-evidence-stats"><span><b>{result?.sources.assets.length || 0}</b><small>入选来源</small></span><span><b>{result?.sources.research?.candidateCount || 0}</b><small>检索候选</small></span><span><b>{result?.sources.evidenceBindings.length || 0}</b><small>可解析绑定</small></span><span><b>{Math.round((result?.validation.evidence.coverage || 0) * 100)}%</b><small>任意绑定覆盖</small></span><span><b>{Math.round(directCoverage * 100)}%</b><small>直接证据覆盖</small></span><span><b>{result?.sources.research?.usage?.totalCredits ?? "—"}</b><small>Tavily Credits</small></span></div>
              {result?.audit.inspection ? <div className="cold-inspection-summary"><header><b>构建后诊断</b><small>{result.audit.inspection.protocolValid ? "协议可读取；不代表内容已经完整或可靠" : `${result.audit.inspection.hardBlockerIds.length} 个协议阻断`}</small></header>{Object.entries(result.audit.inspection.axes).map(([key, value]) => <span key={key}><b>{Math.round(displayAxisValue(key, value, result))}</b><small>{{ structuralValidity: "可遍历结构", semanticClarity: "语义覆盖", evidenceReadiness: "证据就绪", temporalIntegrity: "时点完整", processCoverage: "任务事理覆盖", agentUsability: "Agent 可用" }[key as keyof typeof result.audit.inspection.axes]}</small></span>)}</div> : null}
              <ResearchRunDetail run={result?.researchRun} />
              {result?.sources.research ? <ResearchAudit report={result.sources.research} /> : null}
              {result?.sources.assets.length ? <div className="cold-source-index">{result.sources.assets.map((source) => <article key={source.id}><span><b>{source.title}</b><small>{source.domain || source.kind} · {source.sourceTier || "用户资料"} · {source.publishedAt || source.observedAt || "时间未知"} · {source.extractionMethod === "provider_extract" ? "定向抽取" : source.extractionMethod === "direct_fetch" ? "原页抓取" : "搜索内容"} · {source.providerRequestIds?.length || 0} 个请求索引</small></span>{source.locator ? <a href={source.locator} target="_blank" rel="noreferrer">查看原文</a> : <em>项目内资料</em>}</article>)}</div> : null}
              <div className="cold-issues">{issues.map((issue) => <article className={issue.severity} key={issue.id}><AlertTriangle size={14} /><span><b>{issue.title}</b><small>{issue.detail}</small></span><em>{issue.repair}</em></article>)}</div>
            </div> : <ColdEmpty icon={<BookOpenCheck size={25} />} title="证据先于正式节点" detail="来源、分段和证据绑定会在节点进入快照前完成；证据不足会生成 Issue 与研究主题。" />
          )}
        </div>
        <footer className="cold-main-footer"><span><i className="dot blue" />岗位/产业</span><span><i className="dot orange" />任务</span><span><i className="dot violet" />能力</span><span><i className="dot green" />知识技能</span><span><GitBranch size={11} />语义图与事理森林独立版本化</span></footer>
      </section>

      <aside className="cold-runner">
        <header><div><Sparkles size={14} /><span><b>COLD START SKILL</b><small>证据驱动 · 双图协同 · 多产物编译</small></span></div>{embedded && onSettingsRequest ? <button type="button" onClick={onSettingsRequest} aria-label="模型与检索设置"><Settings size={14} /></button> : <Link href="/settings"><Settings size={14} /></Link>}</header>
        <div className="cold-phases">{phases.map(([id, label], index) => <div className={phaseState[id]} key={id}><i>{phaseState[id] === "done" ? <Check size={10} /> : phaseState[id] === "degraded" || phaseState[id] === "failed" ? <CircleX size={10} /> : phaseState[id] === "running" ? <span /> : index + 1}</i><span><b>{label}</b><small>{phaseState[id] === "running" ? "正在处理" : phaseState[id] === "done" ? "已形成可检查产物" : phaseState[id] === "degraded" ? "已保留部分产物，需修复" : phaseState[id] === "failed" ? "分支未完成" : "等待上游 Barrier"}</small></span></div>)}</div>
        <div className="cold-run-log">
          {events.length === 0 ? <div className="cold-log-empty"><SearchCheck size={20} /><span>开始后，这里会实时展示来源资格、工作项队列、任务屏障、定点补研、证据绑定和包编译。</span></div> : events.map((event) => <div className={`cold-log ${event.payload.degraded || event.kind === "build.work_item.failed" || event.kind === "build.audit.issue.created" || event.kind === "build.inspection.finding.created" ? "attention" : ""}`} key={`${event.seq}:${event.kind}`}><i>{event.seq}</i><span><b>{buildKindLabels[event.kind] || event.kind}</b><small>{profileLabel(event.profile)} · {buildEventDetail(event)}</small></span></div>)}
          {Object.values(reasoning).some(Boolean) ? <details className="cold-reasoning" open><summary><Sparkles size={12} />模型思考过程 <span>{running ? "按工作项实时生成" : "本轮已结束"}</span></summary>{Object.entries(reasoning).filter(([, value]) => value).map(([lane, value]) => <section key={lane}><b>{laneLabel(lane)} <small>{lane}</small></b><pre>{value}</pre></section>)}</details> : null}
        </div>
        <footer>{running ? <><Pause size={12} />正在研究并完善完整首版；预览不代表已交付。</> : result ? <><Layers3 size={12} />已保留 {result.sources.assets.length} 个来源与研究记录；{result.deliveryReadiness?.ready ? "完整首版已通过交付检查。" : "可补充材料并发起下一轮研究，已有草稿不会作为正式完成版本。"}</> : webResearch ? "等待使用已配置的联网厂商开始研究。" : "联网已关闭；仅使用用户资料构建。"}</footer>
      </aside>
    </Shell>
  );
}

function ColdEmpty({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="cold-empty">{icon}<h3>{title}</h3><p>{detail}</p></div>;
}
