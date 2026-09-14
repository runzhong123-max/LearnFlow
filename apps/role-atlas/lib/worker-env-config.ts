/** Explicit server-only Worker bindings; never forward the entire host environment. */
const allowedRuntimeKeys = [
  "MIMO_API_KEY",
  "DEEPSEEK_API_KEY",
  "TAVILY_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
  "ROLE_ATLAS_SEARCH_ENGINE",
  "EXA_API_KEY",
  "BOCHA_API_KEY",
  "ROLE_ATLAS_MODEL_PROVIDER",
  "ROLE_ATLAS_MODEL",
  "ROLE_ATLAS_MODEL_BASE_URL",
  "ROLE_ATLAS_SEARCH_PROVIDER",
  "LEARNFLOW_BASE_URL",
  "LEARNFLOW_PUBLIC_URL",
  "ROLE_PACKAGE_LAUNCH_SECRET",
  "ROLE_ATLAS_GATEWAY_SECRET",
  "ROLE_ATLAS_GATEWAY_ONLY",
  "ROLE_ATLAS_PUBLIC_URL",
  "GRAPH_HUB_PUBLIC_URL",
  "ROLE_ATLAS_RESEARCH_AGENT",
  "WORK_TASK_PUBLIC_URL",
] as const;

export function selectWorkerEnv(env: Record<string, string | undefined>) {
  return Object.fromEntries(allowedRuntimeKeys.flatMap((key) => env[key] ? [[key, env[key]]] : []));
}
