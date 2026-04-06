# sqry Add-in for gstack

**Date:** 2026-04-06
**Status:** Design approved
**Reviewers:** Gemini 3 Pro, OpenAI Codex (gpt-5.4)

## Summary

Add sqry (AST-based semantic code search) as a first-class add-in to gstack,
following the established `contrib/add-tool/` pattern. sqry is optional — gstack
works without it. When present, six skills gain structural code analysis
capabilities: `/investigate`, `/cso`, `/review`, `/retro`, `/plan-eng-review`,
and `/ship`.

## Prior Art: The Add-in Pattern

gstack has one existing add-in: llm-gateway (`contrib/add-tool/llm-gateway/`).
The pattern is:

```
contrib/add-tool/<tool-name>/
├── README.md         # What the tool does and how the integration works
├── tools.json        # Routing contract: which gstack skills use which tools
├── detection.sh      # Bash fragment inlined by preamble.ts for detection
├── install.sh        # Idempotent install script
└── uninstall.sh      # Clean removal script
```

Plus:
- A TypeScript resolver (`scripts/resolvers/<tool>.ts`) reads `tools.json` and
  generates conditional markdown blocks per skill
- Registration in `scripts/resolvers/index.ts` as `{{PLACEHOLDER}}`
- Detection bash inlined into `scripts/resolvers/preamble.ts`
- `{{PLACEHOLDER}}` placed in each skill's `.tmpl` file (after
  `{{LLM_GATEWAY_CONTEXT}}` where present; otherwise after `{{LEARNINGS_SEARCH}}`)

### Requirements from `contrib/add-tool/README.md`

- Tool MUST be optional — gstack works without it
- Detection MUST be fast (< 50ms) — it runs on every skill invocation
- Resolver output MUST be concise — avoid prompt bloat
- Install script MUST be idempotent
- Uninstall script MUST leave gstack in a clean state
- tools.json MUST include min_version for compatibility gating

## Design

### 1. detection.sh — Preamble Fragment

Uses sqry's own `index --status --json` command (discovered via Codex review:
runs in <1ms, returns structured JSON including a `stale` field computed via
sqry's internal hash-based change detection). This replaces an earlier design
that used `find -newer` which was fragile on monorepos and probed sqry internals
(`.sqry/graph/snapshot.sqry`) instead of using the supported API.

```bash
# Semantic code search (sqry)
_SQRY="unavailable"
_SQRY_INDEXED="no"
_SQRY_STALE="no"
if command -v sqry >/dev/null 2>&1; then
  _SQRY="available"
  _SQRY_VERSION=$(sqry --version 2>/dev/null | head -1 || echo "unknown")
  _SQRY_STATUS=$(sqry index --status --json . 2>/dev/null || echo '{}')
  if echo "$_SQRY_STATUS" | grep -q '"exists": true' 2>/dev/null; then
    _SQRY_INDEXED="yes"
  fi
  if echo "$_SQRY_STATUS" | grep -q '"stale": true' 2>/dev/null; then
    _SQRY_STALE="yes"
  fi
fi
echo "SQRY: $_SQRY"
[ "$_SQRY" = "available" ] && echo "SQRY_VERSION: $_SQRY_VERSION"
[ "$_SQRY" = "available" ] && echo "SQRY_INDEXED: $_SQRY_INDEXED"
[ "$_SQRY" = "available" ] && echo "SQRY_STALE: $_SQRY_STALE"
```

**Performance budget:** `sqry --version` is <1ms. `sqry index --status --json`
is <1ms (reads manifest only, no file scanning). Total: <5ms, well under 50ms.

**Preamble output variables:**

