#!/bin/bash
#
# OpenClaude - Start the proxy
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_FILE="/tmp/openclaude.log"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[OpenClaude]${NC} $*"; }
warn() { echo -e "${YELLOW}[OpenClaude]${NC} $*"; }
error() { echo -e "${RED}[OpenClaude]${NC} $*" >&2; }

setup() {
  cd "$PROJECT_ROOT"
  
  # Check Python
  if ! command -v python3 &> /dev/null; then
    error "Python 3 not found"
    exit 1
  fi
  
  # Check for uv
  if command -v uv &> /dev/null; then
    if [ ! -d ".venv" ]; then
      log "Creating virtual environment..."
      uv venv
    fi
  else
    warn "uv not found, using system Python"
  fi
  
  # Install dependencies
  if [ -d ".venv" ]; then
    log "Installing dependencies..."
    source .venv/bin/activate
    uv pip install -e . 2>/dev/null || pip install -e . 2>/dev/null || true
  fi
}

start() {
  cd "$PROJECT_ROOT"
  
  # Check if already running
  if curl -s --max-time 2 http://127.0.0.1:8082/health &> /dev/null; then
    log "Proxy already running on http://127.0.0.1:8082"
    return 0
  fi
  
  # Load env
  if [ -f ".env" ]; then
    set -a
    source .env
    set +a
  fi
  
  # Start proxy
  log "Starting OpenClaude proxy..."
  
  if [ -d ".venv" ]; then
    source .venv/bin/activate
  fi
  
  nohup uvicorn server:app --host 127.0.0.1 --port 8082 &>> "$LOG_FILE" 2>&1 &
  local pid=$!
  
  # Wait for startup
  local retries=15
  while [ $retries -gt 0 ]; do
    if curl -s --max-time 2 http://127.0.0.1:8082/health &> /dev/null; then
      log "Proxy started (PID: $pid)"
      log "Health: http://127.0.0.1:8082/health"
      log "API: http://127.0.0.1:8082/v1/messages"
      return 0
    fi
    sleep 1
    ((retries--))
  done
  
  error "Failed to start proxy"
  error "Check $LOG_FILE for details"
  tail -20 "$LOG_FILE"
  exit 1
}

stop() {
  local pid
  pid=$(pgrep -f "uvicorn server:app" | head -1)
  
  if [ -n "$pid" ]; then
    log "Stopping proxy (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
    log "Proxy stopped"
  else
    warn "Proxy not running"
  fi
}

status() {
  if curl -s --max-time 2 http://127.0.0.1:8082/health &> /dev/null; then
    log "Proxy running on http://127.0.0.1:8082"
    curl -s http://127.0.0.1:8082/health | jq -r '.status, .version' 2>/dev/null || echo "Status: healthy"
    return 0
  else
    error "Proxy not running"
    return 1
  fi
}

restart() {
  stop
  sleep 1
  start
}

case "${1:-start}" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  status)
    status
    ;;
  setup)
    setup
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|setup}"
    exit 1
    ;;
esac