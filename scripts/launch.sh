#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COHOST="$ROOT/apps/role-atlas/deploy/cohost"
ENV_FILE="${LEARNFLOW_LAUNCH_ENV:-$COHOST/.env}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COHOST/compose.yaml" "$@"; }
check() {
  python3 - "$ENV_FILE" <<'PY'
import base64,sys
from pathlib import Path
p=Path(sys.argv[1])
if not p.is_file():raise SystemExit('Create the private config with scripts/prepare_launch.py first.')
values={line.split('=',1)[0]:line.split('=',1)[1].strip() for line in p.read_text().splitlines() if line and not line.startswith('#') and '=' in line}
required=['ROOT_HOST','LEARNFLOW_HOST','ROLE_ATLAS_HOST','GRAPH_HUB_HOST','AUTH_COOKIE_DOMAIN','LEARNFLOW_LLM_API_KEY','LEARNFLOW_LLM_BASE_URL','LEARNFLOW_LLM_MODEL','DEEPSEEK_API_KEY','TAVILY_API_KEY','AUTH_RUNTIME_BRIDGE_TOKEN','ROLE_PACKAGE_LAUNCH_SECRET','ROLE_ATLAS_GATEWAY_SECRET','REGISTRATION_INVITE_CODE','AUTH_API_KEY_KEK']
missing=[k for k in required if not values.get(k)]
if missing:raise SystemExit('Fill configuration fields: '+', '.join(missing))
if any('example.com' in values[k] for k in ['ROOT_HOST','LEARNFLOW_HOST','ROLE_ATLAS_HOST','GRAPH_HUB_HOST']):raise SystemExit('Replace placeholder domains before launch.')
keys=[values[k] for k in ['AUTH_RUNTIME_BRIDGE_TOKEN','ROLE_PACKAGE_LAUNCH_SECRET','ROLE_ATLAS_GATEWAY_SECRET','REGISTRATION_INVITE_CODE']]
if any(len(k)<32 for k in keys) or len(set(keys))!=len(keys):raise SystemExit('Independent signing/invite secrets of at least 32 characters are required.')
try:valid=len(base64.b64decode(values['AUTH_API_KEY_KEK'],altchars=b'-_',validate=True))==32
except Exception:valid=False
if not valid:raise SystemExit('AUTH_API_KEY_KEK must encode 32 bytes.')
print('Configuration fields and key formats checked; values are not printed.')
PY
  compose config --quiet
}
case "${1:-check}" in
  check) check ;;
  up) check; compose up -d --build ;;
  status) compose ps ;;
  logs) compose logs --tail 100 ;;
  *) echo 'Usage: bash scripts/launch.sh check|up|status|logs' >&2; exit 2 ;;
esac
