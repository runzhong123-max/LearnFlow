#!/usr/bin/env bash
set -euo pipefail
MONOREPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec bash "$MONOREPO_ROOT/scripts/verify_repository_layout.sh"
