import { validateProviderConfig } from "./provider-validation";
import { providerIds, PROVIDERS, type ProviderConfig, type ProviderId } from "./providers";
import { searchProviderConfigSchema, searchProviderIds, type SearchProviderConfig, type SearchProviderId } from "./search/providers";
import type { RuntimeConfigStatus } from "./runtime-config";

function nonEmpty(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type ServerRuntimeBindings = Record<string, unknown>;

function runtimeValue(key: string, bindings?: ServerRuntimeBindings) {
  return nonEmpty(bindings?.[key]) || nonEmpty(process.env[key]);
}

function envProvider(bindings?: ServerRuntimeBindings): ProviderId {
  const requested = runtimeValue("ROLE_ATLAS_MODEL_PROVIDER", bindings);
  return providerIds.includes(requested as ProviderId) ? requested as ProviderId : "mimo";
}

function envSearchProvider(bindings?: ServerRuntimeBindings): SearchProviderId {
  const requested = runtimeValue("ROLE_ATLAS_SEARCH_PROVIDER", bindings);
  return searchProviderIds.includes(requested as SearchProviderId) ? requested as SearchProviderId : "glm";
}

function providerKey(provider: ProviderId, bindings?: ServerRuntimeBindings) {
  return runtimeValue(provider === "mimo" ? "MIMO_API_KEY" : "DEEPSEEK_API_KEY", bindings);
}

function searchKey(provider: SearchProviderId, bindings?: ServerRuntimeBindings) {
  if (provider === "glm") return runtimeValue("GLM_API_KEY", bindings) || runtimeValue("ZHIPU_API_KEY", bindings);
  if (provider === "tavily") return runtimeValue("TAVILY_API_KEY", bindings);
  if (provider === "exa") return runtimeValue("EXA_API_KEY", bindings);
  return runtimeValue("BOCHA_API_KEY", bindings);
}

export function runtimeConfigStatus(bindings?: ServerRuntimeBindings): RuntimeConfigStatus {
  const provider = envProvider(bindings);
  const requestedModel = runtimeValue("ROLE_ATLAS_MODEL", bindings);
  const model = requestedModel && PROVIDERS[provider].models.some((item) => item.id === requestedModel)
    ? requestedModel
    : PROVIDERS[provider].defaultModel;
  const searchProvider = envSearchProvider(bindings);
  return {
    model: { configured: Boolean(providerKey(provider, bindings)), provider, model, source: providerKey(provider, bindings) ? "server_env" : "none" },
    search: { configured: Boolean(searchKey(searchProvider, bindings)), provider: searchProvider, source: searchKey(searchProvider, bindings) ? "server_env" : "none" },
  };
}

export function resolveProviderConfig(input?: unknown, bindings?: ServerRuntimeBindings): ProviderConfig {
  void input;
  const provider = envProvider(bindings);
  const requestedModel = runtimeValue("ROLE_ATLAS_MODEL", bindings);
  const model = requestedModel && PROVIDERS[provider].models.some((item) => item.id === requestedModel)
    ? requestedModel
    : PROVIDERS[provider].defaultModel;
  const apiKey = providerKey(provider, bindings);
  if (!apiKey) throw new Error("SERVER_MODEL_NOT_CONFIGURED");
  const baseUrl = runtimeValue("ROLE_ATLAS_MODEL_BASE_URL", bindings);
  return validateProviderConfig({ provider, model, apiKey, thinking: true, ...(baseUrl ? { baseUrl } : {}) });
}

export function resolveSearchProviderConfig(input?: unknown, bindings?: ServerRuntimeBindings): SearchProviderConfig {
  void input;
  const provider = envSearchProvider(bindings);
  const apiKey = searchKey(provider, bindings);
  if (!apiKey) throw new Error("SERVER_SEARCH_NOT_CONFIGURED");
  return searchProviderConfigSchema.parse({ provider, apiKey, ...(provider === "glm" ? { engine: runtimeValue("ROLE_ATLAS_SEARCH_ENGINE", bindings) || "search_pro" } : {}) });
}
