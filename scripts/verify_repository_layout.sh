#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

required_paths=(
  "frontend/package.json"
  "frontend/src/main.tsx"
  "frontend/server/agent-runtime.ts"
  "backend/app/main.py"
  "backend/app/services/architecture_registry.py"
  "apps/desktop/desktop/src-tauri/tauri.conf.json"
  "apps/desktop/frontend/package.json"
  "apps/desktop/backend/app/main.py"
  "packages/learning-core/src/learnflow_core/learning_runtime.py"
  "packages/learning-client/src/password-policy.ts"
  "start.sh"
  "apps/role-atlas/package.json"
  "apps/role-atlas/app/hub/page.tsx"
  "apps/role-atlas/deploy/cohost/compose.yaml"
)

for required_path in "${required_paths[@]}"; do
  if [ ! -e "$required_path" ]; then
    echo "缺少正式 LearnFlow 入口：$required_path" >&2
    exit 1
  fi
done

legacy_tracked="$(git ls-files 'vnext/**' 'legacy-frontend/**' 'frontend-old/**' 'output/**')"
if [ -n "$legacy_tracked" ]; then
  echo "检测到重新进入版本管理的旧实现：" >&2
  echo "$legacy_tracked" >&2
  exit 1
fi

legacy_runtime_refs="$(git grep -n -E '(localhost|127\.0\.0\.1):5173|(^|[^[:alnum:]_])vnext/' -- ':!docs/**' ':!apps/desktop/docs/**' ':!apps/desktop/README.md' ':!apps/desktop/AGENTS.md' ':!README.md' ':!AGENTS.md' ':!scripts/verify_repository_layout.sh' ':!*.lock' || true)"
if [ -n "$legacy_runtime_refs" ]; then
  echo "检测到旧前端运行入口或路径：" >&2
  echo "$legacy_runtime_refs" >&2
  exit 1
fi

echo "目录权威有效：Web、Desktop 与 Role Atlas 同仓，共享学习实现位于 packages/。"
