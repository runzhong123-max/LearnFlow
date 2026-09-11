import assert from "node:assert/strict";
import test from "node:test";
import { workspaceSkillDefinitions, workspaceSkillHref } from "@/lib/skills/workspace";

test("持久化岗位项目的技能入口绑定当前项目与会话", () => {
  const context = {
    snapshotId: "snapshot:robot@2026-08-22",
    projectId: "project:robot",
    versionId: "version:robot:1",
    conversationId: "conversation:1",
    roleTitle: "工业机器人系统运维员",
  };
  assert.equal(
    workspaceSkillHref("snapshot-iteration", context),
    "/snapshots/snapshot%3Arobot%402026-08-22/iterate?profile=co_guided&project=project%3Arobot&version=version%3Arobot%3A1&conversation=conversation%3A1",
  );
});

test("内置静态快照也直接进入统一技能工作流，不回退冷启动", () => {
  const context = {
    snapshotId: "snapshot:role:llm-app-engineer@2026-08-19",
    roleTitle: "大模型应用工程师",
    market: "中国大陆",
  };
  assert.deepEqual(workspaceSkillDefinitions.map((skill) => skill.label), ["迭代岗位包", "深化选中节点"]);
  const iterationHref = workspaceSkillHref("snapshot-iteration", context);
  assert.equal(iterationHref, "/snapshots/snapshot%3Arole%3Allm-app-engineer%402026-08-19/iterate?profile=co_guided");
  assert.doesNotMatch(iterationHref, /projects\/new|cold|role=/);
});

test("节点深化 Skill 复用统一迭代运行时并预填选中节点", () => {
  const href = workspaceSkillHref("node-deepening", {
    snapshotId: "snapshot:robot@2026-08-22",
    projectId: "project:robot",
    conversationId: "conversation:1",
    selectedNodeIds: ["task:diagnose", "skill:plc"],
    roleTitle: "工业机器人系统运维员",
  });
  const url = new URL(href, "http://role-atlas.local");
  assert.equal(url.pathname, "/snapshots/snapshot%3Arobot%402026-08-22/iterate");
  assert.equal(url.searchParams.get("profile"), "user_directed");
  assert.equal(url.searchParams.get("project"), "project:robot");
  assert.equal(url.searchParams.get("targets"), "task:diagnose,skill:plc");
  assert.match(url.searchParams.get("prompt") || "", /深化证据/);
});

test("真实工作区入口已从技能目录下线", () => {
  assert.equal(workspaceSkillDefinitions.some((skill) => skill.id === "workspace-instantiation"), false);
});
