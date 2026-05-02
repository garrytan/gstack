#!/bin/bash
#
# OpenClaude - Route to optimal NIM model
#
# Usage: nim-route.sh "description of task"
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Source config if exists
if [ -f "$PROJECT_ROOT/config/.env" ]; then
  set -a
  source "$PROJECT_ROOT/config/.env"
  set +a
fi

NIM_BASE_URL="${NIM_BASE_URL:-https://integrate.api.nvidia.com/v1}"
NIM_API_KEY="${NVIDIA_NIM_API_KEY:-}"

show_help() {
  cat << EOF
OpenClaude Model Router

Usage: $(basename "$0") "description of task"

Routes to optimal model based on task complexity:
- vision: Image understanding (screenshots, diagrams)
- fast: Simple tasks (< 200 chars)
- deep: Complex reasoning (> 2000 chars or debug/complex)

Models available:
- meta/llama-3.1-70b-instruct (fast)
- nvidia/vision (vision)
- deepseek-ai/deepseek-coder-v2 (deep)

EOF
}

route_model() {
  local prompt="$1"
  local len=$(echo "$prompt" | wc -c)
  
  # Vision tasks
  if echo "$prompt" | grep -qiE "image|screenshot|photo| picture|vision|diagram|chart|graph"; then
    echo "nvidia/vision"
    return
  fi
  
  # Deep reasoning
  if [ "$len" -gt 2000 ]; then
    echo "deepseek-ai/deepseek-coder-v2"
    return
  fi
  
  if echo "$prompt" | grep -qiE "debug|complex|architect|design|analyze|explain.*detailed"; then
    echo "deepseek-ai/deepseek-coder-v2"
    return
  fi
  
  # Fast/simple
  echo "meta/llama-3.1-70b-instruct"
}

# Parse arguments
case "${1:-}" in
  -h|--help|"")
    show_help
    exit 0
    ;;
  *)
    route_model "$1"
    ;;
esac