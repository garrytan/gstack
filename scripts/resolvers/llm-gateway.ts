import type { TemplateContext, ResolverFn } from './types';
import { readFileSync } from 'fs';
import { resolve } from 'path';

interface ToolMapping {
  tool: string;
  when: string;
  requires_cli?: string;
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
  integrations: Record<string, SkillIntegration>;
}

let cachedConfig: ToolsConfig | null = null;

function loadToolsConfig(): ToolsConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = resolve(import.meta.dir, '../../contrib/add-tool/llm-gateway/tools.json');
  cachedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  return cachedConfig!;
}

export const generateLlmGatewayContext: ResolverFn = (ctx: TemplateContext): string => {
  let config: ToolsConfig;
  try {
    config = loadToolsConfig();
  } catch {
    return '';
  }

  const integration = config.integrations[ctx.skillName];
  if (!integration) return '';

  const prefix = `mcp__${config.mcp_server_name}__`;

  // Filter out tools for the current host's CLI (prevent self-invocation)
  const tools = integration.tools.filter(t => {
    if (t.requires_cli && ctx.host === t.requires_cli) return false;
    return true;
  });

  if (tools.length === 0) return '';

  const toolList = tools
    .map(t => {
      const cliNote = t.requires_cli
        ? ` (requires \`LLM_GW_${t.requires_cli.toUpperCase()}: yes\`)`
        : '';
      return `- \`${prefix}${t.tool}\` — ${t.when}${cliNote}`;
    })
    .join('\n');

  return `## Multi-LLM Orchestration (llm-cli-gateway)

If preamble shows \`LLM_GATEWAY: unavailable\`: skip this section entirely.

If preamble shows \`LLM_GATEWAY: available\`:

1. **CLI availability:** Only use tools for CLIs shown as \`yes\` in the preamble.
   Skip tool recommendations for unavailable CLIs.

2. **Async for parallel work:** Use \`_async\` variants + \`llm_job_status\`/\`llm_job_result\`
   when running multiple LLM requests in parallel. Use sync variants for single sequential calls.

3. **Session continuity:** Use \`session_create\` to establish a session for multi-turn
   workflows. Pass \`sessionId\` to subsequent requests in the same skill invocation.

**During ${integration.context}**, use these gateway MCP tools:

${toolList}

Collect results from all models before synthesizing. Always show which models contributed
and flag where models agree vs. diverge.`;
};
