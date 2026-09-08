import assert from "node:assert/strict";
import test from "node:test";
import { selectKnowledgeContext } from "@/lib/build/knowledge-context";
import { estimateTokens, type TaskGroup } from "@/lib/build/workflow";
import type { SourceAsset, SourceSegment } from "@/lib/build/types";

const group: TaskGroup = { id: "ops", evidenceSegmentIds: ["linux-jd", "sql-jd"], tasks: [
  { tempId: "linux", type: "task", label: "排查 Linux 服务故障", summary: "检查 Linux 服务日志与进程状态", aliases: [], evidenceSegmentIds: ["linux-jd"], confidence: 0.8 },
  { tempId: "sql", type: "task", label: "恢复数据库备份", summary: "使用 SQL 核对数据库备份恢复后的记录一致性", aliases: [], evidenceSegmentIds: ["sql-jd"], confidence: 0.8 },
] };
function segment(id: string, sourceId: string, text: string): SourceSegment { return { id, sourceId, text, ordinal: 0, contentHash: id }; }
const assets: SourceAsset[] = ["jd", "manual", "blocked"].map(id => ({ id, kind: "public_document", title: id, contentHash: id, visibility: "publishable_metadata",
  qualification: { status: id === "blocked" ? "quarantined" : "accepted", evidenceRoles: [id === "jd" ? "job_market" : "technology_primary"], reasons: [] },
}));

test("每个任务的原文与相关技术文档均获预算，重复 JD 不挤占另一任务", () => {
  const segments = [
    segment("linux-jd", "jd", "岗位职责：检查 Linux 服务日志与进程状态。".repeat(200)),
    ...Array.from({ length: 8 }, (_, i) => segment(`jd-${i}`, "jd", "检查 Linux 服务日志，排查 Linux 服务故障。".repeat(100))),
    segment("sql-jd", "jd", "岗位职责：使用 SQL 核对数据库备份恢复后的记录一致性。"),
    segment("linux-doc", "manual", "Linux 服务故障排查使用进程退出码与日志时间定位失败原因。"),
    segment("sql-doc", "manual", "数据库备份恢复后使用 SQL 比对记录数量并校验字段一致性。"),
    segment("bad", "blocked", "Linux SQL 数据库备份恢复官方文档".repeat(200)),
    segment("irrelevant", "manual", "摄影构图的艺术形式及审美变化"),
  ];
  const selected = selectKnowledgeContext({ group, segments, assets, mentions: [], maxTokens: 3_000 });
  const ids = new Set(selected.map(s => s.id));
  for (const id of ["linux-jd", "sql-jd", "linux-doc", "sql-doc"]) assert.ok(ids.has(id), id);
  assert.equal(ids.has("bad"), false);
  assert.equal(ids.has("irrelevant"), false);
  assert.ok(selected.reduce((sum, s) => sum + estimateTokens(s.text), 0) <= 3_000);
  for (const selectedSegment of selected) assert.ok(segments.find(s => s.id === selectedSegment.id)!.text.includes(selectedSegment.text));
  assert.ok(segments[0].text.length > selected[0].text.length, "只裁剪模型上下文，不修改来源");
});

test("长网页尾部的相关说明可以进入上下文，保留连续原文且不突破小预算", () => {
  const sentence = "数据库备份恢复后的记录一致性可使用 SQL 比对记录数量。";
  const original = segment("sql-doc", "manual", "无关栏目与页面导航。".repeat(800) + sentence);
  const selected = selectKnowledgeContext({ group, segments: [original], assets, mentions: [], maxTokens: 800 });
  assert.equal(selected.length, 1);
  assert.ok(selected[0].text.includes(sentence));
  assert.ok(original.text.includes(selected[0].text));
  assert.ok(estimateTokens(selected[0].text) <= 800);
});

test("共用长段落的两个任务分别取连续窗口，不拼接原文伪造证据", () => {
  const linux = "检查 Linux 服务日志与进程状态，排查 Linux 服务故障。";
  const sql = "使用 SQL 核对数据库备份恢复后的记录一致性。";
  const original = segment("shared", "jd", linux + "栏目与导航。".repeat(600) + sql);
  const shared = { ...group, evidenceSegmentIds: ["shared"], tasks: group.tasks.map(task => ({ ...task, evidenceSegmentIds: ["shared"] })) };
  const selected = selectKnowledgeContext({ group: shared, segments: [original], assets, mentions: [], maxTokens: 2_000 });
  assert.ok(selected.some(s => s.text.includes(linux)));
  assert.ok(selected.some(s => s.text.includes(sql)));
  assert.ok(selected.every(s => original.text.includes(s.text)));
  assert.ok(selected.reduce((sum, s) => sum + estimateTokens(s.text), 0) <= 2_000);
});
