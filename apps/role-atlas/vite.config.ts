import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";
  // Vite 8 deliberately withholds key-like names from loadEnv. Load the
  // ignored local development file into the Node config process, then pass an
  // explicit allow-list to the Worker binding instead of exposing all env.
  try { process.loadEnvFile?.(".env.local"); } catch { /* optional local file */ }
  const localEnv = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
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
  ] as const;
  const vars = Object.fromEntries(allowedRuntimeKeys.flatMap((key) => localEnv[key] ? [[key, localEnv[key]]] : []));
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
    vars,
    d1_databases: d1
      ? [{ binding: d1, database_name: "site-creator-d1", database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID }]
      : [],
    r2_buckets: r2
      ? [{ binding: r2, bucket_name: "site-creator-r2" }]
      : [],
  };

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        ...(localEnv.ROLE_ATLAS_STATE_DIR ? { persistState: { path: localEnv.ROLE_ATLAS_STATE_DIR } } : {}),
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
