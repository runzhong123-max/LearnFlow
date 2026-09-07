import assert from "node:assert/strict";
import test from "node:test";
import { learningMountUrl, learningPointPreview, readLearningMountPackage, LearningReleaseRequired } from "@/lib/learning-path/presentation";
import { readOfficialLearningPath } from "@/lib/learning-path/load";
import type { RoleLearningProjection, SemanticNode } from "@/lib/build/types";
import { readEcosystemEntry } from "../../../frontend/src/ecosystem-entry";

const node = { id: "skill:coordination", type: "knowledge_skill", label: "协调与组织能力", learningKind: "hybrid" } as SemanticNode;
const projection = (mode: "exact" | "ambiguous" | "graph_gap") => ({ bindings: [{ semanticNodeId: node.id, mappingMode: mode, rationale: "fixture", ...(mode === "exact" ? { learningPathNodeId: "course:one" } : {}) }] }) as RoleLearningProjection;
const ref = { packageId: "role:private", packageVersion: "1.0.0", snapshotId: "snapshot:one", rootHash: "a".repeat(64) };

test("v1 matching and graph gaps remain previews and coarse points disclose decomposition", () => {
  assert.equal(learningPointPreview(node, projection("exact")).label, "名称匹配 · 待正式核对");
  assert.equal(learningPointPreview(node, projection("ambiguous")).label, "需要消歧");
  assert.equal(learningPointPreview(node, projection("graph_gap")).label, "尚无路径锚点");
  assert.match(learningPointPreview(node).needsDefinition, /拆分/);
  assert.match(learningPointPreview({ ...node, learningKind: "knowledge" }).needsDefinition, /范围/);
});

test("Role Atlas URL round-trips into LearnFlow exact package entry with no user or commit input", () => {
  const url = new URL(learningMountUrl(ref, "skill:SQL+查询"));
  assert.equal(url.origin, "https://learnflow.club");
  assert.deepEqual(readEcosystemEntry(url.search), { packageRef: ref, nodeId: "skill:SQL+查询" });
  assert.deepEqual([...url.searchParams.keys()].sort(), ["nodeId", "packageId", "packageVersion", "rootHash", "snapshotId"]);
  assert.throws(() => learningMountUrl(ref, node.id, "javascript:alert(1)"));
});

test("mount navigation selects the exact saved project version and verifies exported identity", async () => {
  const requests: string[] = [];
  const current = { id: "release:current", sourceProjectVersionId: "version:current", ...ref, artifactRootHash: ref.rootHash, status: "ready" };
  const fetcher = async function(this: unknown, path: RequestInfo | URL, init?: RequestInit) {
    assert.equal(this, undefined, "browser fetch must not be rebound to the helper input object");
    requests.push(String(path)); assert.ok(!init?.method || init.method === "GET");
    return Response.json(String(path).includes("/export") ? { manifest: { ...ref, sourceProjectVersionId: "version:current" } } : { releases: [{ ...current, id: "release:other", sourceProjectVersionId: "version:other" }, current] });
  };
  const input = { projectId: "project:mine", projectVersionId: "version:current", snapshotId: ref.snapshotId, fetcher: fetcher as typeof fetch, signal: new AbortController().signal };
  assert.deepEqual(await readLearningMountPackage(input), ref);
  assert.match(requests[1], /release%3Acurrent/);
  await assert.rejects(readLearningMountPackage({ ...input, projectVersionId: "version:missing" }), LearningReleaseRequired);
  await assert.rejects(readLearningMountPackage({ ...input, fetcher: (async (path) => String(path).includes("/export") ? Response.json({ manifest: { ...ref, snapshotId: "snapshot:wrong" } }) : fetcher(path)) as typeof fetch }), /不一致/);
});

test("shared cold-start and iteration path preparation rejects missing, invalid and cancelled graphs", async () => {
  const graph = { protocolVersion: "learnflow-learning-path/v1", nodes: [], edges: [] };
  const controller = new AbortController();
  assert.deepEqual(await readOfficialLearningPath((async () => Response.json(graph)) as typeof fetch, controller.signal), graph);
  await assert.rejects(readOfficialLearningPath((async () => new Response("", { status: 503 })) as typeof fetch, controller.signal), /尚未提交/);
  await assert.rejects(readOfficialLearningPath((async () => Response.json({})) as typeof fetch, controller.signal), /格式无效/);
  controller.abort();
  await assert.rejects(readOfficialLearningPath((async () => Response.json(graph)) as typeof fetch, controller.signal));
});
