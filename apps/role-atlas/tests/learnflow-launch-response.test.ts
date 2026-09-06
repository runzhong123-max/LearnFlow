import assert from "node:assert/strict";
import test from "node:test";
import { readLearnFlowLaunchResponse } from "@/lib/integrations/learnflow/launch-response";

test("引用成功保留服务端签发的固定版本跳转", async () => {
  const launchUrl = "https://learn.example.com/launch/role-package/signed-token";
  assert.equal(await readLearnFlowLaunchResponse(Response.json({ launchUrl })), launchUrl);
});

test("目录故障与登录失败提供不同的可操作提示", async () => {
  await assert.rejects(readLearnFlowLaunchResponse(Response.json({ error: "ROLE_ATLAS_REGISTRY_UNAVAILABLE" }, { status: 503 })), /岗位包目录.*ROLE_ATLAS_REGISTRY_UNAVAILABLE/u);
  await assert.rejects(readLearnFlowLaunchResponse(Response.json({ error: "LEARNFLOW_LOGIN_REQUIRED" }, { status: 401 })), /请先登录 LearnFlow/u);
});

test("代理非 JSON 错误和无效成功响应不会泄露解析异常或跳转", async () => {
  for (const response of [new Response("<html>Bad Gateway</html>", { status: 502 }), Response.json(null), Response.json({ launchUrl: 42 })]) {
    await assert.rejects(readLearnFlowLaunchResponse(response), /无法进入 LearnFlow.*HTTP/u);
  }
  await assert.rejects(readLearnFlowLaunchResponse(Response.json({ launchUrl: "https://learn.example.com" }, { status: 503 })), /无法进入 LearnFlow/u);
});