| Variable | Values | Meaning |
|----------|--------|---------|
| `SQRY` | `available` / `unavailable` | sqry binary on PATH |
| `SQRY_VERSION` | e.g. `7.1.4` | CLI version |
| `SQRY_INDEXED` | `yes` / `no` | `.sqry/` index exists for this repo |
| `SQRY_STALE` | `yes` / `no` | Index out of date (sqry's own detection) |

### 2. tools.json — Routing Contract

Defines which sqry MCP tools are recommended in which gstack skills, at which
phase, with what constraints. This extends the llm-gateway `tools.json` schema
with two additional fields: `defaults` (global output limits) and per-tool
`constraint` (tool-specific parameter guidance). These additions are covered
by `test/sqry-resolver.test.ts` which mirrors `test/llm-gateway-resolver.test.ts`.

```json
{
  "tool": "sqry",
  "homepage": "https://github.com/verivus-oss/sqry",
  "mcp_server_name": "sqry",
  "detection": {
    "binary": "sqry",
    "min_version": "7.0.0"
  },
  "defaults": {
    "max_depth": 2,
    "max_results": 50,
    "rebuild_hint": "If you made structural changes this session, call rebuild_index before your next sqry query."
  },
  "integrations": {
    "investigate": {
      "phase": "root-cause-investigation",
      "context": "structural root cause analysis",
      "tools": [
        {
          "tool": "direct_callers",
          "when": "find immediate callers of the suspect function (one-hop)",
          "constraint": "max_results: 50"
        },
        {
          "tool": "direct_callees",
          "when": "find immediate callees of the suspect function (one-hop)",
          "constraint": "max_results: 50"
        },
        {
          "tool": "call_hierarchy",
          "when": "trace multi-level caller/callee chains when one-hop is insufficient",
          "constraint": "max_depth: 2, direction: incoming or outgoing"
        },
        {
          "tool": "is_node_in_cycle",
          "when": "check if the bug site is in a circular dependency"
        },
        {
          "tool": "trace_path",
          "when": "find the call path from entry point to bug site",
          "constraint": "max_hops: 5"
        },
        {
          "tool": "dependency_impact",
          "when": "understand blast radius — what else breaks if this symbol is wrong",
          "constraint": "max_depth: 3"
        },
        {
          "tool": "get_definition",
          "when": "jump to the actual definition of a symbol referenced in stack traces"
        },
        {
          "tool": "get_references",
          "when": "find all usages of a suspect symbol across the codebase"
        }
      ]
    },
    "cso": {
      "phase": "structural-security-analysis",
      "context": "AST-powered security audit",
      "tools": [
        {
          "tool": "trace_path",
          "when": "trace structural call paths from input handlers toward dangerous sinks (exec, eval, innerHTML, raw SQL)",
          "constraint": "max_hops: 5"
        },
        {
          "tool": "call_hierarchy",
          "when": "map the full call tree from auth/authz entry points to verify coverage",
          "constraint": "max_depth: 2"
        },
        {
          "tool": "find_cycles",
          "when": "detect circular dependencies that could cause infinite loops (DoS vectors)",
          "constraint": "scope to files from Phase 1 attack surface"
        },
        {
          "tool": "find_unused",
          "when": "find dead code that may contain old vulnerabilities or stale auth checks",
          "constraint": "filter by language detected in Phase 0"
        },
        {
          "tool": "complexity_metrics",
          "when": "flag high-complexity functions (cyclomatic >15) for manual security review",
          "constraint": "scope to file_path from Phase 1"
        },
        {
          "tool": "direct_callers",
          "when": "verify that security-critical functions are only called from trusted contexts",
          "constraint": "max_results: 50"
        },
        {
          "tool": "semantic_search",
          "when": "find all functions matching security-relevant patterns (auth*, sanitize*, validate*, escape*)"
        },
        {
          "tool": "cross_language_edges",
          "when": "find FFI/HTTP boundaries where trust assumptions change"
        }
      ]
    },
    "review": {
      "phase": "structural-diff-analysis",
      "context": "structural analysis of changed code",
      "tools": [
        {
          "tool": "complexity_metrics",
          "when": "check cyclomatic complexity of changed files — flag regressions",
          "constraint": "scope to changed file paths"
        },
        {
          "tool": "find_cycles",
          "when": "check if changed symbols introduced or participate in cycles",
          "constraint": "scope to changed files"
        },
        {
          "tool": "dependency_impact",
          "when": "analyze downstream impact of changed public APIs",
          "constraint": "max_depth: 2"
        },
        {
          "tool": "find_unused",
          "when": "catch newly-dead code after refactors or API changes",
          "constraint": "scope to changed files"
        },
        {
          "tool": "semantic_diff",
          "when": "compare structural changes between the PR branch and base branch"
        },
        {
          "tool": "direct_callers",
          "when": "verify callers of changed functions still work with the new signature",
          "constraint": "max_results: 50"
        }
      ]
    },
    "retro": {
      "phase": "structural-trend-analysis",
      "context": "structural code quality analysis for retrospective",
      "tools": [
        {
          "tool": "semantic_diff",
          "when": "compare structural changes between this week's HEAD and last week's tag/commit"
        },
        {
          "tool": "complexity_metrics",
          "when": "track complexity trends — are we adding or reducing complexity?",
          "constraint": "scope to files changed this week"
        },
        {
          "tool": "find_cycles",
          "when": "check if new cycles were introduced this week"
        },
        {
          "tool": "get_insights",
          "when": "get overall codebase health metrics for the retrospective dashboard"
        }
      ]
    },
    "plan-eng-review": {
      "phase": "architecture-understanding",
      "context": "structural architecture analysis for plan review",
      "tools": [
        {
          "tool": "export_graph",
          "when": "visualize module dependencies to validate architecture boundaries",
          "constraint": "format: mermaid"
        },
        {
          "tool": "subgraph",
          "when": "extract the dependency neighborhood around components the plan modifies"
        },
        {
          "tool": "show_dependencies",
          "when": "verify dependency tree of modules the plan touches"
        },
        {
          "tool": "find_cycles",
          "when": "check for existing cycles the plan should address or avoid"
        },
        {
          "tool": "cross_language_edges",
          "when": "understand cross-language boundaries the plan must respect"
        }
      ]
    },
    "ship": {
      "phase": "pre-ship-structural-check",
      "context": "structural verification before shipping",
      "tools": [
        {
          "tool": "find_cycles",
          "when": "verify no circular dependencies in shipped code",
          "constraint": "scope to changed files"
        },
        {
          "tool": "find_unused",
          "when": "catch dead code being shipped",
          "constraint": "scope to changed files"
        },
        {
          "tool": "complexity_metrics",
          "when": "verify complexity hasn't regressed",
          "constraint": "scope to changed files"
        }
      ]
    }
  }
}
```

### 3. scripts/resolvers/sqry.ts — Resolver

Reads `tools.json` and generates conditional markdown per skill. Follows the
same structure as `llm-gateway.ts` with three additions addressing review
feedback:

- **Rebuild hint** when index is stale or missing
- **Constraint annotations** per tool (max_depth, max_results, max_hops)
- **Runtime MCP gate** — tells the agent to check for actual `mcp__sqry__*`
  tools at runtime, not just the preamble binary detection (Gemini point #3:
  PATH check != MCP configured)

```typescript
import type { TemplateContext, ResolverFn } from './types';
import { readFileSync } from 'fs';
import { resolve } from 'path';

interface ToolMapping {
  tool: string;
  when: string;
  constraint?: string;
}

interface SkillIntegration {
  phase: string;
  context: string;
  tools: ToolMapping[];
}

interface ToolsConfig {
  tool: string;
  mcp_server_name: string;
  detection: { binary: string; min_version: string };
  defaults: { max_depth: number; max_results: number; rebuild_hint: string };
  integrations: Record<string, SkillIntegration>;
}

let cachedConfig: ToolsConfig | null = null;

function loadToolsConfig(): ToolsConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = resolve(
    import.meta.dir,
    '../../contrib/add-tool/sqry/tools.json',
  );
  cachedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  return cachedConfig!;
}

export const generateSqryContext: ResolverFn = (
  ctx: TemplateContext,
): string => {
  let config: ToolsConfig;
  try {
    config = loadToolsConfig();
  } catch {
    return '';
  }

  const integration = config.integrations[ctx.skillName];
  if (!integration) return '';

  const prefix = `mcp__${config.mcp_server_name}__`;

  const toolList = integration.tools
    .map((t) => {
      const note = t.constraint ? ` (**${t.constraint}**)` : '';
      return `- \`${prefix}${t.tool}\` — ${t.when}${note}`;
    })
    .join('\n');

  return `## Structural Code Analysis (sqry)

If preamble shows \`SQRY: unavailable\`: skip this section entirely.

If preamble shows \`SQRY: available\`: check your available tools for the \`${prefix}\` prefix.
- If you see \`${prefix}\` tools: use them as described below.
- If you do NOT see \`${prefix}\` tools despite \`SQRY: available\`: tell the user
  "sqry is installed but not configured as an MCP server. Run \`sqry mcp setup\`
  to enable structural code analysis, then restart this session."

**Index freshness:**
- If \`SQRY_INDEXED: no\`: run \`${prefix}rebuild_index\` before any queries.
- If \`SQRY_STALE: yes\`: run \`${prefix}rebuild_index\` before any queries.
- ${config.defaults.rebuild_hint}

**During ${integration.context}**, use these sqry MCP tools:

${toolList}

**Output limits:** Default to max_depth ${config.defaults.max_depth}, max_results ${config.defaults.max_results}.
Only increase when the narrower result is insufficient — large results exhaust context.`;
};
```

### 4. scripts/resolvers/index.ts — Registration

Add import and entry:

```typescript
import { generateSqryContext } from './sqry';

