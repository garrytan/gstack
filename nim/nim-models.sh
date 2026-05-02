#!/bin/bash
#
# OpenClaude - List available NIM models
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Source config
if [ -f "$PROJECT_ROOT/config/.env" ]; then
  set -a
  source "$PROJECT_ROOT/config/.env"
  set +a
fi

NIM_BASE_URL="${NIM_BASE_URL:-https://integrate.api.nvidia.com/v1}"
NIM_API_KEY="${NVIDIA_NIM_API_KEY:-}"

if [ -z "$NIM_API_KEY" ]; then
  echo "Error: NVIDIA_NIM_API_KEY not set"
  echo "Copy config/env.example to config/.env and add your API key"
  exit 1
fi

echo "Fetching available models..."
echo ""

curl -s "$NIM_BASE_URL/models" \
  -H "Authorization: Bearer $NIM_API_KEY" \
  -H "Content-Type: application/json" 2>/dev/null | jq -r '.data[]?.id // .models[]?.id' 2>/dev/null | grep -v "^$" | head -20 || echo "Error fetching models. Check your API key."