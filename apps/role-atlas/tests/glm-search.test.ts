import assert from "node:assert/strict";
import test from "node:test";
import { searchGlm, testSearchProvider } from "@/lib/search/web-research";
import { coldStartRequestSchema } from "@/lib/build/types";
import { resolveSearchProviderConfig, runtimeConfigStatus } from "@/lib/server-runtime-config";

const request = coldStartRequestSchema.parse({ runId: "test-run", projectId: "test-project", roleTitle: "软件测试工程师" });
test("GLM 请求遵守官方限制并保留来源和 request_id，过滤内网 URL", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://open.bigmodel.cn/api/paas/v4/web_search");
      const body = JSON.parse(String(init?.body));
      assert.equal([...body.search_query].length, 70);
      assert.equal(body.search_engine, "search_pro");
      assert.equal(body.search_intent, false);
      assert.equal(body.count, 10);
      assert.match(body.request_id, /^[a-f\d-]{36}$/);
      return Response.json({ request_id: "provider-trace", search_result: [
        { title: "岗位标准", link: "https://www.moe.gov.cn/role", content: "岗位职责与典型任务", media: "教育部", publish_date: "2026-09-01" },
        { link: "http://127.0.0.1/secret", content: "private" }, null,
      ] });
    };
    const result = await searchGlm({ provider: "glm", apiKey: "test-only-key" }, { id: "q1", category: "job_market", query: "岗位".repeat(80), priority: 1 }, request);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].publisher, "教育部");
    assert.equal(result.results[0].publishedAt, "2026-09-01");
    assert.equal(result.requestId, "provider-trace");
  } finally { globalThis.fetch = previous; }
});

test("GLM 连通性测试不走旧厂商，空结果与业务错误分开", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /bigmodel.cn/);
      return Response.json({ search_result: [] });
    };
    assert.equal((await testSearchProvider({ provider: "glm", apiKey: "test-only-key" })).resultCount, 0);
    globalThis.fetch = async () => Response.json({ error: { code: "1113" } });
    await assert.rejects(testSearchProvider({ provider: "glm", apiKey: "test-only-key" }), /INVALID_RESPONSE/);
    globalThis.fetch = async () => new Response("", { status: 401 });
    await assert.rejects(testSearchProvider({ provider: "glm", apiKey: "test-only-key" }), /401/);
  } finally { globalThis.fetch = previous; }
});

test("服务端 GLM 配置不泄露密钥且不接受客户端覆盖", () => {
  const bindings = { ROLE_ATLAS_SEARCH_PROVIDER: "glm", GLM_API_KEY: "server-glm-secret", ROLE_ATLAS_SEARCH_ENGINE: "search_pro" };
  const config = resolveSearchProviderConfig({ provider: "tavily", apiKey: "client-secret" }, bindings);
  assert.equal(config.provider, "glm"); assert.equal(config.apiKey, bindings.GLM_API_KEY);
  assert.equal(config.engine, "search_pro");
  assert.doesNotMatch(JSON.stringify(runtimeConfigStatus(bindings)), /secret/);
  assert.throws(() => resolveSearchProviderConfig(undefined, { ...bindings, ROLE_ATLAS_SEARCH_ENGINE: "invalid" }));
});