// In RESOLVERS record:
SQRY_CONTEXT: generateSqryContext,
```

### 5. scripts/resolvers/preamble.ts — Detection Inline

Add the detection.sh bash fragment after the existing llm-gateway detection
block (around line 106), following the same inline pattern:

```typescript
// After the LLM_GATEWAY echo lines:
// Semantic code search (sqry)
_SQRY="unavailable"
_SQRY_INDEXED="no"
_SQRY_STALE="no"
if command -v sqry >/dev/null 2>&1; then
  _SQRY="available"
  _SQRY_VERSION=$(sqry --version 2>/dev/null | head -1 || echo "unknown")
  _SQRY_STATUS=$(sqry index --status --json . 2>/dev/null || echo '{}')
  if echo "$_SQRY_STATUS" | grep -q '"exists": true' 2>/dev/null; then
    _SQRY_INDEXED="yes"
  fi
  if echo "$_SQRY_STATUS" | grep -q '"stale": true' 2>/dev/null; then
    _SQRY_STALE="yes"
  fi
fi
echo "SQRY: $_SQRY"
[ "$_SQRY" = "available" ] && echo "SQRY_VERSION: $_SQRY_VERSION"
[ "$_SQRY" = "available" ] && echo "SQRY_INDEXED: $_SQRY_INDEXED"
[ "$_SQRY" = "available" ] && echo "SQRY_STALE: $_SQRY_STALE"
```

### 6. Template Placement — `{{SQRY_CONTEXT}}`

Insert `{{SQRY_CONTEXT}}` immediately after `{{LLM_GATEWAY_CONTEXT}}` where
present; otherwise place it after `{{LEARNINGS_SEARCH}}`.

| Template | After |
|----------|-------|
| `investigate/SKILL.md.tmpl` | `{{LLM_GATEWAY_CONTEXT}}` |
| `cso/SKILL.md.tmpl` | `{{LEARNINGS_SEARCH}}` (before Phase 1) |
| `review/SKILL.md.tmpl` | `{{LLM_GATEWAY_CONTEXT}}` |
| `retro/SKILL.md.tmpl` | `{{LLM_GATEWAY_CONTEXT}}` |
| `plan-eng-review/SKILL.md.tmpl` | `{{LLM_GATEWAY_CONTEXT}}` |
| `ship/SKILL.md.tmpl` | `{{LLM_GATEWAY_CONTEXT}}` |

### 7. install.sh

```bash
#!/usr/bin/env bash
# Install sqry as a gstack structural code analysis add-in.
# Idempotent — safe to run multiple times.
set -e

