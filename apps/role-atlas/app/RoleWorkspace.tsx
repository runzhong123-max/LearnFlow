"use client";

import {
  AlertTriangle,
  BookOpenCheck,
  Check,
  CircleUserRound,
  CircleX,
  FileSearch,
  FolderKanban,
  GitBranch,
  GripVertical,
  Layers3,
  MessageCircle,
  MessageSquareText,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph as G6Graph, IElementDragEvent, IElementEvent } from "@antv/g6";
import type { AgentEvent } from "@/lib/agent/events";
import type { BuildEvent } from "@/lib/build/events";
import { PROVIDERS, PROVIDER_SESSION_KEY, type ProviderConfig } from "@/lib/providers";
import EvidenceSourceView, { type EvidenceSourceItem } from "@/app/components/EvidenceSourceView";
import MarkdownContent from "@/app/components/MarkdownContent";
import RoleCardView, { type RoleCardNode } from "@/app/components/RoleCardView";
import TaskWorkspace, { type TaskPerspective } from "@/app/components/TaskWorkspace";
import WorkspaceSkillLauncher from "@/app/components/WorkspaceSkillLauncher";
import IterationWorkspace from "@/app/snapshots/[snapshotId]/iterate/IterationWorkspace";
import WorkspaceUpgradeWorkspace from "@/app/snapshots/[snapshotId]/workspace/WorkspaceUpgradeWorkspace";
import ColdStartWorkspace from "@/app/projects/new/ColdStartWorkspace";
import ModelSettings from "@/app/settings/ModelSettings";
import InlineRegistryCenter from "@/app/components/InlineRegistryCenter";
import InlineVersionCenter from "@/app/components/InlineVersionCenter";
import ProjectManagement from "@/app/components/ProjectManagement";
import { toProcessReference, type ProcessReferenceNode, type WorkProcessPayload } from "@/app/components/WorkProcessForestView";
import type { ColdStartBuildResult, LearningPathGraphInput } from "@/lib/build/types";
import { projectGraphPayload, projectObjectIndex, projectWorkProcessPayload } from "@/lib/projects/presentation";
import type { StoredProjectSummary } from "@/lib/projects/repository";
import type { RuntimeConfigStatus } from "@/lib/runtime-config";
import { SEARCH_PROVIDER_SESSION_KEY, type SearchProviderConfig } from "@/lib/search/providers";
import type { WorkspaceSkillId } from "@/lib/skills/workspace";
import { graphFocusStates } from "@/lib/hub/graph-focus";
import { readLearnFlowLaunchResponse } from "@/lib/integrations/learnflow/launch-response";

type RoleNode = RoleCardNode;

type RoleEdge = {
  id: string;
  type: string;
  source: string;
  target: string;
  lifecycle: "accepted" | "candidate" | "deprecated";
};

type GraphPayload = {
  metadata: { snapshot_id?: string; snapshot_version: string; generated_at: string };
  nodes: RoleNode[];
  edges: RoleEdge[];
};

type ObjectUnit = {
  target_id: string;
  object_type: string;
  lifecycle: string;
  binding_refs: string[];
  field_states: Array<{ field_path?: string; field_paths?: string[]; state?: string }>;
  related_ids: string[];
  payload: Record<string, unknown>;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  references?: RoleNode[];
  activities?: Activity[];
  citations?: CitationView[];
  status?: "running" | "done" | "failed" | "cancelled";
};

type Activity = {
  id: string;
  label: string;
  detail: string;
  status: "running" | "done" | "failed";
};

type CitationView = {
  handle: string;
  targetId: string;
  label: string;
  lifecycle: string;
  confidence: number;
  sourceIds: string[];
  sourceTitles: string[];
  temporalStatus: string;
  artifactKind?: "role_semantic" | "work_process";
  knowledgeState?: string;
};

type PackageStatus = {
  packageId: string;
  packageVersion: string;
  snapshotId: string;
  snapshotAsOf: string;
  publishable: boolean;
  workProcess?: {
    packageId: string;
    packageVersion: string;
    snapshotId: string;
    status: string;
  };
};

type ConversationSummary = { id: string; title: string; snapshotId: string | null; versionId: string | null; updatedAt: string };
type ProjectWorkspaceEnvelope = {
  project: { title: string; status: "draft" | "building" | "ready" | "failed" };
  conversations: ConversationSummary[];
  result: ColdStartBuildResult | null;
};

type ViewKey = "semantic" | "tasks" | "cards" | "evidence";
type SemanticDensity = "kernel" | "complete";
type WorkspaceOperation = WorkspaceSkillId | "new-project" | "versions" | "registry" | "settings";

const viewOptions: Array<{ key: ViewKey; label: string }> = [
  { key: "semantic", label: "总雷达" },
  { key: "tasks", label: "典型任务" },
  { key: "cards", label: "卡片总览" },
  { key: "evidence", label: "来源证据" },
];

const typeLabels: Record<string, string> = {
  market_role: "岗位",
  industry_chain_node: "产业链",
  job_family: "岗位群",
  occupation_standard: "职业标准",
  related_role: "关联岗位",
  task: "典型任务",
  capability: "抽象能力",
  capability_unit: "能力单元",
  knowledge_skill: "知识技能",
  scenario: "工作场景",
  event: "工作事件",
  artifact: "交付物",
  actor: "参与者",
};

const palettes: Record<string, { fill: string; stroke: string; label: string }> = {
  market_role: { fill: "#24342c", stroke: "#17251e", label: "#17231d" },
  industry_chain_node: { fill: "#dce7eb", stroke: "#809ba8", label: "#435d68" },
  job_family: { fill: "#dce7eb", stroke: "#809ba8", label: "#435d68" },
  occupation_standard: { fill: "#dce7eb", stroke: "#809ba8", label: "#435d68" },
  related_role: { fill: "#dce7eb", stroke: "#809ba8", label: "#435d68" },
  task: { fill: "#f6d9cf", stroke: "#c97759", label: "#884631" },
  capability: { fill: "#e5ddea", stroke: "#927da0", label: "#66566f" },
  capability_unit: { fill: "#eee9f0", stroke: "#b4a2bc", label: "#6e6175" },
  knowledge_skill: { fill: "#dce9df", stroke: "#72927b", label: "#42634c" },
};

const toolLabels: Record<string, string> = {
  get_role_overview: "读取岗位全貌",
  get_role_package_status: "读取岗位包状态",
  read_role_objects: "精确读取引用节点",
  resolve_role_targets: "解析岗位对象",
  search_role_knowledge: "检索岗位知识",
  query_role_graph: "查询图谱关系",
  trace_role_paths: "追踪语义路径",
  read_task_bundle: "组装任务上下文",
  project_role_view: "生成岗位视图",
  compare_role_objects: "按维度比较对象",
  inspect_role_evidence: "追溯证据链",
  audit_role_snapshot: "扫描岗位快照健康",
  read_work_scenarios: "读取工作场景",
  trace_work_process: "追踪事理过程",
  inspect_role_process_alignment: "检查任务—过程覆盖",
  audit_role_package: "审计岗位包",
};

const initialMessages: Message[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "我会固定当前岗位包版本，再按问题读取语义对象、工作过程与证据。运行计划、工具、耗时和引用会实时展示；供应商返回的推理通道可按需展开。",
    status: "done",
  },
];

const LOCAL_SAMPLE_SESSION_ID = "local:bundled-role-package";

function eventDetail(event: AgentEvent) {
  const payload = event.payload;
  if (event.kind === "snapshot.pinned") return `岗位包 v${String(payload.packageVersion || "")} · ${String(payload.snapshotAsOf || "")}`;
  if (event.kind === "plan.created") return `${Number(payload.callCount || 0)} 个有目的的工具调用`;
  if (event.kind === "coverage.checked") return `${Number(payload.citationCount || 0)} 条可用引用 · ${payload.complete ? "覆盖完整" : "部分覆盖"}`;
  if (event.kind === "context.assembled") return `${Number(payload.semanticCitations || 0)} 条语义引用 · ${Number(payload.processCitations || 0)} 条事理引用`;
  if (event.kind === "reasoning.completed") return Number(payload.chars || 0) > 0 ? `${Number(payload.chars)} 字符` : "供应商未返回 reasoning_content";
  return "";
}

function shortLabel(label: string, ring: number) {
  const limit = ring <= 2 ? 13 : 10;
  return label.length > limit ? `${label.slice(0, limit)}…` : label;
}

