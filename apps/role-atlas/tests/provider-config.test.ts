import assert from "node:assert/strict";
import test from "node:test";
import { POST as testProvider } from "@/app/api/providers/test/route";
import { validateProviderConfig } from "@/lib/provider-validation";
import { PROVIDERS, providerModelsEndpoint } from "@/lib/providers";

test("供应商地址和模型只能从服务端白名单选择", () => {
  const mimo = validateProviderConfig({ provider: "mimo", model: "mimo-v2.5", apiKey: "test-key-long", thinking: false });
  const deepseek = validateProviderConfig({ provider: "deepseek", model: "deepseek-v4-flash", apiKey: "test-key-long", thinking: true });
  assert.equal(mimo.thinking, true);
  assert.equal(PROVIDERS[mimo.provider].baseUrl, "https://api.xiaomimimo.com/v1");
  assert.equal(PROVIDERS[deepseek.provider].baseUrl, "https://api.deepseek.com");
  assert.equal(providerModelsEndpoint("mimo"), "https://api.xiaomimimo.com/v1/models");
  assert.equal(providerModelsEndpoint("deepseek"), "https://api.deepseek.com/models");
  assert.throws(() => validateProviderConfig({ provider: "deepseek", model: "attacker-model", apiKey: "test-key-long", thinking: false }));
});

test("未登录的连接测试在读取配置前拒绝，且不在响应中回显密钥", async () => {
  const apiKey = "secret-should-never-appear";
  const response = await testProvider(new Request("http://localhost/api/providers/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { provider: "deepseek", model: "attacker-model", apiKey, thinking: false } }),
  }));
  const text = await response.text();
  assert.ok([401, 503].includes(response.status));
  assert.doesNotMatch(text, new RegExp(apiKey));
  assert.match(text, /LOGIN_REQUIRED|IDENTITY_SERVICE_NOT_CONFIGURED/);
});
