#!/usr/bin/env bash
# LearnFlow 一键启动脚本
# 使用: bash start.sh         (启动 + 自动打开浏览器)
#       bash start.sh demo    (隔离数据库 + 离线比赛演示)
#       bash start.sh stop    (停止)
#       bash start.sh status  (查看状态)

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
VENV_DIR="$BACKEND_DIR/venv"
REGULAR_PID_FILE="/tmp/learnflow-desktop-dev-pids"
DEMO_PID_FILE="/tmp/learnflow-desktop-dev-demo-pids"
PID_FILE="$REGULAR_PID_FILE"
BACKEND_PORT=8011
FRONTEND_PORT=4175
OPEN_URL="http://localhost:$FRONTEND_PORT"
BACKEND_LOG="/tmp/learnflow-desktop-dev-backend.log"
FRONTEND_LOG="/tmp/learnflow-desktop-dev-frontend.log"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

banner() {
  echo -e "${BLUE}"
  echo "  _                   _____ _                "
  echo " | |   ___  ___ __ _|  ___| | _____      __ "
  echo " | |  / _ \/ __/ _\` | |_  | |/ _ \ \ /\ / /"
  echo " | |_|  __/ (_| (_| |  _| | | (_) \ V  V / "
  echo " |_____\___|\___\__,_|_|   |_|\___/ \_/\_/  "
  echo -e "${NC}"
  echo -e "${GREEN}AI 驱动的自适应学习平台${NC}"
  echo ""
}

check_deps() {
  # Python + venv. Pinned native dependencies currently support Python
  # 3.10-3.13. Keep an incompatible/stale user venv untouched and select a
  # healthy compatible environment instead of failing later in the seed step.
  local candidate_venv
  local system_python
  local startup_venv="$BACKEND_DIR/runtime/startup-venv"
  for candidate_venv in "$VENV_DIR" "$ROOT_DIR/../../backend/venv" "$BACKEND_DIR"/venv* "$startup_venv"; do
    if [ -x "$candidate_venv/bin/python" ] \
      && "$candidate_venv/bin/python" -c 'import sys; raise SystemExit(not ((3, 10) <= sys.version_info[:2] < (3, 14)))' >/dev/null 2>&1 \
      && "$candidate_venv/bin/python" -c 'import fastapi, sqlalchemy, aiosqlite, uvicorn' >/dev/null 2>&1; then
      VENV_DIR="$candidate_venv"
      break
    fi
  done

  if [ ! -x "$VENV_DIR/bin/python" ] \
    || ! "$VENV_DIR/bin/python" -c 'import sys; raise SystemExit(not ((3, 10) <= sys.version_info[:2] < (3, 14)))' >/dev/null 2>&1; then
    for system_python in python3.13 python3.12 python3.11 python3.10 python3; do
      if command -v "$system_python" >/dev/null 2>&1 \
        && "$system_python" -c 'import sys; raise SystemExit(not ((3, 10) <= sys.version_info[:2] < (3, 14)))' >/dev/null 2>&1; then
        mkdir -p "$BACKEND_DIR/runtime"
        "$system_python" -m venv "$startup_venv"
        VENV_DIR="$startup_venv"
        break
      fi
    done
  fi

  if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo -e "${RED}❌ 未找到 Python 3.10-3.13，无法创建后端运行环境${NC}"
    exit 1
  fi

  # A stale or partially-created venv is more common than a missing one. The
  # old existence-only check let startup continue until an unrelated import
  # error, so verify and repair runtime imports before seeding or serving.
  if ! "$VENV_DIR/bin/python" -c 'import fastapi, sqlalchemy, aiosqlite, uvicorn' >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠  后端 venv 依赖不完整，正在修复...${NC}"
    "$VENV_DIR/bin/python" -m pip install -q -r "$BACKEND_DIR/requirements.txt"
    echo -e "${GREEN}✅ 后端依赖修复完成${NC}"
  fi

  # .env
  if [ ! -f "$BACKEND_DIR/.env" ]; then
    echo -e "${YELLOW}⚠  未找到 .env，从 .env.example 复制${NC}"
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    echo -e "${YELLOW}⚠  请编辑 backend/.env 填入你的 LLM_API_KEY${NC}"
  fi

  # Node modules
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo -e "${YELLOW}⚠  前端依赖未安装，正在安装...${NC}"
    cd "$FRONTEND_DIR"
    npm install --silent
    echo -e "${GREEN}✅ 前端依赖安装完成${NC}"
  fi
}

