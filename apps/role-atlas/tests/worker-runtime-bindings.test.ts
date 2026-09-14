import assert from "node:assert/strict";
import test from "node:test";
import { selectWorkerEnv } from "../lib/worker-env-config";
import { researchAgentEnabled } from "../lib/iteration/research-agent";
import { conversionLaunchUrl } from "../lib/integrations/learnflow/task-launch";

test("Worker bindings preserve explicit research disable and default enable", () => {
  assert.equal(researchAgentEnabled(selectWorkerEnv({ ROLE_ATLAS_RESEARCH_AGENT: "0" })), false);
  assert.equal(researchAgentEnabled(selectWorkerEnv({ ROLE_ATLAS_RESEARCH_AGENT: "1" })), true);
  assert.equal(researchAgentEnabled(selectWorkerEnv({})), true);
});

test("task conversion respects its own origin after crossing the Worker binding boundary", () => {
  const env = selectWorkerEnv({
    LEARNFLOW_PUBLIC_URL: "https://learn.example.com",
    WORK_TASK_PUBLIC_URL: "https://tasks.example.com",
  });
  const url = new URL(conversionLaunchUrl(env.WORK_TASK_PUBLIC_URL || env.LEARNFLOW_PUBLIC_URL, "signed-ticket"));
  assert.equal(url.origin, "https://tasks.example.com");
  const fallback = selectWorkerEnv({ LEARNFLOW_PUBLIC_URL: env.LEARNFLOW_PUBLIC_URL, WORK_TASK_PUBLIC_URL: "" });
  assert.equal(new URL(conversionLaunchUrl(fallback.WORK_TASK_PUBLIC_URL || fallback.LEARNFLOW_PUBLIC_URL, "signed-ticket")).origin, "https://learn.example.com");
});

test("only declared application settings reach the Worker", () => {
  const env = selectWorkerEnv({
    LEARNFLOW_BASE_URL: "http://localhost:8010",
    MIMO_API_KEY: "test-provider-key",
    ROLE_ATLAS_GATEWAY_ONLY: "false",
    UNRELATED_SECRET: "must-not-be-forwarded",
    HOME: "/private/host-home",
    WORK_TASK_PUBLIC_URL: undefined,
  });
  assert.equal(env.LEARNFLOW_BASE_URL, "http://localhost:8010");
  assert.equal(env.MIMO_API_KEY, "test-provider-key");
  assert.equal(env.ROLE_ATLAS_GATEWAY_ONLY, "false");
  assert.equal(Object.hasOwn(env, "UNRELATED_SECRET"), false);
  assert.equal(Object.hasOwn(env, "HOME"), false);
  assert.equal(Object.hasOwn(env, "WORK_TASK_PUBLIC_URL"), false);
});
