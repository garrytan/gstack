/**
 * Model routing resolver — returns the routed model for the current skill.
 *
 * Reads ~/.gstack/config.yaml and looks up the model_routing section
 * to determine which model should be used for the current skill.
 *
 * Format in config.yaml:
 *   model_routing:
 *     office-hours: claude-opus-4.7
 *     plan-devex-review: claude-sonnet-4.6
 *
 * If the skill is not in the routing table, returns empty string (use default).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from './types';

/**
 * Parse the model_routing section from ~/.gstack/config.yaml.
 * Returns a Record mapping skill names to model strings.
 */
function parseModelRouting(): Record<string, string> {
  const configPath = path.join(process.env.HOME || '', '.gstack', 'config.yaml');
  if (!fs.existsSync(configPath)) return {};

  const config = fs.readFileSync(configPath, 'utf-8');
  const routing: Record<string, string> = {};

  // Find the model_routing section and parse skill: model mappings
  const lines = config.split('\n');
  let inRoutingSection = false;

  for (const line of lines) {
    if (line.trim().startsWith('model_routing:')) {
      inRoutingSection = true;
      continue;
    }

    if (inRoutingSection) {
      // Exit the section when we hit another top-level key
      if (line.trim() && !line.startsWith(' ') && !line.startsWith('#')) {
        break;
      }

      // Parse "  skill-name: model" lines
      const match = line.match(/^\s+([a-z0-9-]+):\s*(.+)$/);
      if (match) {
        const skillName = match[1];
        const model = match[2].trim().split(/\s+#/)[0].trim(); // Strip inline comments
        routing[skillName] = model;
      }
    }
  }

  return routing;
}

/**
 * Generate model routing information for the current skill.
 * Returns a string explaining which model this skill should use,
 * or empty string if no routing is configured for this skill.
 */
export function generateModelRouting(ctx: TemplateContext): string {
  const routing = parseModelRouting();
  const skillModel = routing[ctx.skillName];

  if (!skillModel) {
    return '';
  }

  return `
## Model Routing

This skill is configured to use the **${skillModel}** model.

> This routing is defined in \`~/.gstack/config.yaml\` under the \`model_routing\` section. To change the model for this skill, edit the config file or run:
> \`gstack-config set model_routing "${ctx.skillName}: <model>"\`
>
> Valid model values: \`claude\`, \`claude-opus-4.7\`, \`claude-sonnet-4.6\`, \`claude-haiku\`, \`gpt\`, \`gpt-5.4\`, \`gemini\`, \`o-series\`
>
> If you invoke the Agent tool or delegate to an external AI, use the model specified above.
`;
}
