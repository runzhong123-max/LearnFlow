import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { buildProductPlanner, productPrompt } from "@/lib/iteration/product-planner";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

function modelReturning(payload: unknown): ModelInvoker {
  return async function* () {
    yield { type: "text", delta: JSON.stringify(payload) };
  };
}

function context() {
  const snapshot = bundledRoleSnapshot();
  return {
    contract: { objective: "补齐软件测试技术员的知识技能", mode: "deep_research" },
    base: snapshot,
    candidate: snapshot,
    claims: [],
    round: 1,
  };
}

test("增补候选的基线由代码给定，不由模型决定", async () => {
  const snapshot = bundledRoleSnapshot();
  const segmentId = snapshot.sources.segments[0].id;
  const planner = buildProductPlanner({
    model: modelReturning({
      augmentations: [{
        motivation: "补齐边界值知识点",
        nodes: [{
          tempId: "p", type: "knowledge_skill", label: "边界值选取规则",
          summary: "说明边界附近数据的选取依据。", aliases: [], evidenceSegmentIds: [segmentId],
          learningKind: "knowledge",
          learningDefinition: { scopeNote: "限于边界取值判断", assessmentCriteria: ["能说明选取依据"] },
        }],
        edges: [],
      }],
    }),
  });
  const proposal = await planner(context());
  assert.equal(proposal?.augmentations?.length, 1);
  // 模型看不到也决定不了基线；写错基线会让证据绑到不存在的节点上。
  assert.equal(proposal?.augmentations?.[0].baseSnapshotId, snapshot.snapshot.id);
});

test("风险包的确定性发现来自代码，模型只提供假设", async () => {
  const planner = buildProductPlanner({
    issues: [{ code: "TASK_SKILL_GAP", severity: "error", title: "任务缺少技能", detail: "", targetIds: ["t1"] }],
    model: modelReturning({
      riskDomains: [{
        domain: "覆盖缺口",
        claims: [{
          id: "c1", statement: "任务层缺少可检验技能点", kind: "inferred", evidenceSpans: [],
          falsifier: "权威标准中该任务无需技能点", confidence: 0.5, affectedNodeIds: [],
        }],
      }],
    }),
  });
  const proposal = await planner(context());
  const pkg = proposal?.riskPackage;
  assert.ok(pkg);
  assert.equal(pkg.deterministicIssues.length, 1, "确定性发现必须来自代码传入");
  assert.equal(pkg.domains.length, 1, "假设来自模型");
  assert.equal(pkg.baseSnapshotId, context().candidate.snapshot.id);
});

test("模型什么都不给时不产出空产物对象", async () => {
  const planner = buildProductPlanner({ model: modelReturning({}) });
  assert.equal(await planner(context()), undefined);
});

test("规划器失败向上抛出，交由图记录 productsFailed 而不是静默吞掉", async () => {
  const failing: ModelInvoker = async function* () { throw new Error("provider_down"); yield { type: "text", delta: "" }; };
  const planner = buildProductPlanner({ model: failing, issues: [] });
  await assert.rejects(planner(context()), /provider_down/u);
});

test("提示只给出可引用的片段与节点 id，并禁止用常识补齐", () => {
  const snapshot = bundledRoleSnapshot();
  const prompt = productPrompt({
    objective: "补齐技能",
    mode: "deep_research",
    evidence: [{ segmentId: "segment-1", excerpt: "原文" }],
    nodeIds: ["task-1"],
    findings: [{ code: "TASK_SKILL_GAP", title: "缺技能", detail: "d", targetIds: ["task-1"] }],
  });
  assert.match(prompt.system, /只引用下面给出的 segmentId 与节点 id/u);
  assert.match(prompt.system, /编造的 id 会被丢弃/u);
  assert.match(prompt.system, /必须带 falsifier/u);
  const payload = JSON.parse(prompt.user) as { availableSegments: unknown[]; availableNodeIds: unknown[] };
  assert.equal(payload.availableSegments.length, 1);
  assert.deepEqual(payload.availableNodeIds, ["task-1"]);
  void snapshot;
});
