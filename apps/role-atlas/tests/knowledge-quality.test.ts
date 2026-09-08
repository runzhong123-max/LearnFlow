import assert from "node:assert/strict";
import test from "node:test";
import { inspectKnowledgeDerivation, mergeKnowledgeDerivations } from "@/lib/build/knowledge-quality";
import { knowledgeDerivationPrompt, knowledgeDerivationSchema, knowledgeToSemanticDraft } from "@/lib/build/workflow-model";
import type { TaskGroup } from "@/lib/build/workflow";
import { compileSemanticDraft, prepareBuildInput, stableHash } from "@/lib/build/compiler";
import type { ColdStartRequest } from "@/lib/build/types";
import type { SemanticDraft } from "@/lib/build/model";

const segments = [
  { id: "sql-source", text: "数据校验使用 SQL 多表关联查询，根据主键检查导入前后记录的一致性。" },
  { id: "deploy-source", text: "部署时安装 JDK，配置 JAVA_HOME，启动 Tomcat 并检查启动日志。" },
  { id: "docs-source", text: "操作手册应按用户角色组织步骤，记录前置条件与预期结果。" },
];
const group: TaskGroup = { id: "implementation", evidenceSegmentIds: segments.map((segment) => segment.id), tasks: [
  { tempId: "sql-task", type: "task", label: "验证导入数据", summary: "检查数据一致性并提交校验报告。", aliases: [], evidenceSegmentIds: ["sql-source"], confidence: 0.8 },
  { tempId: "deploy-task", type: "task", label: "部署客户系统", summary: "完成环境部署并检查服务启动。", aliases: [], evidenceSegmentIds: ["deploy-source"], confidence: 0.8 },
  { tempId: "docs-task", type: "task", label: "交付用户操作手册", summary: "形成按角色组织的操作手册。", aliases: [], evidenceSegmentIds: ["docs-source"], confidence: 0.8 },
] };
function point(label: string, learningKind: "knowledge" | "skill", taskTempId: string, sourceIndex: number) {
  return { tempId: label, label, learningKind, summary: label,
    learningDefinition: { scopeNote: `仅限${group.tasks.find((task) => task.tempId === taskTempId)?.label}中的此项学习对象。`, assessmentCriteria: ["依据输入案例给出可复核的操作结果或解释"] },
    taskTempIds: [taskTempId], evidenceSpans: [{ segmentId: segments[sourceIndex].id, quote: segments[sourceIndex].text }],
  };
}
function check(skills: unknown[], gaps: Array<{ taskTempId: string; reason: string }> = []) {
  return inspectKnowledgeDerivation({ draft: knowledgeDerivationSchema.parse({ skills, gaps }), group, mentions: [], segments });
}

test("软件实施任务保留不同原子知识与技能并绑定真实来源，覆盖 SQL、部署和文档", () => {
  const quality = check([
    point("关系表的主键与关联规则", "knowledge", "sql-task", 0),
    point("编写多表 SQL 查询校验数据", "skill", "sql-task", 0),
    point("配置 JDK 环境变量并检查启动日志", "skill", "deploy-task", 1),
    point("按用户角色编写操作步骤", "skill", "docs-task", 2),
  ]);
  assert.equal(quality.accepted.skills.length, 4);
  assert.deepEqual(quality.uncoveredTaskIds, []);
  assert.deepEqual(quality.incompleteTaskIds, ["deploy-task", "docs-task"], "有技能仍应核对缺少的知识维度");
  assert.deepEqual(quality.coverage[1].missingKinds, ["knowledge"]);
  const semantic = knowledgeToSemanticDraft({ draft: quality.accepted, group, mentions: [], segments });
  assert.deepEqual(new Set(semantic.nodes.map((node) => node.learningKind)), new Set(["knowledge", "skill"]));
  assert.equal(semantic.edges.length, 4);
  for (const node of semantic.nodes) {
    assert.ok(node.learningDefinition);
    assert.ok(node.evidenceSpans?.every((span) => segments.some((segment) => segment.id === span.segmentId && segment.text.includes(span.quote))));
  }
});

test("同段多个上下文窗口均可引用，但跨窗口拼接或空引用不能通过", () => {
  const windows = [{ id: "sql-source", text: "SQL 多表关联查询" }, { id: "sql-source", text: "按主键校验数据一致性" }];
  const valid = point("多表关联规则", "knowledge", "sql-task", 0);
  const quality = inspectKnowledgeDerivation({ group, segments: windows, mentions: [], draft: knowledgeDerivationSchema.parse({ skills: [
    { ...valid, tempId: "first", evidenceSpans: [{ segmentId: "sql-source", quote: windows[0].text }] },
    { ...valid, tempId: "second", evidenceSpans: [{ segmentId: "sql-source", quote: windows[1].text }] },
    { ...valid, tempId: "fabricated", evidenceSpans: [{ segmentId: "sql-source", quote: windows.map(window => window.text).join("") }] },
  ] }) });
  assert.equal(quality.accepted.skills.length, 2);
  assert.equal(quality.issues.length, 1);
});

