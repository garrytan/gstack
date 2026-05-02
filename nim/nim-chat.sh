#!/bin/bash
#
# OpenClaude CLI - Chat with NIM models
#
# Usage: nim-chat.sh "Your prompt here"
#

set -euo pipefail

# Load config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Source config if exists
if [ -f "$PROJECT_ROOT/config/.env" ]; then
  set -a
  source "$PROJECT_ROOT/config/.env"
  set +a
fi

# Defaults
FCC_URL="${FCC_URL:-http://127.0.0.1:8082}"
FCC_PORT="${FCC_PORT:-8082}"
NIM_API_KEY="${NVIDIA_NIM_API_KEY:-}"
NIM_BASE_URL="${NIM_BASE_URL:-https://integrate.api.nvidia.com/v1}"
MODEL="${NIM_MODEL:-claude-sonnet-4-20250514}"
MAX_TOKENS="${MAX_TOKENS:-4096}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $*"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $*"
}

check_dependencies() {
  local missing=()
  
  for cmd in curl jq; do
    if ! command -v "$cmd" &> /dev/null; then
      missing+=("$cmd")
    fi
  done
  
  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing dependencies: ${missing[*]}"
    log_error "Install with: apt install curl jq"
    exit 1
  fi
}

check_fcc_running() {
  if ! curl -s --max-time 2 "$FCC_URL/health" &> /dev/null; then
    log_error "OpenClaude proxy not running at $FCC_URL"
    log_error "Start with: ./scripts/start.sh"
    exit 1
  fi
}

check_config() {
  if [ -z "$NIM_API_KEY" ]; then
    log_error "NVIDIA_NIM_API_KEY not set"
    log_error "Copy config/env.example to config/.env and add your API key"
    exit 1
  fi
}

start_fcc() {
  if curl -s --max-time 2 "$FCC_URL/health" &> /dev/null; then
    log_info "OpenClaude proxy already running"
    return 0
  fi
  
  log_info "Starting OpenClaude proxy..."
  cd "$PROJECT_ROOT"
  
  # Check for virtual environment
  if [ -d ".venv" ]; then
    source .venv/bin/activate
  fi
  
  # Start in background
  nohup uvicorn server:app --host 127.0.0.1 --port "$FCC_PORT" &> /tmp/fcc.log 2>&1 &
  local fcc_pid=$!
  
  # Wait for startup
  local retries=10
  while [ $retries -gt 0 ]; do
    if curl -s --max-time 2 "$FCC_URL/health" &> /dev/null; then
      log_info "OpenClaude proxy started (PID: $fcc_pid)"
      return 0
    fi
    sleep 1
    ((retries--))
  done
  
  log_error "Failed to start OpenClaude proxy"
  log_error "Check /tmp/fcc.log for details"
  exit 1
}

send_message() {
  local prompt="$1"
  
  curl -s -N -X POST "$FCC_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "x-provider: nvidia_nim" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"$prompt\"}],
      \"max_tokens\": $MAX_TOKENS,
      \"stream\": true
    }" 2>&1 | while IFS= read -r line; do
      # Parse SSE events
      if echo "$line" | grep -q '^data:'; then
        local data
        data=$(echo "$line" | sed 's/^data: //')
        local type
        type=$(echo "$data" | jq -r '.type' 2>/dev/null)
        
        case "$type" in
          "text_delta")
            echo "$data" | jq -r '.delta.text // empty' 2>/dev/null
            ;;
          "content_block_delta")
            local content_type
            content_type=$(echo "$data" | jq -r '.delta.type' 2>/dev/null)
            if [ "$content_type" = "thinking_delta" ]; then
              # Skip thinking for cleaner output
              :
            else
              echo "$data" | jq -r '.delta.text // empty' 2>/dev/null
            fi
            ;;
          "message_start"|"content_block_start"|"content_block_stop"|"message_delta"|"message_stop")
            # Skip metadata
            ;;
        esac
      fi
    done
}

show_help() {
  cat << EOF
OpenClaude - Chat with NIM models via Claude Code proxy

Usage: $(basename "$0") [OPTIONS] "Your prompt"

Options:
  -m, --model MODEL    Model to use (default: $MODEL)
  -t, --tokens N       Max tokens (default: $MAX_TOKENS)
  -s, --stream         Enable streaming output
  -h, --help          Show this help
  -s, --start         Start the proxy first

Examples:
  $(basename "$0") "Say hello"
  $(basename "$0") -m z-ai/glm-4.7 "Explain quantum computing"
  $(basename "$0") --start "What is the weather?"

EOF
}

main() {
  local start_first=false
  local custom_model=""
  local custom_tokens=""
  
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        show_help
        exit 0
        ;;
      -s|--start)
        start_first=true
        shift
        ;;
      -m|--model)
        custom_model="$2"
        shift 2
        ;;
      -t|--tokens)
        custom_tokens="$2"
        shift 2
        ;;
      -*)
        log_error "Unknown option: $1"
        show_help
        exit 1
        ;;
      *)
        break
        ;;
    esac
  done
  
  local prompt="${1:-}"
  
  if [ -z "$prompt" ]; then
    log_error "Please provide a prompt"
    show_help
    exit 1
  fi
  
  # Apply overrides
  [ -n "$custom_model" ] && MODEL="$custom_model"
  [ -n "$custom_tokens" ] && MAX_TOKENS="$custom_tokens"
  
  # Setup
  check_dependencies
  check_config
  
  if [ "$start_first" = true ]; then
    start_fcc
  else
    check_fcc_running
  fi
  
  # Send message
  send_message "$prompt"
}

main "$@"