AGENT="${1:-claude}"
MIN_VERSION="7.0.0"

echo "=== sqry integration for gstack ==="
echo ""

# 1. Check for sqry CLI
if ! command -v sqry >/dev/null 2>&1; then
  echo "sqry not found on PATH."
  echo ""
  echo "Install via the signed installer:"
  echo "  curl -fsSL https://raw.githubusercontent.com/verivus-oss/sqry/main/scripts/install.sh | bash -s -- --component all"
  echo ""
  echo "Or via cargo:"
  echo "  cargo install sqry-cli sqry-mcp"
  echo ""
  echo "Then re-run this script."
  exit 1
fi

# 2. Check version (normalize: "sqry 7.1.4" -> "7.1.4")
SQRY_VERSION=$(sqry --version 2>/dev/null | awk '{print $2}' || echo "0.0.0")
echo "Found sqry $SQRY_VERSION"

# Portable semver comparator (no sort -V, works on macOS)
version_lt() {
  local IFS=.
  local i a=($1) b=($2)
  for ((i=0; i<${#b[@]}; i++)); do
    [ -z "${a[i]}" ] && a[i]=0
    if ((10#${a[i]} < 10#${b[i]})); then return 0; fi
    if ((10#${a[i]} > 10#${b[i]})); then return 1; fi
  done
  return 1
}

if version_lt "$SQRY_VERSION" "$MIN_VERSION"; then
  echo "sqry $MIN_VERSION+ required. Please upgrade:"
  echo "  curl -fsSL https://raw.githubusercontent.com/verivus-oss/sqry/main/scripts/install.sh | bash -s -- --component all"
  exit 1
fi

# 3. Check for sqry-mcp
if ! command -v sqry-mcp >/dev/null 2>&1; then
  echo "sqry-mcp not found on PATH."
  echo ""
  echo "Install the MCP server:"
  echo "  curl -fsSL https://raw.githubusercontent.com/verivus-oss/sqry/main/scripts/install.sh | bash -s -- --component mcp"
  echo ""
  echo "Or via cargo:"
  echo "  cargo install sqry-mcp"
  echo ""
  echo "Then re-run this script."
  exit 1
fi

echo "Found sqry-mcp at $(command -v sqry-mcp)"

# 4. Configure MCP for the target agent
# Delegate to sqry's own setup command — it knows each host's config format.
echo ""
echo "Configuring MCP server for $AGENT..."

case "$AGENT" in
  claude) sqry mcp setup --tool claude ;;
  codex)  sqry mcp setup --tool codex ;;
  gemini) sqry mcp setup --tool gemini ;;
  all)    sqry mcp setup ;;
  *)      echo "Warning: Auto-configuration not supported for $AGENT. Run 'sqry mcp setup' manually." ;;
esac

# 5. Verify MCP configuration
echo ""
echo "MCP status:"
sqry mcp status 2>/dev/null || echo "  (could not verify — run 'sqry mcp status' manually)"

# 6. Build initial index if not present
if ! sqry index --status --json . 2>/dev/null | grep -q '"exists": true'; then
  echo ""
  echo "Building initial sqry index..."
  sqry index .
  echo "Index built."
else
  echo ""
  echo "sqry index already exists."
  if sqry index --status --json . 2>/dev/null | grep -q '"stale": true'; then
    echo "Index is stale — rebuilding..."
    sqry index .
    echo "Index rebuilt."
  fi
fi

# 7. Regenerate gstack skills (picks up {{SQRY_CONTEXT}} resolver)
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
echo "Done. sqry structural code analysis is now available in gstack skills."
echo ""
echo "IMPORTANT: Restart your AI agent session for the MCP tools to appear."
```

### 8. uninstall.sh

```bash
#!/usr/bin/env bash
# Remove sqry integration from gstack.
# Does NOT uninstall sqry itself — only removes the gstack integration.
set -e

echo "=== Removing sqry integration from gstack ==="

# Helper: remove a key from a JSON file using node (portable)
remove_json_key() {
  local file="$1" key_path="$2"
  [ -f "$file" ] && command -v node >/dev/null 2>&1 || return 0
  node -e "
    const fs = require('fs');
    try {
      const s = JSON.parse(fs.readFileSync('$file', 'utf-8'));
      const parts = '$key_path'.split('.');
      let obj = s;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) return;
        obj = obj[parts[i]];
      }
      const last = parts[parts.length - 1];
      if (obj[last] !== undefined) {
        delete obj[last];
        fs.writeFileSync('$file', JSON.stringify(s, null, 2));
        console.log('Removed ' + '$key_path' + ' from $file');
      }
    } catch(e) {}
  " 2>/dev/null || true
}

