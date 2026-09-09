import assert from "node:assert/strict";
import test from "node:test";
import { chatDraftKey, readChatDraft, requireAgentStream, restoreChatReferences, saveChatDraft } from "@/lib/chat/workspace-state";

const memoryStorage = () => {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) || null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
};

test("草稿按主体、项目、对话与快照隔离，重载后仍保留正文和固定引用", () => {
  const storage = memoryStorage();
  const key = chatDraftKey("learner:1", "project:a", "chat:a", "snapshot:a");
  const references = restoreChatReferences([{ targetId: "task:deploy", label: "部署服务", snapshotId: "snapshot:a", packageId: "package:a", packageVersion: "1.0" }]);
  const draft = { text: "解释这个任务", references };
  saveChatDraft(storage, key, draft, 1_000);
  assert.deepEqual(readChatDraft(storage, key, 2_000), draft);
  for (const scope of [["learner:2", "project:a", "chat:a", "snapshot:a"], ["learner:1", "project:b", "chat:a", "snapshot:a"], ["learner:1", "project:a", "chat:b", "snapshot:a"], ["learner:1", "project:a", "chat:a", "snapshot:b"]]) {
    assert.equal(readChatDraft(storage, chatDraftKey(scope[0], scope[1], scope[2], scope[3]), 2_000).text, "");
  }
  saveChatDraft(storage, key, { text: "", references: [] });
  assert.equal(storage.getItem(key!), null);
});

test("未确认身份的内容不持久化，过期和坏格式草稿不恢复", () => {
  const storage = memoryStorage();
  assert.equal(chatDraftKey("", "p", "c", "s"), undefined);
  assert.equal(chatDraftKey("a", "p", "", "s"), undefined);
  const key = chatDraftKey("a", undefined, "", "s")!;
  saveChatDraft(storage, key, { text: "expired", references: [] }, 0);
  assert.equal(readChatDraft(storage, key, 86_400_001).text, "");
  storage.setItem(key, "malformed");
  assert.equal(readChatDraft(storage, key).text, "");
});

test("历史引用 targetId 正确显示，旧快照不会被当前同 ID 节点覆盖", () => {
  const current = restoreChatReferences([{ targetId: "task:a", label: "新版本标题", snapshotId: "snapshot:new" }])[0];
  const historical = restoreChatReferences([{ targetId: "task:a", snapshotId: "snapshot:old", packageVersion: "1" }], [current], "snapshot:new")[0];
  assert.equal(historical.id, "task:a");
  assert.equal(historical.label, "历史节点 · task:a");
  assert.equal(historical.snapshotId, "snapshot:old");
  assert.equal(historical.packageVersion, "1");
  const matching = restoreChatReferences([{ targetId: "task:a", snapshotId: "snapshot:new" }], [current], "snapshot:new")[0];
  assert.equal(matching.label, "新版本标题");
  assert.deepEqual(restoreChatReferences([null, {}, { targetId: 42 }]), []);
});

test("登录失效及登录页响应明确失败，只有有效 NDJSON 能作为回答流", async () => {
  for (const status of [401, 403]) await assert.rejects(requireAgentStream(Response.json({ error: "unauthorized" }, { status })), /问题与引用已保留/u);
  await assert.rejects(requireAgentStream(new Response("<html>login</html>", { headers: { "content-type": "text/html" } })), /有效的岗位回答流/u);
  await assert.rejects(requireAgentStream(new Response("bad gateway", { status: 502 })), /502/u);
  const response = new Response('{"kind":"answer.completed"}\n', { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  assert.equal(await requireAgentStream(response), response.body);
});