prepare_competition_demo() {
  local demo_data_dir="$BACKEND_DIR/data"
  local demo_database="$demo_data_dir/competition-demo.db"
  mkdir -p "$demo_data_dir"
  export COMPETITION_DEMO_MODE=true
  export DATABASE_URL="sqlite+aiosqlite:///$demo_database"
  export LLM_API_KEY=""
  export GITHUB_RESOURCE_SEARCH_ENABLED=false
  export MEMORY_AUTO_SYNTHESIS_ENABLED=true
  PID_FILE="$DEMO_PID_FILE"
  BACKEND_LOG="/tmp/learnflow-desktop-dev-demo-backend.log"
  FRONTEND_LOG="/tmp/learnflow-desktop-dev-demo-frontend.log"
  BACKEND_PORT="$(next_available_port 8011)"
  FRONTEND_PORT="$(next_available_port 4175)"
  export LEARNFLOW_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"
  export CORS_ORIGINS="http://localhost:$FRONTEND_PORT,http://127.0.0.1:$FRONTEND_PORT"
  OPEN_URL="http://localhost:$FRONTEND_PORT/review"

  echo -e "${BLUE}━━━ 初始化离线比赛演示 ━━━${NC}"
  cd "$BACKEND_DIR"
  "$VENV_DIR/bin/python" scripts/seed_competition_demo.py --reset
  echo -e "${GREEN}✅ 演示数据已就绪（独立数据库，不影响日常数据）${NC}"
}

next_available_port() {
  local candidate="$1"
  while command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; do
    candidate=$((candidate + 1))
  done
  printf '%s' "$candidate"
}

listener_pid() {
  local port="$1"
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1
}