# 1. Claude: global mcpServers.sqry + per-project mcpServers.sqry
for settings in "$HOME/.claude.json" "$HOME/.claude/settings.json"; do
  remove_json_key "$settings" "mcpServers.sqry"
  # Also clean per-project entries
  if [ -f "$settings" ] && command -v node >/dev/null 2>&1; then
    node -e "
      const fs = require('fs');
      try {
        const s = JSON.parse(fs.readFileSync('$settings', 'utf-8'));
        if (s.projects) {
          let changed = false;
          for (const [k, v] of Object.entries(s.projects)) {
            if (v && v.mcpServers && v.mcpServers.sqry) {
              delete v.mcpServers.sqry;
              changed = true;
            }
          }
          if (changed) {
            fs.writeFileSync('$settings', JSON.stringify(s, null, 2));
            console.log('Removed per-project sqry MCP entries from $settings');
          }
        }
      } catch(e) {}
    " 2>/dev/null || true
  fi
done

# 2. Codex: [mcp_servers.sqry] section in TOML (portable, no sed -i)
CODEX_CONFIG="$HOME/.codex/config.toml"
if [ -f "$CODEX_CONFIG" ] && grep -q '\[mcp_servers\.sqry\]' "$CODEX_CONFIG" 2>/dev/null; then
  node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('$CODEX_CONFIG', 'utf-8').split('\n');
    const out = [];
    let skip = false;
    for (const line of lines) {
      if (/^\[mcp_servers\.sqry[\].]/.test(line.trim())) { skip = true; continue; }
      if (skip && line.startsWith('[') && !/^\[mcp_servers\.sqry[\].]/.test(line.trim())) { skip = false; }
      if (!skip) out.push(line);
    }
    fs.writeFileSync('$CODEX_CONFIG', out.join('\n'));
    console.log('Removed [mcp_servers.sqry] from Codex config');
  " 2>/dev/null || true
