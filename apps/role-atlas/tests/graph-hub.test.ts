import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  exportGraphHubView,
  initializeGraphHub,
  reviewGraphHubSubmission,
  searchGraphHubFile,
  submitGraphToHub,
} from "@/lib/graph-hub/file-graph-hub";

async function graphFile(root: string, id: string, title: string, label: string) {
  const file = join(root, `${id}.json`);
  await writeFile(file, JSON.stringify({
    protocol: "graph-hub-document.v1",
    graphId: id,
    version: "1.0.0",
    graphType: "knowledge",
    title,
    summary: `${title}的知识结构`,
    keywords: ["Agent", "评测"],
    nodes: [{ id: `${id}:node`, label, type: "knowledge_skill", summary: "构建可靠的 Agent 评测" }],
    edges: [],
  }), "utf8");
  return file;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "graph-hub-"));
  const hub = join(root, "hub");
  await initializeGraphHub({
    hubRoot: hub,
    policy: {
      protocol: "graph-hub-policy.v1",
      officialMaintainerSubjects: ["official:learnflow"],
      reviewerSubjects: ["reviewer:one", "learnflow:learner:7"],
    },
  });
  return { root, hub };
}

test("个人未审核图只进入所有者作用域目录，审核后才进入公共目录", async () => {
  const { root, hub } = await setup();
  const personal = await submitGraphToHub({
    hubRoot: hub,
    graphFile: await graphFile(root, "alice-agent-map", "Alice 的 Agent 图", "Agent 评测"),
    ownerSubjectId: "learnflow:learner:7",
    maintainerName: "Alice",
    kind: "personal",
  });
  assert.equal(personal.reviewStatus, "pending");
  const publicCatalog = JSON.parse(await readFile(join(hub, "catalog.json"), "utf8"));
  assert.equal(publicCatalog.entries.length, 0);

  const ownerView = join(root, "owner-catalog.json");
  await exportGraphHubView({ hubRoot: hub, outputFile: ownerView, actorSubjectId: "learnflow:learner:7" });
  const ownerResults = await searchGraphHubFile({
    catalogFile: ownerView,
    actorSubjectId: "learnflow:learner:7",
    query: "Agent 评测",
  });
  assert.equal(ownerResults.length, 1);
  assert.equal(ownerResults[0].entry.review, "pending_owner");
  await assert.rejects(searchGraphHubFile({
    catalogFile: ownerView,
    actorSubjectId: "learnflow:learner:8",
    query: "Agent 评测",
  }), /GRAPH_HUB_AUDIENCE_MISMATCH/u);

  await assert.rejects(reviewGraphHubSubmission({
    hubRoot: hub,
    submissionId: personal.submissionId,
    reviewerSubjectId: "learnflow:learner:7",
    decision: "approve",
  }), /SELF_REVIEW_FORBIDDEN/u);
  await reviewGraphHubSubmission({
    hubRoot: hub,
    submissionId: personal.submissionId,
    reviewerSubjectId: "reviewer:one",
    decision: "approve",
  });
  const publicResults = await searchGraphHubFile({ catalogFile: join(hub, "catalog.json"), query: "Agent 评测" });
  assert.equal(publicResults.length, 1);
  assert.equal(publicResults[0].entry.review, "approved");
  assert.equal(publicResults[0].entry.access, "public");
});

test("官方图只允许官方维护主体提交并直接进入公共检索", async () => {
  const { root, hub } = await setup();
  const file = await graphFile(root, "official-course-map", "官方课程图", "软件工程评测");
  await assert.rejects(submitGraphToHub({
    hubRoot: hub, graphFile: file, ownerSubjectId: "learnflow:learner:7", maintainerName: "Alice", kind: "official",
  }), /OFFICIAL_MAINTAINER_REQUIRED/u);
  await submitGraphToHub({
    hubRoot: hub, graphFile: file, ownerSubjectId: "official:learnflow", maintainerName: "LearnFlow", kind: "official",
  });
  const results = await searchGraphHubFile({ catalogFile: join(hub, "catalog.json"), query: "软件工程" });
  assert.equal(results.length, 1);
  assert.equal(results[0].entry.review, "official");
});

test("无岗位包的图谱提交后自动归类，分类浏览保持审核可见性", async () => {
  const { root, hub } = await setup();
  await submitGraphToHub({
    hubRoot: hub, graphFile: await graphFile(root, "nursing", "护理岗位图谱", "护理技能"),
    ownerSubjectId: "official:learnflow", maintainerName: "LearnFlow", kind: "official",
  });
  const results = await searchGraphHubFile({ catalogFile: join(hub, "catalog.json"), query: "", category: "医疗与健康" });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].entry.categories, ["医疗与健康"]);
  assert.equal((await searchGraphHubFile({ catalogFile: join(hub, "catalog.json"), query: "", category: "金融与财务" })).length, 0);
});
