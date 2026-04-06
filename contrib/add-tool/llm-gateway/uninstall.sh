#!/usr/bin/env bash
# Remove llm-cli-gateway integration from gstack.
# Does NOT uninstall llm-cli-gateway itself — only removes the gstack integration.
set -e

echo "=== Removing llm-cli-gateway integration from gstack ==="

# 1. Remove MCP config entries (best-effort)
if command -v node >/dev/null 2>&1; then
  node -e "
    const fs = require('fs');
    const settings = process.env.HOME + '/.claude/settings.json';
    try {
      const s = JSON.parse(fs.readFileSync(settings, 'utf-8'));
      if (s.mcpServers && s.mcpServers['llm-cli-gw']) {
        delete s.mcpServers['llm-cli-gw'];
        fs.writeFileSync(settings, JSON.stringify(s, null, 2));
        console.log('Removed llm-cli-gw MCP server from Claude settings');
      }
    } catch(e) {}
  " 2>/dev/null || true
fi

# 2. Remove from Codex config (best-effort, uses node for portability — no sed -i)
CODEX_CONFIG="$HOME/.codex/config.toml"
if [ -f "$CODEX_CONFIG" ] && grep -q 'llm-cli-gw' "$CODEX_CONFIG" 2>/dev/null; then
  if command -v node >/dev/null 2>&1; then
    node -e "
      const fs = require('fs');
      const config = '$CODEX_CONFIG';
      try {
        const lines = fs.readFileSync(config, 'utf-8').split('\n');
        const out = [];
        let skip = false;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === '[[mcp_servers]]') {
            // Look ahead: is this the llm-cli-gw block?
            const block = lines.slice(i, i + 5).join('\n');
            if (block.includes('llm-cli-gw')) { skip = true; continue; }
          }
          if (skip) {
            if (lines[i].trim() === '' || lines[i].startsWith('[[')) { skip = false; }
            else { continue; }
          }
          if (!skip) out.push(lines[i]);
        }
        fs.writeFileSync(config, out.join('\n'));
        console.log('Removed llm-cli-gw MCP server from Codex config');
      } catch(e) {}
    " 2>/dev/null || true
  else
    echo "Warning: node not available. Manually remove llm-cli-gw from $CODEX_CONFIG"
  fi
fi

# 3. Regenerate gstack skills ({{LLM_GATEWAY_CONTEXT}} emits nothing without gateway)
GSTACK_DIR="${GSTACK_ROOT:-$HOME/.claude/skills/gstack}"
if [ -f "$GSTACK_DIR/package.json" ]; then
  echo "Regenerating gstack skill docs..."
  (cd "$GSTACK_DIR" && bun run gen:skill-docs --host all 2>/dev/null) || true
fi

echo "Done. llm-cli-gateway integration removed. The gateway itself is still installed."
echo "To fully uninstall: npm uninstall -g llm-cli-gateway"