function toReadableValue(value: unknown) {
  if (Array.isArray(value)) return value.slice(0, 3).join("、");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export default function RoleWorkspace({ projectId, initialConversationId }: { projectId?: string; initialConversationId?: string }) {
  const [graphData, setGraphData] = useState<GraphPayload | null>(null);
  const [workProcessData, setWorkProcessData] = useState<WorkProcessPayload | null>(null);
  const [objectIndex, setObjectIndex] = useState<Map<string, ObjectUnit>>(new Map());
  const [selectedId, setSelectedId] = useState("role:llm-app-engineer");
  const [hoveredNodeId, setHoveredNodeId] = useState("");
  const [view, setView] = useState<ViewKey>("semantic");
  const [semanticDensity, setSemanticDensity] = useState<SemanticDensity>("kernel");
  const [activeTaskId, setActiveTaskId] = useState("");
  const [taskPerspective, setTaskPerspective] = useState<TaskPerspective>("relations");
  const [evidenceScope, setEvidenceScope] = useState<{ sourceIds: string[]; label: string }>({ sourceIds: [], label: "" });
  const [references, setReferences] = useState<RoleNode[]>([]);
  const [draggingNode, setDraggingNode] = useState<RoleNode | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [detailOpen, setDetailOpen] = useState(true);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [packageStatus, setPackageStatus] = useState<PackageStatus | null>(null);
  const [launchReleaseId, setLaunchReleaseId] = useState("");
  const [launchingLearnFlow, setLaunchingLearnFlow] = useState(false);
  const [learnFlowLaunchError, setLearnFlowLaunchError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [modelSummary, setModelSummary] = useState<{ configured: boolean; label: string }>({ configured: false, label: "未配置模型" });
  const [isRunning, setIsRunning] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(Boolean(projectId));
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [projects, setProjects] = useState<StoredProjectSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState(initialConversationId || "");
  const [workspaceTitle, setWorkspaceTitle] = useState("大模型应用工程师");
  const [projectResult, setProjectResult] = useState<ColdStartBuildResult | null>(null);
  const [projectStatus, setProjectStatus] = useState<"draft" | "building" | "ready" | "failed">("draft");
  const [enrichmentState, setEnrichmentState] = useState<{ running: boolean; label: string; error?: string }>({ running: false, label: "" });
  const [activeOperation, setActiveOperation] = useState<WorkspaceOperation | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<G6Graph | null>(null);
  const dropRef = useRef<HTMLElement>(null);
  const draggedRef = useRef<RoleNode | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conversationLoadRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const enrichmentRunRef = useRef(false);
  const taskUrlHydratedRef = useRef(false);

  const applyProjectWorkspace = useCallback((workspace: ProjectWorkspaceEnvelope) => {
    if (!workspace.result) throw new Error("项目尚未形成可读取的候选岗位包。");
    const result = workspace.result;
    setProjectResult(result);
    setProjectStatus(workspace.project.status);
    setWorkspaceTitle(workspace.project.title);
    setGraphData(projectGraphPayload(result) as GraphPayload);
    setWorkProcessData(projectWorkProcessPayload(result));
    const units = projectObjectIndex(result) as ObjectUnit[];
    setObjectIndex(new Map(units.map((unit) => [unit.target_id, unit])));
    setConversations(workspace.conversations);
    const role = result.semantic.nodes.find((node) => node.type === "market_role");
    const firstTask = result.semantic.nodes.find((node) => node.type === "task");
    if (role) setSelectedId(role.id);
    if (firstTask) setActiveTaskId(firstTask.id);
    setPackageStatus({
      packageId: result.packages.rolePackage.packageId,
      packageVersion: result.packages.rolePackage.packageVersion,
      snapshotId: result.snapshot.id,
      snapshotAsOf: result.snapshot.asOf,
      publishable: result.validation.publishable,
      workProcess: {
        packageId: result.packages.rolePackage.packageId,
        packageVersion: result.packages.rolePackage.packageVersion,
        snapshotId: result.packages.rolePackage.snapshotId,
        status: result.packages.rolePackage.status,
      },
    });
  }, []);

  async function fetchConversationMessages(conversationId: string, signal?: AbortSignal) {
    const response = await fetch(`/api/conversations/${conversationId}/messages`, { signal });
    if (!response.ok) throw new Error("会话历史读取失败。");
    const payload = await response.json() as { messages?: Array<Record<string, unknown>> };
    const restored = (payload.messages || []).map((message): Message => ({
      id: String(message.id || crypto.randomUUID()),
      role: message.role === "user" ? "user" : "assistant",
      text: String(message.text || ""),
      reasoning: String(message.reasoning || ""),
      references: Array.isArray(message.references) ? message.references as RoleNode[] : [],
      activities: Array.isArray(message.activities) ? message.activities as Activity[] : [],
      citations: Array.isArray(message.citations) ? message.citations as CitationView[] : [],
      status: ["running", "done", "failed", "cancelled"].includes(String(message.status)) ? message.status as Message["status"] : "done",
    }));
    return restored.length ? restored : initialMessages;
  }

  useEffect(() => {
    const controller = new AbortController();
    const fetchChecked = async (url: string, format: "json" | "text") => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
      return format === "json" ? response.json() : response.text();
    };
    if (projectId) {
      Promise.all([
        fetchChecked(`/api/projects/${projectId}${initialConversationId ? `?conversation=${encodeURIComponent(initialConversationId)}` : ""}`, "json"),
        fetchChecked("/api/projects", "json"),
      ]).then(async ([workspaceEnvelope, projectEnvelope]) => {
        const workspace = workspaceEnvelope as ProjectWorkspaceEnvelope;
        applyProjectWorkspace(workspace);
        setProjects((projectEnvelope as { projects?: StoredProjectSummary[] }).projects || []);
        const conversationId = initialConversationId && workspace.conversations.some((item) => item.id === initialConversationId)
          ? initialConversationId
          : workspace.conversations[0]?.id || "";
        setActiveConversationId(conversationId);
        sessionIdRef.current = conversationId;
        if (conversationId) setMessages(await fetchConversationMessages(conversationId, controller.signal));
      }).catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setWorkspaceError(error.message || "项目装载失败。");
      }).finally(() => setConversationLoading(false));
      return () => controller.abort();
    }
    Promise.all([
      fetchChecked("/data/graph.json", "json"),
      fetchChecked("/data/object-index.jsonl", "text"),
      fetchChecked("/api/role-tools", "json"),
      fetchChecked("/api/work-process", "json"),
      fetchChecked("/api/projects", "json").catch(() => ({ projects: [] })),
    ]).then(([graph, indexText, statusEnvelope, processPayload, projectEnvelope]) => {
      setGraphData(graph as GraphPayload);
      setWorkProcessData(processPayload as WorkProcessPayload);
      const units = (indexText as string)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ObjectUnit);
      setObjectIndex(new Map(units.map((unit) => [unit.target_id, unit])));
      setProjects((projectEnvelope as { projects?: StoredProjectSummary[] }).projects || []);
      const data = (statusEnvelope as { data?: Record<string, unknown> }).data;
      if (data) {
        setPackageStatus({
          packageId: String(data.packageId || ""),
          packageVersion: String(data.packageVersion || ""),
          snapshotId: String(data.snapshotId || ""),
          snapshotAsOf: String(data.snapshotAsOf || ""),
          publishable: Boolean(data.publishable),
          workProcess: data.workProcess as PackageStatus["workProcess"],
        });
      }
    }).catch((error) => {
      if (error instanceof Error && error.name !== "AbortError") setWorkspaceError("岗位包装载失败，请检查同步产物和服务状态。");
    });
    return () => controller.abort();
  }, [applyProjectWorkspace, initialConversationId, projectId]);

  useEffect(() => {
    if (!packageStatus?.snapshotId) return;
    const controller = new AbortController();
    fetch("/api/registry", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("岗位包 Release 读取失败");
        return response.json() as Promise<{ packages?: Array<{ recommendedReleaseId: string | null; releases: Array<{ id: string; snapshotId: string }> }> }>;
      })
      .then((payload) => {
        const line = (payload.packages || []).find((item) => item.releases.some((release) => (
          release.id === item.recommendedReleaseId && release.snapshotId === packageStatus.snapshotId
        )));
        const release = line?.releases.find((item) => item.id === line.recommendedReleaseId);
        setLaunchReleaseId(release?.id || "");
      })
      .catch((error) => { if (error instanceof Error && error.name !== "AbortError") setLaunchReleaseId(""); });
    return () => controller.abort();
  }, [packageStatus?.snapshotId]);

  const launchInLearnFlow = async () => {
    if (!launchReleaseId || launchingLearnFlow) return;
    setLearnFlowLaunchError("");
    setLaunchingLearnFlow(true);
    try {
      const response = await fetch("/api/integrations/learnflow/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ releaseId: launchReleaseId, source: "role_atlas" }),
        signal: AbortSignal.timeout(15_000),
      });
      window.location.assign(await readLearnFlowLaunchResponse(response));
    } catch (error) {
      setLearnFlowLaunchError(error instanceof Error && error.name === "TimeoutError"
        ? "连接 LearnFlow 超时，请稍后重试。"
        : error instanceof TypeError ? "无法连接 LearnFlow，请检查网络后重试。"
        : error instanceof Error ? error.message : "无法进入 LearnFlow，请稍后重试。");
    } finally {
      setLaunchingLearnFlow(false);
    }
  };

  useEffect(() => {
    if (!projectId || !projectResult || enrichmentRunRef.current) return;
    const enrichment = projectResult.build?.enrichment;
    if (!enrichment || !["queued", "running"].includes(enrichment.status)) return;
    const conversationId = activeConversationId || initialConversationId || conversations[0]?.id;
    if (!conversationId) return;
    const pendingKey = `role-atlas.pending-enrichment:${projectId}`;
    let pending: { baseSnapshotId?: string; enrichmentRunId?: string; roleTitle?: string; roleDescription?: string; market?: string; webResearch?: boolean } = {};
    try { pending = JSON.parse(sessionStorage.getItem(pendingKey) || "{}") as typeof pending; }
    catch { sessionStorage.removeItem(pendingKey); }
    const baseSnapshotId = pending.baseSnapshotId || enrichment.baseSnapshotId || projectResult.snapshot.id;
    let providerConfig: ProviderConfig | undefined;
    let searchConfig: SearchProviderConfig | undefined;
    try {
      providerConfig = JSON.parse(sessionStorage.getItem(PROVIDER_SESSION_KEY) || "null") as ProviderConfig | undefined;
      searchConfig = JSON.parse(sessionStorage.getItem(SEARCH_PROVIDER_SESSION_KEY) || "null") as SearchProviderConfig | undefined;
    } catch {
      setEnrichmentState({ running: false, label: "后台增量等待有效的模型或搜索配置", error: "会话配置无法解析" });
      return;
    }
    enrichmentRunRef.current = true;
    setProjectStatus("building");
    setEnrichmentState({ running: true, label: "正在后台生成能力、知识技能依赖与事理森林" });
    const runId = pending.enrichmentRunId || `${crypto.randomUUID()}:enrichment`;
    if (!pending.enrichmentRunId) {
      pending.enrichmentRunId = runId;
      sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    }
    void (async () => {
      try {
        const learningPathGraph = await fetch("/data/learnflow-learning-path.json")
          .then(async (pathResponse) => pathResponse.ok ? await pathResponse.json() as LearningPathGraphInput : undefined)
          .catch(() => undefined);
        const response = await fetch("/api/build-runs/enrich", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            build: {
              runId,
              projectId,
              roleTitle: pending.roleTitle || projectResult.brief.roleTitle,
              roleDescription: pending.roleDescription ?? projectResult.brief.roleDescription,
              market: pending.market || projectResult.brief.market,
              audience: projectResult.brief.audience,
              snapshotAsOf: projectResult.snapshot.asOf,
              sources: [],
              learningPathGraph,
            },
            baseSnapshotId,
            conversationId,
            providerConfig,
            searchConfig,
            webResearch: pending.webResearch ?? Boolean(projectResult.sources.research),
          }),
        });
        if (!response.ok || !response.body) {
          const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
          if (response.status === 409 && (payload.code === "ENRICHMENT_ALREADY_RUNNING" || payload.code === "ENRICHMENT_ALREADY_COMPLETED")) {
            setEnrichmentState({ running: true, label: payload.code === "ENRICHMENT_ALREADY_RUNNING" ? "后台增量仍在运行，正在重新接入版本进度" : "后台增量已完成，正在载入最新版本" });
            for (let attempt = 0; attempt < 180; attempt += 1) {
              const workspaceResponse = await fetch(`/api/projects/${encodeURIComponent(projectId)}?conversation=${encodeURIComponent(conversationId)}`);
              if (workspaceResponse.ok) {
                const workspace = await workspaceResponse.json() as ProjectWorkspaceEnvelope;
                applyProjectWorkspace(workspace);
                const status = workspace.result?.build?.enrichment?.status;
                if (status === "complete" || status === "degraded" || !["queued", "running"].includes(String(status))) {
                  sessionStorage.removeItem(pendingKey);
                  setEnrichmentState({ running: false, label: status === "degraded" ? "后台增量已完成，部分分支保留为研究缺口" : "后台增量完成，已切换到最新不可变版本" });
                  return;
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 2_000));
            }
            throw new Error("后台增量仍在运行，可稍后重新打开项目查看最新版本。");
          }
          throw new Error(payload.error || `后台增量请求失败（${response.status}）`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const refresh = async () => {
          const workspaceResponse = await fetch(`/api/projects/${encodeURIComponent(projectId)}?conversation=${encodeURIComponent(conversationId)}`);
          if (!workspaceResponse.ok) return;
          applyProjectWorkspace(await workspaceResponse.json() as ProjectWorkspaceEnvelope);
        };
        const applyBuildEvent = async (event: BuildEvent) => {
          if (event.kind === "build.targeted_research.started") setEnrichmentState({ running: true, label: "正在为知识技能缺口定点补研" });
          else if (event.kind === "build.work_item.started") {
            const item = event.payload.workItem as { stage?: string } | undefined;
            if (item?.stage === "skill-dependency-derivation") setEnrichmentState({ running: true, label: "正在判定知识技能前置与共生关系" });
            else if (item?.stage === "task-process-expansion") setEnrichmentState({ running: true, label: "正在按任务并行展开事理场景" });
          } else if (event.kind === "build.enrichment.semantic.completed") {
            setEnrichmentState({ running: true, label: "知识技能与依赖子版本已形成；事理森林继续生成" });
            await refresh();
          } else if (event.kind === "build.enrichment.process.completed") {
            setEnrichmentState({ running: true, label: "事理森林已形成；正在执行跨产物结构检查" });
          } else if (event.kind === "build.run.completed") {
            sessionStorage.removeItem(pendingKey);
            setEnrichmentState({ running: true, label: "完整冷启动版本已形成；正在选择 3—5 个重要问题做深度研究" });
            await refresh();
          } else if (event.kind === "build.followup.deep_research.started") {
            setEnrichmentState({ running: true, label: "正在选择 3—5 个重要问题做深度研究" });
          } else if (event.kind === "build.followup.deep_research.completed") {
            setEnrichmentState({ running: true, label: "重要问题深度研究完成；正在准备全量风险修复" });
            await refresh();
          } else if (event.kind === "build.followup.deep_research.skipped") {
            setEnrichmentState({ running: true, label: "重要问题深研未完成；仍将继续执行全量风险修复", error: String(event.payload.message || "深研未执行") });
          } else if (event.kind === "build.followup.risk_repair.started") {
            setEnrichmentState({ running: true, label: "正在执行全量风险扫描与可验证修复" });
          } else if (event.kind === "build.followup.risk_repair.completed") {
            setEnrichmentState({ running: false, label: event.payload.deepResearchStatus === "completed" ? "冷启动、重要问题深研与全量风险修复均已完成" : "冷启动与全量风险修复已完成；重要问题深研仍需补做" });
            await refresh();
          } else if (event.kind === "build.followup.failed") {
            setEnrichmentState({ running: false, label: "完整冷启动版本可用；自动深研或风险修复尚未完成", error: String(event.payload.message || "自动后处理失败") });
            await refresh();
          } else if (event.kind === "build.run.failed") {
            setEnrichmentState({ running: false, label: "后台增量暂停；岗位内核仍可使用", error: String(event.payload.message || "增量失败") });
          }
        };
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines.filter(Boolean)) await applyBuildEvent(JSON.parse(line) as BuildEvent);
          if (done) break;
        }
        if (buffer.trim()) await applyBuildEvent(JSON.parse(buffer) as BuildEvent);
      } catch (error) {
        setEnrichmentState({ running: false, label: "后台增量暂停；岗位内核仍可使用", error: error instanceof Error ? error.message : "未知错误" });
      }
    })();
  }, [activeConversationId, applyProjectWorkspace, conversations, initialConversationId, projectId, projectResult]);

  useEffect(() => () => conversationLoadRef.current?.abort(), []);

  useEffect(() => {
    if (!projectId) sessionIdRef.current = LOCAL_SAMPLE_SESSION_ID;
  }, [projectId]);

  useEffect(() => {
    if (projectId) sessionIdRef.current = activeConversationId;
  }, [activeConversationId, projectId]);

  useEffect(() => {

    const rawProvider = sessionStorage.getItem(PROVIDER_SESSION_KEY);
    if (rawProvider) {
      try {
        const config = JSON.parse(rawProvider) as ProviderConfig;
        const definition = PROVIDERS[config.provider];
        const model = definition?.models.find((item) => item.id === config.model);
        if (definition && model && config.apiKey) {
          if (!config.thinking) sessionStorage.setItem(PROVIDER_SESSION_KEY, JSON.stringify({ ...config, thinking: true }));
          setModelSummary({ configured: true, label: `${definition.name} · ${model.label}` });
          return;
        }
      } catch {
        sessionStorage.removeItem(PROVIDER_SESSION_KEY);
      }
    }
    const controller = new AbortController();
    fetch("/api/runtime-config", { signal: controller.signal })
      .then((response) => response.json() as Promise<RuntimeConfigStatus>)
      .then((status) => {
        if (!status.model.configured) return;
        const definition = PROVIDERS[status.model.provider];
        const model = definition.models.find((item) => item.id === status.model.model);
        setModelSummary({ configured: true, label: `${definition.name} · ${model?.label || status.model.model} · 开发环境` });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages]);

  const nodeMap = useMemo(
    () => new Map((graphData?.nodes ?? []).map((node) => [node.id, node])),
    [graphData],
  );
  const processNodeMap = useMemo(() => {
    if (!workProcessData) return new Map<string, ProcessReferenceNode>();
    const items = [...workProcessData.workProcess.scenarios, ...workProcessData.workProcess.nodes];
    return new Map(items.map((item) => [item.id, toProcessReference(item, workProcessData)]));
  }, [workProcessData]);
  const selectedNode = nodeMap.get(selectedId) ?? processNodeMap.get(selectedId) ?? null;
  const selectedObject = selectedNode ? objectIndex.get(selectedNode.id) : null;
  const evidenceSources = useMemo<EvidenceSourceItem[]>(() => {
    if (projectResult) {
      return projectResult.sources.assets.map((source) => ({
        id: source.id,
        title: source.title,
        kind: source.kind,
        tier: source.sourceTier,
        status: source.qualification?.status,
        asOf: source.publishedAt || source.observedAt || source.fetchedAt,
        locator: source.locator,
        discovery: source.queryIds?.length
          ? `由 ${source.queryIds.length} 个研究查询发现 · ${source.extractionMethod === "provider_extract" ? "定向抽取" : source.extractionMethod === "direct_fetch" ? "原页抓取" : "搜索内容"}`
          : source.kind === "user_brief" ? "用户项目简报" : "用户提供资料",
      }));
    }
    return [...objectIndex.values()]
      .filter((unit) => unit.object_type === "source")
      .map((unit) => ({
        id: unit.target_id,
        title: String(unit.payload.title || unit.target_id),
        kind: String(unit.payload.kind || "source"),
        tier: String(unit.payload.claim_use || ""),
        status: String(unit.payload.capture_status || ""),
        asOf: String(unit.payload.as_of || ""),
        locator: typeof unit.payload.url === "string" ? unit.payload.url : undefined,
        note: typeof unit.payload.note === "string" ? unit.payload.note : undefined,
      }));
  }, [objectIndex, projectResult]);

  const filteredData = useMemo(() => {
    if (!graphData) return null;
    const needle = searchQuery.trim().toLowerCase();
    const nodes = graphData.nodes.filter((node) => {
      const searchMatch = needle ? `${node.label} ${node.summary} ${node.id}`.toLowerCase().includes(needle) : true;
      const projectionMatch = semanticDensity === "complete" || needle.length > 0 || node.defaultVisibility !== false;
      return searchMatch && projectionMatch;
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: graphData.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    };
  }, [graphData, searchQuery, semanticDensity]);

  const taskNodes = useMemo(() => (graphData?.nodes || []).filter((node) => node.type === "task"), [graphData]);

  const updateTaskLocation = useCallback((taskId: string, perspective: TaskPerspective) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("task", taskId);
    url.searchParams.set("taskView", perspective);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const openTask = useCallback((node: RoleNode, perspective: TaskPerspective = "relations") => {
    if (node.type !== "task") return;
    setActiveTaskId(node.id);
    setSelectedId(node.id);
    setTaskPerspective(perspective);
    setDetailOpen(false);
    setView("tasks");
    setSearchQuery("");
    updateTaskLocation(node.id, perspective);
  }, [updateTaskLocation]);

  const changeTaskPerspective = useCallback((perspective: TaskPerspective) => {
    setTaskPerspective(perspective);
    if (activeTaskId) updateTaskLocation(activeTaskId, perspective);
  }, [activeTaskId, updateTaskLocation]);

  const openEvidenceFor = useCallback((nodes: RoleNode[]) => {
    const sourceIds = [...new Set(nodes.flatMap((node) => node.evidence_summary.source_refs))];
    const task = nodes.find((node) => node.type === "task") || nodes[0];
    setEvidenceScope({ sourceIds, label: task?.label || "所选岗位对象" });
    setSearchQuery("");
    setView("evidence");
  }, []);

  useEffect(() => {
    if (!taskNodes.length) return;
    if (!taskNodes.some((task) => task.id === activeTaskId)) setActiveTaskId(taskNodes[0].id);
    if (taskUrlHydratedRef.current) return;
    taskUrlHydratedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const taskId = params.get("task") || "";
    const task = taskNodes.find((item) => item.id === taskId);
    if (!task) return;
    const perspective = params.get("taskView") === "process" ? "process" : "relations";
    setActiveTaskId(task.id);
    setSelectedId(task.id);
    setTaskPerspective(perspective);
    setDetailOpen(false);
    setView("tasks");
  }, [activeTaskId, taskNodes]);

  const addReference = useCallback((node: RoleNode) => {
    setReferences((current) => current.some((item) => item.id === node.id) ? current : [...current, node]);
  }, []);

  const selectCardNode = useCallback((node: RoleNode) => {
    if (node.type === "task") {
      openTask(node);
      return;
    }
    setSelectedId(node.id);
    setDetailOpen(false);
  }, [openTask]);

  const startCardDrag = useCallback((node: RoleNode) => {
    draggedRef.current = node;
    setDraggingNode(node);
  }, []);

  const endCardDrag = useCallback(() => {
    draggedRef.current = null;
    setDraggingNode(null);
  }, []);

  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      const dragged = draggedRef.current;
      if (!dragged) return;
      const dropArea = dropRef.current?.getBoundingClientRect();
      if (!conversationLoading && dropArea && event.clientX >= dropArea.left && event.clientX <= dropArea.right && event.clientY >= dropArea.top && event.clientY <= dropArea.bottom) {
        addReference(dragged);
      }
      draggedRef.current = null;
      setDraggingNode(null);
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, [addReference, conversationLoading]);

  useEffect(() => {
    const currentData = filteredData;
    if (view !== "semantic") return;
    if (!currentData || !containerRef.current) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    async function renderGraph(currentData: NonNullable<typeof filteredData>) {
      const { Graph, NodeEvent } = await import("@antv/g6");
      if (disposed || !containerRef.current) return;

      graphRef.current?.destroy?.();
      const width = Math.max(containerRef.current.clientWidth, 520);
      const height = Math.max(containerRef.current.clientHeight, 500);
      const centerX = width / 2;
      const centerY = height / 2;
      const maxRadius = Math.max(220, Math.min(width, height) * 0.43);
      const byRing = new Map<number, RoleNode[]>();
      currentData.nodes.forEach((node) => {
        byRing.set(node.ring, [...(byRing.get(node.ring) ?? []), node]);
      });

      const positionedNodes = currentData.nodes.map((node) => {
        const peers = byRing.get(node.ring) ?? [node];
        const index = peers.findIndex((peer) => peer.id === node.id);
        const radius = node.ring === 0 ? 0 : maxRadius * (0.28 + node.ring * 0.14);
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / peers.length + (node.ring % 2 ? 0.08 : 0);
        const palette = palettes[node.type] ?? palettes.market_role;
      return {
          id: node.id,
          type: "circle",
          data: { roleNode: node },
          style: {
            x: centerX + Math.cos(angle) * radius,
            y: centerY + Math.sin(angle) * radius,
            size: node.ring === 0 ? 62 : node.ring <= 2 ? 22 : 16,
            fill: palette.fill,
            stroke: node.lifecycle === "candidate" ? "#a97959" : palette.stroke,
            lineWidth: node.ring === 0 ? 4 : 1.5,
            lineDash: node.lifecycle === "candidate" ? [4, 3] : undefined,
            cursor: "grab" as const,
            labelText: node.ring === 0 ? workspaceTitle : shortLabel(node.label, node.ring),
            labelPlacement: (node.ring === 0 ? "center" : "bottom") as "center" | "bottom",
            labelFill: node.ring === 0 ? "#f8f5eb" : palette.label,
            labelFontSize: node.ring === 0 ? 12 : node.ring <= 2 ? 9 : 8,
            labelFontWeight: node.ring === 0 ? 700 : 600,
            labelBackground: node.ring !== 0,
            labelBackgroundFill: "#f5f2e9",
            labelBackgroundFillOpacity: 0.9,
            labelPadding: [2, 3],
          },
        };
      });

      const graph = new Graph({
        container: containerRef.current,
        width,
        height,
        data: {
          nodes: positionedNodes,
          edges: currentData.edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            data: { relationType: edge.type },
            style: {
              stroke: edge.lifecycle === "candidate" ? "#a97959" : "#a9ada8",
              opacity: edge.lifecycle === "candidate" ? 0.4 : 0.23,
              lineWidth: edge.lifecycle === "candidate" ? 1.25 : 0.75,
              lineDash: edge.lifecycle === "candidate" ? [4, 4] : undefined,
              endArrow: true,
            },
          })),
        },
        behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
        node: {
          state: {
            selected: { halo: true, haloStroke: "#da6d4d", haloLineWidth: 7, haloStrokeOpacity: 0.22, labelFontSize: 12 },
            related: { opacity: 1, labelFontSize: 11 },
            inactive: { opacity: 0.16 },
          },
          animation: false,
        },
        edge: { animation: false, state: { related: { opacity: 0.95, lineWidth: 2, stroke: "#347b68" }, inactive: { opacity: 0.06 } } },
        animation: false,
      });

      graph.on(NodeEvent.CLICK, (event: IElementEvent) => {
        const id = String(event.target?.id ?? "");
        const node = nodeMap.get(id);
        if (!node) return;
        if (node.type === "task") {
          openTask(node);
          return;
        }
        setSelectedId(id);
        setDetailOpen(true);
      });
      graph.on(NodeEvent.DRAG_START, (event: IElementDragEvent) => {
        const id = String(event.target?.id ?? "");
        const node = nodeMap.get(id);
        if (!node) return;
        draggedRef.current = node;
        setDraggingNode(node);
      });
      graph.on(NodeEvent.POINTER_ENTER, (event: IElementEvent) => setHoveredNodeId(String(event.target?.id || "")));
      graph.on(NodeEvent.POINTER_LEAVE, () => setHoveredNodeId(""));
      graph.on(NodeEvent.DRAG_END, () => {
        window.setTimeout(() => {
          draggedRef.current = null;
          setDraggingNode(null);
        }, 80);
      });

      await graph.render();
      graphRef.current = graph;
      const roleNode = currentData.nodes.find((node) => node.type === "market_role");
      if (roleNode) await graph.setElementState(roleNode.id, ["selected"], false);

      resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current) return;
        graph.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      });
      resizeObserver.observe(containerRef.current);
    }

    void renderGraph(currentData);
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      graphRef.current?.destroy?.();
      graphRef.current = null;
    };
  }, [filteredData, nodeMap, openTask, view, workspaceTitle]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !filteredData) return;
    const focusId = hoveredNodeId || (nodeMap.get(selectedId)?.type === "market_role" ? "" : selectedId);
    const states = graphFocusStates(filteredData.nodes, filteredData.edges, focusId);
    graph.setElementState(states, false).catch(() => undefined);
  }, [filteredData, selectedId, hoveredNodeId, nodeMap]);

  function selectAndFocus(node: RoleNode) {
    if (node.type === "task") {
      openTask(node);
      return;
    }
    setSelectedId(node.id);
    if (processNodeMap.has(node.id)) {
      const processNode = workProcessData?.workProcess.nodes.find((item) => item.id === node.id);
      const taskId = processNode?.task_refs?.find((id) => nodeMap.get(id)?.type === "task");
      if (taskId && nodeMap.has(taskId)) {
        setActiveTaskId(taskId);
        setTaskPerspective("process");
        setView("tasks");
        updateTaskLocation(taskId, "process");
      } else setView("tasks");
    } else setView("semantic");
    setDetailOpen(true);
    graphRef.current?.focusElement?.(node.id, { duration: 260 }).catch?.(() => undefined);
  }

  function updateAssistant(messageId: string, updater: (message: Message) => Message) {
    setMessages((current) => current.map((message) => message.id === messageId ? updater(message) : message));
  }

  function upsertActivity(message: Message, activity: Activity) {
    const activities = message.activities || [];
    const existing = activities.findIndex((item) => item.id === activity.id);
    return {
      ...message,
      activities: existing < 0
        ? [...activities, activity]
        : activities.map((item, index) => index === existing ? activity : item),
    };
  }

  function applyAgentEvent(messageId: string, event: AgentEvent) {
    updateAssistant(messageId, (message) => {
      if (event.kind === "reasoning.delta") {
        return upsertActivity(
          { ...message, reasoning: `${message.reasoning || ""}${String(event.payload.delta || "")}` },
          { id: "reasoning", label: "供应商推理通道", detail: "正在接收 reasoning_content", status: "running" },
        );
      }
      if (event.kind === "reasoning.completed") {
        return upsertActivity(message, {
          id: "reasoning",
          label: "供应商推理通道",
          detail: eventDetail(event),
          status: "done",
        });
      }
      if (event.kind === "answer.delta") {
        return upsertActivity(
          { ...message, text: `${message.text}${String(event.payload.delta || "")}` },
          { id: "generation", label: "模型原样输出", detail: "正在接收 content", status: "running" },
        );
      }
      if (event.kind === "answer.completed") {
        return upsertActivity({
          ...message,
          text: message.text || String(event.payload.answer || ""),
          reasoning: message.reasoning || String(event.payload.reasoning || ""),
          status: "done",
        }, { id: "generation", label: "模型原样输出", detail: "供应商响应已完整接收", status: "done" });
      }
      if (event.kind === "citation.registry") {
        const citations = Array.isArray(event.payload.citations) ? event.payload.citations as CitationView[] : [];
        return { ...message, citations };
      }
      if (event.kind === "run.failed") {
        return upsertActivity({
          ...message,
          text: message.text || String(event.payload.message || "智能体运行失败。"),
          status: /取消/.test(String(event.payload.message || "")) ? "cancelled" : "failed",
        }, { id: "run", label: "运行未完成", detail: String(event.payload.message || ""), status: "failed" });
      }

      if (event.kind === "tool.started" || event.kind === "tool.finished" || event.kind === "tool.deduplicated") {
        const name = String(event.payload.name || "unknown");
        const done = event.kind !== "tool.started";
        const ok = event.payload.ok !== false;
        const returned = done ? `${Number(event.payload.returned || 0)} 项 · ${Number(event.payload.durationMs || 0)} ms` : "正在访问岗位包的语义或事理命名空间";
        return upsertActivity(message, {
          id: `tool:${name}`,
          label: toolLabels[name] || name,
          detail: event.kind === "tool.deduplicated" ? `复用本轮结果 · ${returned}` : returned,
          status: done ? (ok ? "done" : "failed") : "running",
        });
      }

      const activityMap: Partial<Record<AgentEvent["kind"], { id: string; label: string; status: Activity["status"] }>> = {
        "run.started": { id: "run", label: "开始分析问题", status: "done" },
        "snapshot.pinned": { id: "snapshot", label: "固定事实快照", status: "done" },
        "plan.created": { id: "plan", label: "生成检索与组装计划", status: "done" },
        "coverage.checked": { id: "coverage", label: "检查证据覆盖", status: "done" },
        "context.assembled": { id: "context", label: "组装语义与事理上下文", status: "done" },
        "generation.started": { id: "generation", label: "启动模型直出", status: "running" },
      };
      const activity = activityMap[event.kind];
      if (!activity) return message;
      return upsertActivity(message, { ...activity, detail: eventDetail(event) });
    });
  }

  async function sendMessage() {
    if (isRunning || conversationLoading) return;
    const text = chatInput.trim();
    const selectedReferences = references.length > 0 ? references : (!text && selectedNode ? [selectedNode] : []);
    if (!text && selectedReferences.length === 0) return;
    const userText = text || `请解释「${selectedReferences[0].label}」在岗位中的作用。`;
    const rawProvider = sessionStorage.getItem(PROVIDER_SESSION_KEY);
    const messageId = crypto.randomUUID();
    if (!packageStatus || (projectId && !sessionIdRef.current)) {
      const reason = !packageStatus
          ? "岗位包状态尚未装载完成，请稍后重试。"
          : "项目会话尚未装载完成，请稍后重试。";
      setMessages((current) => [...current, { id: `${messageId}:user`, role: "user", text: userText, references: selectedReferences }, { id: messageId, role: "assistant", text: reason, status: "failed" }]);
      return;
    }

    let providerConfig: ProviderConfig | undefined;
    if (rawProvider) {
      try {
        const restored = JSON.parse(rawProvider) as ProviderConfig;
        if (!restored.apiKey || !PROVIDERS[restored.provider]?.models.some((model) => model.id === restored.model)) throw new Error("invalid");
        providerConfig = restored;
      } catch {
        sessionStorage.removeItem(PROVIDER_SESSION_KEY);
        setModelSummary({ configured: false, label: "模型配置无效" });
        setMessages((current) => [...current, { id: `${messageId}:user`, role: "user", text: userText }, { id: messageId, role: "assistant", text: "模型配置无效，请重新配置。", status: "failed" }]);
        return;
      }
    }

    const history = messages
      .filter((message) => message.id !== "welcome" && message.status !== "running" && message.text)
      .slice(-10)
      .map((message) => ({ role: message.role, text: message.text.slice(0, 8000) }));
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setMessages((current) => [
      ...current,
      { id: `${messageId}:user`, role: "user", text: userText, references: selectedReferences },
      { id: messageId, role: "assistant", text: "", references: selectedReferences, activities: [], citations: [], status: "running" },
    ]);
    setChatInput("");
    setReferences([]);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          runId: crypto.randomUUID(),
          sessionId: sessionIdRef.current || crypto.randomUUID(),
          projectId,
          messageId,
          message: userText,
          references: selectedReferences.map((node) => ({
            packageId: packageStatus.packageId,
            packageVersion: packageStatus.packageVersion,
            snapshotId: packageStatus.snapshotId,
            targetId: node.id,
          })),
          history,
          providerConfig,
        }),
      });
      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error || `请求失败（${response.status}）`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          applyAgentEvent(messageId, JSON.parse(line) as AgentEvent);
        }
        if (done) break;
      }
      if (buffer.trim()) applyAgentEvent(messageId, JSON.parse(buffer) as AgentEvent);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      updateAssistant(messageId, (message) => ({
        ...message,
        text: message.text || (cancelled ? "本轮运行已由你取消，岗位包没有被修改。" : error instanceof Error ? error.message : "智能体运行失败。"),
        status: cancelled ? "cancelled" : "failed",
      }));
    } finally {
      abortRef.current = null;
      setIsRunning(false);
    }
  }

  function cancelRun() {
    abortRef.current?.abort();
  }

  async function switchConversation(conversationId: string) {
    if (isRunning || conversationLoading || !conversationId || conversationId === activeConversationId) return;
    const previousConversationId = activeConversationId;
    const previousMessages = messages;
    conversationLoadRef.current?.abort();
    const controller = new AbortController();
    conversationLoadRef.current = controller;
    setConversationLoading(true);
    setActiveConversationId(conversationId);
    sessionIdRef.current = conversationId;
    setMessages(initialMessages);
    setWorkspaceError("");
    try {
      const [workspaceResponse, restoredMessages] = await Promise.all([
        fetch(`/api/projects/${projectId}?conversation=${encodeURIComponent(conversationId)}`, { signal: controller.signal }),
        fetchConversationMessages(conversationId, controller.signal),
      ]);
      const workspace = await workspaceResponse.json() as ProjectWorkspaceEnvelope & { error?: string };
      if (!workspaceResponse.ok) throw new Error(workspace.error || "会话快照读取失败。");
      if (controller.signal.aborted) return;
      applyProjectWorkspace(workspace);
      setMessages(restoredMessages);
      if (projectId) window.history.replaceState(null, "", `/projects/${projectId}?conversation=${conversationId}`);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setActiveConversationId(previousConversationId);
        sessionIdRef.current = previousConversationId;
        setMessages(previousMessages);
        setWorkspaceError(error instanceof Error ? error.message : "会话切换失败。");
      }
    } finally {
      if (conversationLoadRef.current === controller) {
        conversationLoadRef.current = null;
        setConversationLoading(false);
      }
    }
  }

  async function createNewConversation() {
    if (!projectId || isRunning || conversationLoading) return;
    const previousConversationId = activeConversationId;
    const previousMessages = messages;
    conversationLoadRef.current?.abort();
    const controller = new AbortController();
    conversationLoadRef.current = controller;
    setConversationLoading(true);
    const id = crypto.randomUUID();
    try {
      const response = await fetch(`/api/projects/${projectId}/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ id, title: `新对话 ${conversations.length + 1}` }),
      });
      const payload = await response.json() as { conversation?: ConversationSummary; error?: string };
      if (!response.ok || !payload.conversation) throw new Error(payload.error || "新建对话失败。");
      setConversations((current) => [payload.conversation!, ...current]);
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, conversations: [payload.conversation!, ...project.conversations] } : project));
      setActiveConversationId(id);
      sessionIdRef.current = id;
      setMessages(initialMessages);
      const workspaceResponse = await fetch(`/api/projects/${projectId}?conversation=${encodeURIComponent(id)}`, { signal: controller.signal });
      const workspace = await workspaceResponse.json() as ProjectWorkspaceEnvelope & { error?: string };
      if (!workspaceResponse.ok) throw new Error(workspace.error || "新会话快照读取失败。");
      applyProjectWorkspace(workspace);
      window.history.replaceState(null, "", `/projects/${projectId}?conversation=${id}`);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setActiveConversationId(previousConversationId);
        sessionIdRef.current = previousConversationId;
        setMessages(previousMessages);
        setWorkspaceError(error instanceof Error ? error.message : "新建对话失败。");
      }
    } finally {
      if (conversationLoadRef.current === controller) {
        conversationLoadRef.current = null;
        setConversationLoading(false);
      }
    }
  }

  async function closeWorkspaceOperation() {
    if (activeOperation === "settings") {
      try {
        const config = JSON.parse(sessionStorage.getItem(PROVIDER_SESSION_KEY) || "null") as ProviderConfig | null;
        const definition = config ? PROVIDERS[config.provider] : null;
        const model = definition?.models.find((item) => item.id === config?.model);
        if (config?.apiKey && definition && model) setModelSummary({ configured: true, label: `${definition.name} · ${model.label}` });
      } catch { /* ModelSettings owns invalid session cleanup. */ }
    }
    setActiveOperation(null);
    if (!projectId) return;
    const conversationId = activeConversationId || initialConversationId || conversations[0]?.id;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ""}`);
      const workspace = await response.json() as ProjectWorkspaceEnvelope & { error?: string };
      if (!response.ok) throw new Error(workspace.error || "最新岗位版本读取失败。");
      applyProjectWorkspace(workspace);
      setEnrichmentState({ running: false, label: "页内操作已完成，工作台已切换到最新不可变版本" });
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "最新岗位版本读取失败。");
    }
  }

  const nodeCount = filteredData?.nodes.length ?? 0;
  const edgeCount = filteredData?.edges.length ?? 0;
  const detailRows = selectedObject
    ? Object.entries(selectedObject.payload)
      .map(([key, value]) => [key, toReadableValue(value)] as const)
      .filter(([, value]) => value)
      .slice(0, 3)
    : [];
  const skillContext = {
    snapshotId: packageStatus?.snapshotId,
    projectId,
    versionId: projectId ? conversations.find((conversation) => conversation.id === activeConversationId)?.versionId || undefined : undefined,
    conversationId: projectId ? activeConversationId : undefined,
    selectedNodeIds: selectedNode ? [selectedNode.id] : [],
    roleTitle: workspaceTitle,
    roleDescription: projectResult?.brief.roleDescription,
    market: projectResult?.brief.market || "中国大陆",
  };

  return (
    <main className={`workspace-shell ${chatCollapsed ? "chat-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Network size={17} /></span><span>Role Atlas</span></div>
        <button className="new-project" type="button" onClick={() => setActiveOperation("new-project")}><Plus size={15} /> 新建岗位项目</button>

        <div className="side-section">
          <div className="side-label">浏览当前岗位</div>
          <label className="side-search"><Search size={14} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={view === "evidence" ? "检索来源" : view === "tasks" ? "检索典型任务" : "检索岗位节点"} /></label>
          <button className="side-row" type="button" onClick={() => setActiveOperation("registry")}><Layers3 size={15} /> 岗位包中心</button>
        </div>

        <div className="side-section grow">
          <div className="side-label">岗位项目</div>
          {projects.map((project) => {
            const active = project.id === projectId;
            const projectConversations = active ? conversations : project.conversations;
            const href = `/projects/${project.id}?conversation=${projectConversations[0]?.id || ""}`;
            return <div className="project-tree" key={project.id}>
              <Link href={href} className={`project-row ${active ? "active" : ""}`}>
                <FolderKanban size={15} /><span><b>{project.title}</b><small>{project.status === "building" ? "正在构建" : project.status === "failed" ? "构建失败" : project.activeVersionId ? "已有岗位快照" : "等待快照"} · {projectConversations.length} 个会话</small></span>
              </Link>
              {active ? (
                <div className="project-panel">
                  <div className="project-actions">
                    <button data-testid="project-new-conversation" className="project-new-chat" disabled={isRunning || conversationLoading} onClick={() => void createNewConversation()}><Plus size={13} /> 新建对话</button>
                    <button type="button" className="project-new-chat" onClick={() => setActiveOperation("versions")}><GitBranch size={13} /> 版本与发布</button>
                  </div>
                  <div className="project-conversations">
                    {projectConversations.map((conversation) => <button disabled={isRunning || conversationLoading} key={conversation.id} className={`chat-row ${conversation.id === activeConversationId ? "active" : ""}`} onClick={() => void switchConversation(conversation.id)}><MessageSquareText size={14} /> <span>{conversation.title}</span></button>)}
                  </div>
                </div>
              ) : null}
            </div>;
          })}
          {projects.length === 0 ? <p className="project-empty">还没有岗位项目。新建项目后，冷启动、会话和版本都会保存在这里。</p> : null}
          <ProjectManagement projectId={projectId} title={workspaceTitle} />
          <div className="side-label example-label">内置示例</div>
          <Link href="/" className={`project-row ${!projectId ? "active" : ""}`}>
            <Layers3 size={15} /><span><b>大模型应用工程师</b><small>只读岗位包 · v{packageStatus?.packageVersion || "1.2"}</small></span>
          </Link>
        </div>

        <button type="button" className="account-row" onClick={() => setActiveOperation("settings")}><CircleUserRound size={18} /><span><b>模型与设置</b><small>{modelSummary.label}</small></span><Settings size={15} /></button>
      </aside>

      {activeOperation ? <section className="workspace-operation-layer" aria-label="岗位工作台页内操作">
        {activeOperation === "new-project" ? <ColdStartWorkspace initialQuery={{}} embedded onClose={() => void closeWorkspaceOperation()} onSettingsRequest={() => setActiveOperation("settings")} />
        : activeOperation === "settings" ? <ModelSettings embedded onClose={() => void closeWorkspaceOperation()} />
        : activeOperation === "registry" ? <InlineRegistryCenter onClose={() => void closeWorkspaceOperation()} />
        : activeOperation === "versions" && projectId ? <InlineVersionCenter project={{ id: projectId, title: workspaceTitle, headVersionId: projects.find((item) => item.id === projectId)?.headVersionId || null, currentReleaseId: projects.find((item) => item.id === projectId)?.currentReleaseId || null }} onClose={() => void closeWorkspaceOperation()} />
        : activeOperation === "workspace-instantiation" && packageStatus?.snapshotId ? <WorkspaceUpgradeWorkspace
          key={`${activeOperation}:${packageStatus.snapshotId}`}
          snapshotId={packageStatus.snapshotId}
          projectId={projectId}
          versionId={skillContext.versionId}
          conversationId={skillContext.conversationId}
          embedded
          onClose={() => void closeWorkspaceOperation()}
          onComplete={() => setEnrichmentState({ running: false, label: "真实工作区已蒸馏，候选版本已写入" })}
          onSettingsRequest={() => setActiveOperation("settings")}
        /> : packageStatus?.snapshotId ? <IterationWorkspace
          key={`${activeOperation}:${packageStatus.snapshotId}:${selectedNode?.id || "all"}`}
          snapshotId={packageStatus.snapshotId}
          projectId={projectId}
          versionId={skillContext.versionId}
          conversationId={skillContext.conversationId}
          initialProfile={activeOperation === "node-deepening" ? "user_directed" : "co_guided"}
          initialPrompt={activeOperation === "node-deepening" ? `围绕「${selectedNode?.label || "选中节点"}」深化证据、任务关系、能力结构与学习依赖` : ""}
          initialTargetIds={activeOperation === "node-deepening" && selectedNode ? selectedNode.id : ""}
          embedded
          onClose={() => void closeWorkspaceOperation()}
          onComplete={() => setEnrichmentState({ running: false, label: "岗位包迭代完成，候选版本已写入" })}
          onSettingsRequest={() => setActiveOperation("settings")}
        /> : <div className="inline-operation-state error"><AlertTriangle size={17} /><b>当前岗位还没有可操作的静态快照。</b><button onClick={() => void closeWorkspaceOperation()}>返回工作台</button></div>}
      </section> : <>
      <section className="graph-pane">
        <header className="pane-header">
          <div><span className="eyebrow">ROLE PACKAGE</span><h1>{workspaceTitle}</h1></div>
          <div className="package-header-actions">
            {launchReleaseId ? <button type="button" className="learnflow-launch" onClick={() => void launchInLearnFlow()} disabled={launchingLearnFlow}><MessageCircle size={13} /> {launchingLearnFlow ? "正在进入…" : "在 LearnFlow 中引用"}</button> : null}
            <div className={`status-chip ${packageStatus?.publishable === false ? "warning" : ""}`}><span /> {projectStatus === "building" || enrichmentState.running ? "内核可用 · 后台增量中" : `快照 ${packageStatus?.snapshotAsOf || "装载中"}`}</div>
          </div>
        </header>
        {learnFlowLaunchError ? <div className="learnflow-launch-error" role="alert">
          <AlertTriangle size={15} /><span>{learnFlowLaunchError}</span>
          <button type="button" onClick={() => setLearnFlowLaunchError("")} aria-label="关闭引用错误提示"><X size={14} /></button>
        </div> : null}
        <div className="graph-toolbar">
          {viewOptions.map((option) => <button key={option.key} className={view === option.key ? "active" : ""} onClick={() => {
            setView(option.key);
            setSearchQuery("");
            if (option.key === "evidence") setEvidenceScope({ sourceIds: [], label: "" });
            if (option.key === "tasks" && activeTaskId) updateTaskLocation(activeTaskId, taskPerspective);
          }}>{option.label}</button>)}
          {view === "semantic" || view === "cards" ? <div className="semantic-density" aria-label="岗位结构显示密度">
            <button className={semanticDensity === "kernel" ? "active" : ""} onClick={() => setSemanticDensity("kernel")}>核心</button>
            <button className={semanticDensity === "complete" ? "active" : ""} onClick={() => setSemanticDensity("complete")}>全部</button>
          </div> : null}
          <span className="graph-count">{view === "tasks"
            ? `${taskNodes.length} 个典型任务 · ${taskPerspective === "relations" ? "关系雷达" : "事理流程"}`
            : view === "evidence" ? `${evidenceScope.sourceIds.length || evidenceSources.length} 个来源`
            : `${nodeCount}/${graphData?.nodes.length || 0} 节点 · ${edgeCount} 关系`}</span>
        </div>

        {projectId && enrichmentState.label ? <div className={`enrichment-banner ${enrichmentState.error ? "error" : enrichmentState.running ? "running" : "done"}`}>
          {enrichmentState.error ? <AlertTriangle size={14} /> : enrichmentState.running ? <Sparkles size={14} /> : <Check size={14} />}
          <span><b>{enrichmentState.label}</b><small>{enrichmentState.error || (enrichmentState.running ? "当前岗位结构可立即使用；新节点、依赖和事理场景会按不可变子版本自动并入。" : "节点引用仍固定到具体快照；新会话默认使用最新版本。")}</small></span>
        </div> : null}

        <div className={`graph-stage ${view === "tasks" ? "tasks-mode" : view === "evidence" ? "evidence-mode" : view === "cards" ? "cards-mode" : ""}`}>
          {view === "evidence" ? (
            <EvidenceSourceView
              sources={evidenceSources}
              query={searchQuery}
              research={projectResult?.sources.research}
              sourceIds={evidenceScope.sourceIds}
              contextLabel={evidenceScope.label}
              onClearContext={() => setEvidenceScope({ sourceIds: [], label: "" })}
            />
          ) : view === "tasks" ? (
            graphData && activeTaskId ? (
              <TaskWorkspace
                nodes={graphData.nodes}
                edges={graphData.edges}
                workProcess={workProcessData}
                taskId={activeTaskId}
                query={searchQuery}
                selectedId={selectedId}
                perspective={taskPerspective}
                onTaskChange={(task) => openTask(task, taskPerspective)}
                onPerspectiveChange={changeTaskPerspective}
                onSelect={(node) => setSelectedId(node.id)}
                onReference={addReference}
                onDragStart={startCardDrag}
                onDragEnd={endCardDrag}
                onOpenEvidence={openEvidenceFor}
              />
            ) : <div className={`graph-loading ${workspaceError ? "error" : ""}`}>{workspaceError ? <AlertTriangle size={14} /> : <span />} {workspaceError || "正在装载典型工作任务…"}</div>
          ) : view === "cards" ? (
            filteredData ? (
              <RoleCardView
                nodes={filteredData.nodes}
                edges={filteredData.edges}
                selectedId={selectedId}
                onSelect={selectCardNode}
                onExploreTask={openTask}
                onReference={addReference}
                onDragStart={startCardDrag}
                onDragEnd={endCardDrag}
              />
            ) : <div className={`graph-loading ${workspaceError ? "error" : ""}`}>{workspaceError ? <AlertTriangle size={14} /> : <span />} {workspaceError || "正在装载岗位卡片…"}</div>
          ) : (
            <>
              <div className="graph-canvas" ref={containerRef} aria-label="可交互岗位知识图谱" />
              {!graphData && <div className={`graph-loading ${workspaceError ? "error" : ""}`}>{workspaceError ? <AlertTriangle size={14} /> : <span />} {workspaceError || "正在装载岗位快照…"}</div>}
              <div className="graph-hint"><GripVertical size={13} /> 悬停高亮一跳关系 · 滚轮缩放 · 拖入右侧对话即可引用 <button type="button" onClick={() => { setSelectedId(""); setHoveredNodeId(""); setDetailOpen(false); }}>清除聚焦</button></div>
              {detailOpen && selectedNode && (
                <article className="node-card">
                  <button className="node-card-close" onClick={() => setDetailOpen(false)} aria-label="关闭节点卡片"><X size={14} /></button>
                  <span className={`node-kind ${selectedNode.lifecycle}`}>{typeLabels[selectedNode.type] ?? selectedNode.type} · {selectedNode.lifecycle === "accepted" ? "已接受" : "待审"}</span>
                  <h2>{selectedNode.label}</h2>
                  <p>{selectedNode.summary}</p>
                  <div className="evidence-metrics">
                    <span><ShieldCheck size={13} /><b>{selectedNode.evidence_summary.max_confidence.toFixed(2)}</b><small>置信上限</small></span>
                    <span><BookOpenCheck size={13} /><b>{selectedNode.evidence_summary.source_refs.length}</b><small>来源</small></span>
                    <span><GitBranch size={13} /><b>{selectedNode.evidence_summary.binding_refs.length}</b><small>绑定</small></span>
                  </div>
                  {detailRows.length > 0 && <dl>{detailRows.map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{value}</dd></div>)}</dl>}
                  <div className="node-card-actions">
                    <button className="source-node" onClick={() => openEvidenceFor([selectedNode])}><BookOpenCheck size={14} /> 查看证据</button>
                    <button className="quote-node" draggable onDragStart={() => { draggedRef.current = selectedNode; setDraggingNode(selectedNode); }} onClick={() => addReference(selectedNode)}>
                      <Plus size={14} /> 引用到对话
                    </button>
                  </div>
                </article>
              )}
            </>
          )}
        </div>

        <footer className="graph-footer">
          {view === "tasks" ? <><span><i className="dot orange" />任务是语义图与事理图的桥</span><span><Network size={11} />关系雷达</span><span><GitBranch size={11} />流程、分支与返工</span><span>知识技能附着到实际工作事件</span></> : view === "evidence" ? <><span><BookOpenCheck size={11} />来源与定位</span><span>证据状态来自岗位包，不由前端推测</span></> : view === "cards" ? <><span><Layers3 size={11} />上下切换维度</span><span>左右浏览同维度卡片</span><span>典型任务可进入双视角详情</span></> : <><span><i className="dot blue" />产业/岗位</span><span><i className="dot orange" />任务</span><span><i className="dot violet" />能力/单元</span><span><i className="dot green" />知识技能</span><span><i className="dash" />候选内容</span></>}
        </footer>
      </section>

      <section ref={dropRef} data-chat-drop className={`chat-pane ${chatCollapsed ? "collapsed" : ""} ${draggingNode ? "drop-ready" : ""}`}
        onDragOver={(event) => { if (draggedRef.current) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
        onDrop={(event) => {
          const node = draggedRef.current;
          if (!node) return;
          event.preventDefault(); event.stopPropagation();
          if (!conversationLoading) addReference(node);
          draggedRef.current = null; setDraggingNode(null);
        }}
      >
        <button className="chat-collapse-rail" onClick={() => setChatCollapsed(false)} aria-label="展开对话侧栏" title="展开对话侧栏">
          <PanelRightOpen size={16} />
          <span>对话</span>
          {isRunning ? <i className="live-dot" /> : <MessageSquareText size={14} />}
        </button>
        <header className="chat-header">
          <div className="chat-header-copy"><b>{projectId
            ? conversations.find((conversation) => conversation.id === activeConversationId)?.title || "岗位项目对话"
            : "内置示例问答"}</b><span><Sparkles size={11} /> {conversationLoading ? "正在切换会话快照…" : "证据化运行过程 · 推理通道可展开"}</span></div>
          <div className="chat-header-actions">
            <button className="chat-collapse-button" onClick={() => setChatCollapsed(true)} aria-label="收起对话侧栏" title="收起对话侧栏"><PanelRightClose size={14} /></button>
            <button type="button" className={`model-chip ${modelSummary.configured ? "configured" : ""}`} onClick={() => setActiveOperation("settings")}><Settings size={12} /> {modelSummary.label}</button>
          </div>
        </header>
        <WorkspaceSkillLauncher context={skillContext} onLaunch={setActiveOperation} />
        {!modelSummary.configured && (
          <div className="model-banner"><AlertTriangle size={15} /><span><b>还不能发起真实回答</b><small>选择 MiMo V2.5 或 DeepSeek V4 Flash，并保存会话级 API Key。</small></span><button type="button" onClick={() => setActiveOperation("settings")}>去配置</button></div>
        )}
        <div className="messages">
          {messages.map((message) => message.role === "user" ? (
            <div className="message user" key={message.id}>
              {message.references && message.references.length > 0 ? <div className="message-refs">{message.references.map((node) => <button key={node.id} onClick={() => selectAndFocus(node)}>{typeLabels[node.type] || node.type} · {node.label}</button>)}</div> : null}
              {message.text}
            </div>
          ) : (
            <div className={`message assistant ${message.status || "done"}`} key={message.id}>
              <div className="assistant-label"><Sparkles size={14} /> ROLE AGENT {message.status === "running" ? <span className="live-dot" /> : null}</div>
              {message.activities && message.activities.length > 0 ? (
                <div className="run-activity" aria-label="智能体运行进程">
                  {message.activities.map((activity) => (
                    <div className={`activity-row ${activity.status}`} key={activity.id}>
                      <span className="activity-icon">{activity.status === "running" ? <span className="activity-spinner" /> : activity.status === "done" ? <Check size={11} /> : <CircleX size={11} />}</span>
                      <span><b>{activity.label}</b>{activity.detail ? <small>{activity.detail}</small> : null}</span>
                      {activity.id.startsWith("tool:") ? <Wrench size={11} /> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {message.reasoning ? (
                <details className="model-reasoning">
                  <summary>供应商返回的推理通道 <span>{message.status === "running" ? "实时接收中" : "仅供调试参考"}</span></summary>
                  <MarkdownContent className="reasoning-content" text={message.reasoning} />
                </details>
              ) : null}
              {message.text ? <MarkdownContent className="answer-text" text={message.text} /> : message.status === "running" ? <p className="answer-pending">正在等待模型返回思考过程与正文…</p> : null}
              {message.citations && message.citations.length > 0 ? (
                <div className="citation-list">
                  <div className="citation-heading"><FileSearch size={12} /> 本轮引用注册表 <span>{message.citations.length}</span></div>
                  {message.citations.slice(0, 8).map((citation) => {
                    const node = nodeMap.get(citation.targetId) || processNodeMap.get(citation.targetId);
                    return (
                      <button className="citation" key={`${citation.handle}:${citation.targetId}`} disabled={!node} onClick={() => { if (node) selectAndFocus(node); }}>
                        <span><i>[{citation.handle}]</i> {citation.label}</span>
                        <em>{citation.artifactKind === "work_process" ? "事理" : "语义"} · {citation.lifecycle === "accepted" ? "已接受" : "候选"} · {citation.confidence.toFixed(2)}</em>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {message.status === "failed" ? <div className="answer-error"><AlertTriangle size={13} /> 可以检查模型配置后重试；岗位快照未被修改。</div> : null}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        {draggingNode && <div className="drag-bridge"><Layers3 size={14} /> 正在引用「{draggingNode.label}」</div>}
        <div
          className={`composer ${draggingNode ? "drop-ready" : ""}`}
        >
          {references.length > 0 && <div className="ref-list">{references.map((node) => <div className="ref-chip" key={node.id}>{typeLabels[node.type]} · {node.label}<button onClick={() => setReferences((current) => current.filter((item) => item.id !== node.id))}><X size={11} /></button></div>)}</div>}
          <div className="composer-row">
            <input value={chatInput} disabled={isRunning || conversationLoading} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void sendMessage(); }} placeholder={conversationLoading ? "正在固定该会话的岗位快照" : isRunning ? "当前运行结束后可继续提问" : draggingNode ? "松开即可引用这个节点" : "引用节点，或询问这个岗位…"} />
            {isRunning
              ? <button className="send-button cancel" onClick={cancelRun}><Square size={11} /> 停止</button>
              : <button className="send-button" disabled={conversationLoading} onClick={() => void sendMessage()}><Send size={13} /> 发送</button>}
          </div>
        </div>
      </section>
      </>}
    </main>
  );
}