listener_cwd() {
  local pid="$1"
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

ensure_port_available() {
  local port="$1"
  local label="$2"
  local pid
  pid="$(listener_pid "$port" || true)"
  if [ -n "$pid" ]; then
    echo -e "${RED}❌ $label 端口 $port 已被进程 $pid 占用${NC}"
    echo -e "${YELLOW}请先运行 bash start.sh stop，或检查该端口上的其他服务。${NC}"
    exit 1
  fi
}

stop_repo_listener() {
  local port="$1"
  local expected_cwd="$2"
  local pid
  local cwd
  pid="$(listener_pid "$port" || true)"
  [ -n "$pid" ] || return 1
  cwd="$(listener_cwd "$pid" || true)"
  [ "$cwd" = "$expected_cwd" ] || return 1
  kill "$pid" 2>/dev/null || true
  return 0
}

stop_pid_file() {
  local target_pid_file="$1"
  [ -f "$target_pid_file" ] || return 1
  local pid
  while read -r pid; do
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$pid" -gt 1 ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done < "$target_pid_file"
  rm -f "$target_pid_file"
  return 0
}

stop_previous_demo() {
  if stop_pid_file "$DEMO_PID_FILE"; then
    echo -e "${GREEN}✅ 已停止上一份比赛演示实例${NC}"
  fi
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local process_pid="$3"
  local attempt
  for attempt in $(seq 1 80); do
    if ! kill -0 "$process_pid" 2>/dev/null; then
      echo -e "${RED}❌ $label 进程已退出${NC}"
      return 1
    fi
    if "$VENV_DIR/bin/python" - "$url" >/dev/null 2>&1 <<'PY'
import sys
import urllib.request

with urllib.request.urlopen(sys.argv[1], timeout=0.5) as response:
    if response.status >= 400:
        raise SystemExit(1)
PY
    then
      return 0
    fi
    sleep 0.25
  done
  echo -e "${RED}❌ $label 在 20 秒内没有就绪${NC}"
  return 1
}

show_start_failure() {
  local label="$1"
  local log_file="$2"
  echo -e "${RED}$label 启动日志：${NC}"
  tail -n 30 "$log_file" 2>/dev/null || true
  stop_pid_file "$PID_FILE" || true
  exit 1
}

start_services() {
  ensure_port_available "$BACKEND_PORT" "后端"
  ensure_port_available "$FRONTEND_PORT" "前端"
  echo -e "${BLUE}━━━ 启动后端 (端口 $BACKEND_PORT) ━━━${NC}"
  : > "$BACKEND_LOG"
  : > "$FRONTEND_LOG"
  cd "$BACKEND_DIR"
  nohup "$VENV_DIR/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" \
    > "$BACKEND_LOG" 2>&1 < /dev/null &
  BACK_PID=$!
  echo $BACK_PID > "$PID_FILE"
  wait_for_http "http://127.0.0.1:$BACKEND_PORT/health" "后端" "$BACK_PID" \
    || show_start_failure "后端" "$BACKEND_LOG"

  echo -e "${BLUE}━━━ 启动前端 (端口 $FRONTEND_PORT) ━━━${NC}"
  cd "$FRONTEND_DIR"
  nohup env LEARNFLOW_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" \
    "$FRONTEND_DIR/node_modules/.bin/vite" --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort \
    > "$FRONTEND_LOG" 2>&1 < /dev/null &
  FRONT_PID=$!
  echo $FRONT_PID >> "$PID_FILE"
  wait_for_http "http://127.0.0.1:$FRONTEND_PORT/" "前端" "$FRONT_PID" \
    || show_start_failure "前端" "$FRONTEND_LOG"

  echo ""
  echo -e "${GREEN}✅ LearnFlow 已启动！${NC}"
  echo ""
  echo -e "   ${BLUE}前端:${NC}  http://localhost:$FRONTEND_PORT"
  echo -e "   ${BLUE}后端:${NC}  http://localhost:$BACKEND_PORT"
  echo ""
  echo -e "   ${YELLOW}停止:${NC}  bash start.sh stop"
  echo ""

  if command -v open >/dev/null 2>&1; then
    (sleep 1 && open "$OPEN_URL") >/dev/null 2>&1 &
  fi
}

stop_services() {
  local found=false
  local target_pid_file
  for target_pid_file in "$REGULAR_PID_FILE" "$DEMO_PID_FILE"; do
    if [ ! -f "$target_pid_file" ]; then
      continue
    fi
    found=true
    echo -e "${YELLOW}正在停止 LearnFlow...${NC}"
    stop_pid_file "$target_pid_file"
  done
  if stop_repo_listener 8011 "$BACKEND_DIR"; then
    found=true
  fi
  if stop_repo_listener 4175 "$FRONTEND_DIR"; then
    found=true
  fi
  if [ "$found" = true ]; then
    echo -e "${GREEN}✅ 已停止${NC}"
  else
    echo "LearnFlow 当前未由 start.sh 管理运行。"
  fi
}

status_services() {
  local found=false
  local target_pid_file
  local label
  for target_pid_file in "$REGULAR_PID_FILE" "$DEMO_PID_FILE"; do
    [ "$target_pid_file" = "$DEMO_PID_FILE" ] && label="demo" || label="常规"
    [ -f "$target_pid_file" ] || continue
    found=true
    local running=0
    local total=0
    local pid
    while read -r pid; do
      case "$pid" in
        ''|*[!0-9]*) continue ;;
      esac
      total=$((total + 1))
      kill -0 "$pid" 2>/dev/null && running=$((running + 1))
    done < "$target_pid_file"
    if [ "$running" -eq 0 ]; then
      rm -f "$target_pid_file"
      echo "${label}：未运行（已清理陈旧状态 ${target_pid_file}）"
    else
      echo "${label}：$running/$total 个进程运行中（${target_pid_file}）"
    fi
  done
  if [ "$found" = false ]; then
    echo "LearnFlow 当前未由 start.sh 管理运行。"
  fi
}

case "${1:-}" in
  stop)
    stop_services
    ;;
  status)
    status_services
    ;;
  restart)
    stop_services
    sleep 1
    banner
    check_deps
    start_services
    ;;
  demo)
    banner
    stop_previous_demo
    check_deps
    prepare_competition_demo
    start_services
    ;;
  *)
    banner
    check_deps
    start_services
    ;;
esac
