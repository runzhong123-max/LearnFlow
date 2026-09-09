import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCitations, citationCaption } from "@/lib/presentation/citations";
import { formatIntakeDescription, previousIntakeHistory } from "@/lib/intake/presentation";
import type { IntakeView } from "@/lib/intake/types";
test("intake source citations survive confirmation and malformed graph confidence", () => {
  const citations = normalizeCitations([{ title: "云计算公开岗位", url: "https://example.com/job" },
    { targetId: "task:1", label: "部署云资源", handle: "T1", lifecycle: "candidate" },
    { targetId: "task:2", label: "数据备份", confidence: 0.8 }, null, {}]);
  assert.equal(citations.length, 3); assert.equal(citations[0].kind, "source");
  assert.equal(citations[0].url, "https://example.com/job"); assert.equal(citations[0].confidence, undefined);
  assert.equal(citationCaption(citations[0]), "检索资料"); assert.equal(citationCaption(citations[1]), "语义 · 候选");
  assert.equal(citationCaption(citations[2]), "语义 · 0.80");
  for (const confidence of [undefined, null, "0.9", NaN, Infinity, -1, 2]) assert.doesNotThrow(() => citationCaption(normalizeCitations([{ label: "任务", targetId: "task:1", confidence }])[0]));
  assert.equal(normalizeCitations([{ title: "unsafe", url: "javascript:alert(1)" }])[0].url, undefined);
});
test("one current description remains visible without rewriting confirmed text", () => {
  const description = "岗位说明（待确认）：云运维工程师\n\n主要任务\n1. 备份数据\n\n能力要求\n1. 验证恢复";
  const intake = { revisionId: "rev:1", description, assistantMessage: "请确认", history: [
    { id: "input:1", role: "user", text: "云运维", createdAt: "" },
    { id: "intake:rev:1:assistant", role: "assistant", text: `请确认\n\n${description}`, createdAt: "" },
  ] } as IntakeView;
  assert.deepEqual(previousIntakeHistory(intake).map(item => item.id), ["input:1"]);
  assert.match(formatIntakeDescription(description), /^## 云运维工程师/);
  assert.match(formatIntakeDescription(description), /### 主要任务/); assert.equal(intake.description, description);
});
