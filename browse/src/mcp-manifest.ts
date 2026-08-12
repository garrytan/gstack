/**
 * MCP tool manifest generator for gstack browse commands.
 *
 * Generates a Model Context Protocol-compatible tool manifest from
 * COMMAND_DESCRIPTIONS — the single source of truth for all browse commands.
 *
 * Usage:
 *   bun run browse/src/mcp-manifest.ts              → print JSON manifest
 *   bun run browse/src/mcp-manifest.ts --write       → write to browse/mcp-tools.json
 *
 * The manifest enables any MCP-compatible agent (Claude Code, Codex, Gemini,
 * Cursor) to discover and call gstack browse commands as tools.
 */

import { COMMAND_DESCRIPTIONS, READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from './commands';
import * as fs from 'fs';
import * as path from 'path';

interface MCPToolParameter {
  type: string;
  description: string;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, MCPToolParameter>;
    required: string[];
  };
  annotations?: {
    category: string;
    readOnly: boolean;
  };
}

/**
 * Parse a usage string like "goto <url>" into parameter definitions.
 * Handles: <required>, [optional], flags like --errors.
 */
function parseUsageParams(usage: string | undefined, command: string): {
  properties: Record<string, MCPToolParameter>;
  required: string[];
} {
  const properties: Record<string, MCPToolParameter> = {};
  const required: string[] = [];

  if (!usage) {
    // No usage string — command takes no arguments
    return { properties, required };
  }

  // Remove the command name prefix
  const argsPart = usage.replace(new RegExp(`^${command}\\s*`), '').trim();
  if (!argsPart) return { properties, required };

  // Extract <required> params
  const requiredMatches = argsPart.matchAll(/<([^>]+)>/g);
  for (const match of requiredMatches) {
    const name = match[1].replace(/[^a-zA-Z0-9_]/g, '_');
    properties[name] = { type: 'string', description: `Required: ${match[1]}` };
    required.push(name);
  }

  // Extract [optional] params
  const optionalMatches = argsPart.matchAll(/\[([^\]]+)\]/g);
  for (const match of optionalMatches) {
    const name = match[1].replace(/[^a-zA-Z0-9_]/g, '_').replace(/^-+/, '');
    properties[name] = { type: 'string', description: `Optional: ${match[1]}` };
  }

  // If no params extracted but there's content, add a generic args param
  if (Object.keys(properties).length === 0 && argsPart.length > 0) {
    properties['args'] = { type: 'string', description: `Arguments: ${argsPart}` };
  }

  return { properties, required };
}

/**
 * Generate MCP tool manifest from COMMAND_DESCRIPTIONS.
 */
export function generateMCPManifest(): MCPTool[] {
  const tools: MCPTool[] = [];

  for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
    const { properties, required } = parseUsageParams(meta.usage, cmd);
    const isReadOnly = READ_COMMANDS.has(cmd);

    tools.push({
      name: `browse_${cmd}`,
      description: meta.description,
      inputSchema: {
        type: 'object',
        properties,
        required,
      },
      annotations: {
        category: meta.category,
        readOnly: isReadOnly,
      },
    });
  }

  return tools;
}

// ─── CLI ────────────────────────────────────────────────────

if (import.meta.main) {
  const manifest = {
    name: 'gstack-browse',
    version: '1.0.0',
    description: 'Headless browser automation for AI agents — navigate, interact, screenshot, inspect',
    tools: generateMCPManifest(),
  };

  if (process.argv.includes('--write')) {
    const outPath = path.join(import.meta.dir, '..', 'mcp-tools.json');
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Written: ${outPath} (${manifest.tools.length} tools)`);
  } else {
    console.log(JSON.stringify(manifest, null, 2));
  }
}