test("综合能力、hybrid、伪造引用和未知任务不会通过原子知识质量检查", () => {
  const valid = point("编写多表 SQL 查询校验数据", "skill", "sql-task", 0);
  const quality = check([
    { ...valid, label: "协调与组织能力", learningKind: "knowledge" },
    { ...valid, label: "数据库领域", learningKind: "hybrid" },
    { ...valid, label: "配置并行查询计划", evidenceSpans: [{ segmentId: "sql-source", quote: "原文并不存在的并行查询设置" }] },
    { ...valid, taskTempIds: ["missing-task"] },
  ]);
  assert.equal(quality.accepted.skills.length, 0);
  assert.equal(quality.issues.length, 4);
  assert.match(quality.issues[0].detail, /综合能力/u);
  assert.match(quality.issues[2].detail, /原文引用/u);
  assert.equal(quality.accepted.gaps.length, 3);
});

test("补齐只增加未覆盖项，保留已验证点；资料不足可明确保留零点缺口", () => {
  const initial = check([point("编写多表 SQL 查询校验数据", "skill", "sql-task", 0)]);
  const repair = check([point("配置 JDK 环境变量并检查启动日志", "skill", "deploy-task", 1)], [
    { taskTempId: "docs-task", reason: "仍缺少手册样例和验收规范，无法界定原子评价条件。" },
  ]);
  const merged = mergeKnowledgeDerivations(initial.accepted, repair.accepted);
  assert.equal(merged.skills.length, 2);
  assert.deepEqual(new Set(merged.gaps.map((gap) => gap.taskTempId)), new Set(["sql-task", "deploy-task", "docs-task"]));
  assert.match(merged.gaps.find(gap => gap.taskTempId === "docs-task")!.reason, /手册样例/u);
  const absent = check([], group.tasks.map((task) => ({ taskTempId: task.tempId, reason: "资料只列岗位名称，没有支持此任务的技术或方法描述。" })));
  assert.equal(absent.accepted.skills.length, 0);
  assert.equal(absent.accepted.gaps.length, 3);
  const prompt = knowledgeDerivationPrompt({ roleTitle: "软件实施工程师", group, mentions: [], segments, mode: "detail", repair: {
    acceptedPoints: initial.accepted.skills, issues: initial.issues, uncoveredTaskIds: initial.uncoveredTaskIds,
  } });
  const payload = JSON.parse(prompt.user);
  assert.deepEqual(payload.repair.uncoveredTaskIds, ["deploy-task", "docs-task"]);
  assert.equal(payload.repair.acceptedPoints.length, 1);
  assert.match(prompt.system, /未被 knowledgeMentions 列出而忽略/u);
});

test("同名知识、技能和历史混合领域保持独立身份，原子节点重编结果稳定", () => {
  const request: ColdStartRequest = { runId: "atomic-identity", projectId: "atomic-identity", roleTitle: "软件实施工程师", roleDescription: "", market: "中国大陆", audience: [], snapshotAsOf: "2026-09-07", sources: [] };
  const prepared = prepareBuildInput(request);
  const nodes: SemanticDraft["nodes"] = (["knowledge", "skill", "hybrid"] as const).map((learningKind) => ({
    tempId: learningKind, type: "knowledge_skill", label: "SQL 查询", summary: "SQL 查询", aliases: [], evidenceSegmentIds: [], learningKind,
    learningDefinition: learningKind === "hybrid" ? undefined : { scopeNote: learningKind === "knowledge" ? "解释查询规则" : "编写并运行查询", assessmentCriteria: ["根据输入给出正确结果"] }, confidence: 0.7,
  }));
  const compile = (draftNodes: SemanticDraft["nodes"]) => compileSemanticDraft({ request, draft: { roleSummary: "", nodes: draftNodes, edges: [] }, segments: prepared.segments, assets: prepared.assets });
  const first = compile(nodes).nodes.filter((node) => node.type === "knowledge_skill");
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((node) => node.id)).size, 3);
  assert.match(first.find((node) => node.learningKind === "knowledge")!.id, /:knowledge$/u);
  assert.match(first.find((node) => node.learningKind === "skill")!.id, /:skill$/u);
  assert.equal(first.find((node) => node.learningKind === "hybrid")!.id, `knowledge_skill:${stableHash("knowledge_skill:sql查询")}`);
  const second = compile(nodes.map((node) => ({ ...node, tempId: first.find((item) => item.learningKind === node.learningKind)!.id }))).nodes.filter((node) => node.type === "knowledge_skill");
  assert.deepEqual(second.map((node) => node.id), first.map((node) => node.id));
});
