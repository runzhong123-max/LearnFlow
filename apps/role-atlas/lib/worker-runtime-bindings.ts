import { env } from "cloudflare:workers";
import type { ServerRuntimeBindings } from "./server-runtime-config";

/** Worker-only adapter; keeping it separate leaves pure config tests runnable in Node. */
export function workerRuntimeBindings() {
  const bindings = env as unknown as Record<string, unknown>;
  return {
    ROLE_ATLAS_GATEWAY_SECRET: bindings.ROLE_ATLAS_GATEWAY_SECRET,
    MIMO_API_KEY: bindings.MIMO_API_KEY,
    DEEPSEEK_API_KEY: bindings.DEEPSEEK_API_KEY,
    TAVILY_API_KEY: bindings.TAVILY_API_KEY,
    GLM_API_KEY: bindings.GLM_API_KEY,
    ZHIPU_API_KEY: bindings.ZHIPU_API_KEY,
    ROLE_ATLAS_SEARCH_ENGINE: bindings.ROLE_ATLAS_SEARCH_ENGINE,
    EXA_API_KEY: bindings.EXA_API_KEY,
    BOCHA_API_KEY: bindings.BOCHA_API_KEY,
    ROLE_ATLAS_MODEL_PROVIDER: bindings.ROLE_ATLAS_MODEL_PROVIDER,
    ROLE_ATLAS_MODEL: bindings.ROLE_ATLAS_MODEL,
    ROLE_ATLAS_MODEL_BASE_URL: bindings.ROLE_ATLAS_MODEL_BASE_URL,
    ROLE_ATLAS_SEARCH_PROVIDER: bindings.ROLE_ATLAS_SEARCH_PROVIDER,
  } satisfies ServerRuntimeBindings;
}
