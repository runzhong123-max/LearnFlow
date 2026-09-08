import assert from "node:assert/strict";
import test from "node:test";
import { prepareTaskRelease } from "@/lib/integrations/learnflow/prepare-task-release";

const input = () => ({ projectId: "project-1", projectVersionId: "version-1", snapshotId: "snapshot-1", signal: new AbortController().signal });
const release = { id: "release-1", sourceProjectVersionId: "version-1", snapshotId: "snapshot-1", status: "ready", artifactRootHash: "hash-1" };

test("私有 ready 版本无需推荐或公开发布即可复用", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return Response.json({ releases: [release] }); };
  assert.equal(await prepareTaskRelease(input(), request), release.id);
  assert.equal(calls, 1);
});

test("旧会话版本不能替代当前版本；重试使用相同私有版本号且不发布", async () => {
  const bodies: Record<string, unknown>[] = [];
  const request: typeof fetch = async (url, init) => {
    if (init?.method === "POST") {
      assert.equal(url, "/api/releases");
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ release });
    }
    return Response.json({ releases: [{ ...release, sourceProjectVersionId: "older" }, { ...release, snapshotId: "other" }] });
  };
  await prepareTaskRelease(input(), request);
  await prepareTaskRelease(input(), request);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].action, "prepare");
  assert.equal(bodies[0].visibility, "private");
  assert.equal(bodies[0].evidencePolicy, "metadata");
  assert.equal(bodies[0].projectVersionId, "version-1");
  assert.match(String(bodies[0].packageVersion), /^0\.0\.0-conversion\.[a-f0-9]{64}$/);
});

test("校验失败与错误来源版本都不能交接", async () => {
  for (const result of [{ ...release, status: "failed", error: "缺少任务证据" }, { ...release, sourceProjectVersionId: "other" }, { ...release, artifactRootHash: null }]) {
    const request: typeof fetch = async (_url, init) => Response.json(init?.method === "POST" ? { release: result } : { releases: [] });
    await assert.rejects(prepareTaskRelease(input(), request));
  }
});

test("读取被拒绝时不创建岗位包", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return Response.json({ error: "DENIED" }, { status: 403 }); };
  await assert.rejects(prepareTaskRelease(input(), request), /登录状态/);
  assert.equal(calls, 1);
});
