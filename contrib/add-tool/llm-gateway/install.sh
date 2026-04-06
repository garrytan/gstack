#!/usr/bin/env bash
# Install llm-cli-gateway as a gstack multi-LLM orchestration add-in.
# Idempotent — safe to run multiple times.
set -e

AGENT="${1:-claude}"
MIN_VERSION="1.1.0"

echo "=== llm-cli-gateway integration for gstack ==="
echo ""

# 1. Check for llm-cli-gateway
if ! command -v llm-cli-gateway >/dev/null 2>&1; then
  echo "llm-cli-gateway not found on PATH."
  echo ""
  echo "Install via npm:"
  echo "  npm install -g llm-cli-gateway"
  echo ""
  echo "Or clone and build:"
  echo "  git clone https://github.com/verivus-oss/llm-cli-gateway.git"
  echo "  cd llm-cli-gateway && npm install && npm run build && npm link"
  echo ""
  echo "Then re-run this script."
  exit 1
fi

# 2. Check version
GW_VERSION=$(llm-cli-gateway --version 2>/dev/null || echo "0.0.0")
echo "Found llm-cli-gateway $GW_VERSION"

version_lt() {
  # Portable semver comparison (no sort -V, works on macOS + Linux)
  local IFS=.
  local i a=($1) b=($2)
  for ((i=0; i<3; i++)); do
    local ai=${a[i]:-0} bi=${b[i]:-0}
    if [ "$ai" -lt "$bi" ] 2>/dev/null; then return 0; fi
    if [ "$ai" -gt "$bi" ] 2>/dev/null; then return 1; fi
  done
  return 1  # equal
}

if version_lt "$GW_VERSION" "$MIN_VERSION"; then
  echo "llm-cli-gateway $MIN_VERSION+ required. Please upgrade:"
  echo "  npm install -g llm-cli-gateway@latest"
  exit 1
fi

# 3. Report CLI availability
echo ""
echo "CLI availability:"
command -v claude >/dev/null 2>&1 && echo "  claude: yes" || echo "  claude: no (optional — install for Claude orchestration)"
command -v codex  >/dev/null 2>&1 && echo "  codex:  yes" || echo "  codex:  no (optional — install for Codex orchestration)"
command -v gemini >/dev/null 2>&1 && echo "  gemini: yes" || echo "  gemini: no (optional — install for Gemini orchestration)"

# 4. Configure MCP for the target agent
echo ""
echo "Configuring MCP server for $AGENT..."

configure_claude() {
  local settings="$HOME/.claude/settings.json"
  if [ ! -f "$settings" ]; then
    mkdir -p "$HOME/.claude"
    echo '{}' > "$settings"
  fi
  # Add llm-cli-gw MCP server if not present
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$settings', 'utf-8'));
    if (!s.mcpServers) s.mcpServers = {};
    if (!s.mcpServers['llm-cli-gw']) {
      s.mcpServers['llm-cli-gw'] = {
        command: 'llm-cli-gateway',
        args: [],
        env: {}
      };
      fs.writeFileSync('$settings', JSON.stringify(s, null, 2));
      console.log('Added llm-cli-gw MCP server to ' + '$settings');
    } else {
      console.log('llm-cli-gw MCP server already configured in ' + '$settings');
    }
  "
}

configure_codex() {
  local config="$HOME/.codex/config.toml"
  if [ ! -f "$config" ]; then
    mkdir -p "$HOME/.codex"
    echo "" > "$config"
  fi
  if ! grep -q 'llm-cli-gw' "$config" 2>/dev/null; then
    cat >> "$config" << 'TOML'

[[mcp_servers]]
name = "llm-cli-gw"
command = "llm-cli-gateway"
args = []
TOML
    echo "Added llm-cli-gw MCP server to $config"
  else
    echo "llm-cli-gw MCP server already configured in $config"
  fi
}

case "$AGENT" in
  claude) configure_claude ;;
  codex)  configure_codex ;;
  all)    configure_claude; configure_codex ;;
  *)      echo "Warning: Auto-configuration not supported for $AGENT. Configure MCP manually." ;;
esac

# 5. Regenerate gstack skills (picks up {{LLM_GATEWAY_CONTEXT}} resolver)
GSTACK_DIR="${GSTACK_ROOT:-$HOME/.claude/skills/gstack}"
if [ -f "$GSTACK_DIR/package.json" ]; then
  echo ""
  echo "Regenerating gstack skill docs..."
  (cd "$GSTACK_DIR" && bun run gen:skill-docs --host all 2>/dev/null) || {
    echo "Warning: Could not regenerate skill docs. Run manually:"
    echo "  cd $GSTACK_DIR && bun run gen:skill-docs --host all"
  }
fi

echo ""
echo "Done. llm-cli-gateway multi-LLM orchestration is now available in gstack skills."