fi

# 3. Gemini: mcpServers.sqry in JSON
GEMINI_CONFIG="$HOME/.gemini/settings.json"
remove_json_key "$GEMINI_CONFIG" "mcpServers.sqry"

# 4. Regenerate gstack skills ({{SQRY_CONTEXT}} emits nothing without sqry)
GSTACK_DIR="${GSTACK_ROOT:-$HOME/.claude/skills/gstack}"
if [ -f "$GSTACK_DIR/package.json" ]; then
  echo "Regenerating gstack skill docs..."
  (cd "$GSTACK_DIR" && bun run gen:skill-docs --host all 2>/dev/null) || true
fi

echo "Done. sqry integration removed. sqry itself is still installed."
echo "To fully uninstall sqry: see https://github.com/verivus-oss/sqry#uninstall"
```

### 9. README.md

```markdown
# sqry Integration for gstack

[sqry](https://github.com/verivus-oss/sqry) provides AST-based semantic code
search via 34 MCP tools. This integration adds structural code analysis to
gstack skills — callers/callees tracing, cycle detection, complexity metrics,
structural call-path tracing, and more.

## Install

    bash contrib/add-tool/sqry/install.sh [claude|codex|gemini|all]

## What it does

When sqry is installed and configured as an MCP server, gstack skills gain a
"Structural Code Analysis" section with contextual tool recommendations:

- `/investigate` gets caller/callee tracing, cycle detection, blast radius analysis
- `/cso` gets structural call-path tracing from input handlers to sinks, dead code detection
- `/review` gets complexity regression checks, cycle detection, semantic diff
- `/retro` gets structural trend analysis and codebase health metrics
- `/plan-eng-review` gets dependency visualization and architecture boundary validation
- `/ship` gets pre-ship structural verification (cycles, dead code, complexity)

See `tools.json` for the complete routing table.

## Relationship to existing sqry skills

The `sqry-claude`, `sqry-codex`, and `sqry-gemini` skills (shipped with sqry)
teach agents how to *set up and use* sqry. This gstack integration is different —
it wires sqry tools into gstack's *existing workflow skills* so they're used
automatically at the right moment during debugging, review, security audits, etc.

| sqry skills (setup) | gstack add-in (workflow) |
|---------------------|------------------------|
| Teach tool usage | Wire tools into skill phases |
| Manual invocation | Automatic contextual use |
| Generic patterns | Skill-specific constraints |
| No index management | Auto-rebuild when stale |

## Uninstall

    bash contrib/add-tool/sqry/uninstall.sh

This removes the gstack integration. sqry itself remains installed.
```

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Context blowout from large sqry results | `defaults.max_depth: 2, max_results: 50` in tools.json; per-tool constraints |
| Stale index causing hallucinated results | `sqry index --status --json` returns `stale` field; resolver tells agent to rebuild |
| sqry binary on PATH but MCP not configured | Dual gate in resolver: preamble check + runtime tool prefix check; helpful error message |
| `.gstack-worktrees/` polluting the index | sqry respects `.gitignore`; worktrees are gitignored |
| Agent session requires restart after install | install.sh ends with hard-stop message |
| Agent over-calls sqry for simple string searches | Each tool has a prescriptive `when` clause — not "use whenever" |
| Concurrency: file edits during sqry parse | sqry uses snapshot-based reads from its index, not live file handles |
| `sqry index --status` not available in older sqry | min_version 7.0.0 in tools.json; install.sh enforces version check |

## Review Feedback Incorporated

### From Gemini 3 Pro

1. **Detection flawed for multi-host MCP** — Fixed: dual gate (preamble binary
   check + runtime `mcp__sqry__*` tool presence check) with helpful setup message.
2. **24h staleness dangerous** — Fixed: using sqry's own `stale` field from
   `index --status --json` (hash-based change detection, not time-based).
3. **Context blowout risk** — Fixed: enforced `max_depth`/`max_results` defaults
   and per-tool constraint annotations.
4. **Missing `/plan-eng-review`** — Added: `export_graph`, `subgraph`,
   `show_dependencies`, `find_cycles`, `cross_language_edges`.
5. **Session restart required** — Fixed: install.sh hard-stops with restart message.
6. **Tool calling aggressiveness** — Fixed: prescriptive `when` clauses per tool.

### From OpenAI Codex (o3)

1. **Hand-rolled filesystem probing** — Fixed: replaced `find -newer` with
   `sqry index --status --json` which runs in <1ms and returns structured data
   including `stale`, `exists`, `symbol_count`, `file_count`.
2. **Hand-rolled MCP config edits** — Fixed: install.sh delegates to
   `sqry mcp setup --tool <agent>` instead of writing JSON/TOML manually.
3. **Design thicker than llm-gateway** — Fixed: detection now uses sqry's own
   API (3 lines of grep on JSON) instead of filesystem probing. install.sh
   delegates MCP setup. Thinner and more aligned with the pattern.
4. **`sqry mcp status --json`** — Codex discovered this returns full MCP config
   state for all hosts in <1ms. Used in install.sh to verify after setup.

### From OpenAI Codex — Round 2 (gpt-5.4)

1. **BLOCK: Version gate broken** — `sqry --version` returns `sqry 7.1.4` not
   `7.1.4`. Fixed: parse with `awk '{print $2}'`. Also replaced non-portable
   `sort -V` with arithmetic semver comparator.
2. **BLOCK: uninstall.sh wrong Codex TOML format** — sqry writes
   `[mcp_servers.sqry]` not `[[mcp_servers]] name = "sqry"`. Also missing
   per-project Claude cleanup and using non-portable `sed -i`. Fixed: rewrote
   with `node` for all formats, added per-project cleanup.
3. **BLOCK: Invalid tool constraints** — `direct_callers`/`direct_callees` don't
   accept `max_depth` (they're always depth=1). Fixed: changed constraints to
   `max_results: 50`, added `call_hierarchy` for multi-level tracing.
4. **WARN: Overclaimed "taint path analysis"** — Fixed: downgraded to
   "structural call-path tracing" throughout.
5. **WARN: Placement prose inaccurate** — Fixed: changed to "after
   `{{LLM_GATEWAY_CONTEXT}}` where present; otherwise after `{{LEARNINGS_SEARCH}}`."
6. **WARN: Wrong MCP prefix in prose** — Fixed: `mcp_sqry_*` → `mcp__sqry__*`.
7. **WARN: Missing test file** — Fixed: added `test/sqry-resolver.test.ts` to
   files list, called out extended schema explicitly.

### From OpenAI Codex — Round 3 (gpt-5.4)

1. **BLOCK: TOML subtable orphaning** — uninstall node script only matched
   exact `[mcp_servers.sqry]` header, missing nested subtables like
   `[mcp_servers.sqry.env]`. Fixed: regex now matches `[mcp_servers.sqry]`
   AND `[mcp_servers.sqry.*]` patterns, skipping the entire block.
2. **WARN: Prior art prose inconsistency** — line 34 still said "after
   `{{LEARNINGS_SEARCH}}`" while the placement section said the correct rule.
   Fixed: made consistent throughout.

### From OpenAI Codex — Round 4 (gpt-5.4)

1. **WARN: Stale placement rule in shared README** — `contrib/add-tool/README.md`
   line 27 still says "placed after `{{LEARNINGS_SEARCH}}`" but the correct rule
   is "after `{{LLM_GATEWAY_CONTEXT}}` where present; otherwise after
   `{{LEARNINGS_SEARCH}}`." Fixed: added explicit README update to the modify
   table in "Files to Create/Modify".

## Files to Create/Modify

### Create

| File | Purpose |
|------|---------|
| `contrib/add-tool/sqry/README.md` | Integration documentation |
| `contrib/add-tool/sqry/tools.json` | Routing contract |
| `contrib/add-tool/sqry/detection.sh` | Preamble bash fragment |
| `contrib/add-tool/sqry/install.sh` | Idempotent installer |
| `contrib/add-tool/sqry/uninstall.sh` | Clean removal |
| `scripts/resolvers/sqry.ts` | TypeScript resolver |
| `test/sqry-resolver.test.ts` | Resolver + tools.json validation (mirrors llm-gateway test) |

### Modify

| File | Change |
|------|--------|
| `scripts/resolvers/index.ts` | Import `generateSqryContext`, add `SQRY_CONTEXT` to RESOLVERS |
| `scripts/resolvers/preamble.ts` | Inline detection.sh bash after llm-gateway block |
| `investigate/SKILL.md.tmpl` | Add `{{SQRY_CONTEXT}}` after `{{LLM_GATEWAY_CONTEXT}}` |
| `cso/SKILL.md.tmpl` | Add `{{SQRY_CONTEXT}}` after `{{LEARNINGS_SEARCH}}` |
| `review/SKILL.md.tmpl` | Add `{{SQRY_CONTEXT}}` after `{{LLM_GATEWAY_CONTEXT}}` |
| `retro/SKILL.md.tmpl` | Add `{{SQRY_CONTEXT}}` after `{{LLM_GATEWAY_CONTEXT}}` |
| `plan-eng-review/SKILL.md.tmpl` | Add `{{SQRY_CONTEXT}}` after `{{LLM_GATEWAY_CONTEXT}}` |
| `ship/SKILL.md.tmpl` | Add `{{SQRY_CONTEXT}}` after `{{LLM_GATEWAY_CONTEXT}}` |
| `contrib/add-tool/README.md` | Add sqry to "Existing integrations" list; update placement rule on line 27 to: "after `{{LLM_GATEWAY_CONTEXT}}` where present; otherwise after `{{LEARNINGS_SEARCH}}`" |
