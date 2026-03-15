/**
 * SKILL.md parser and validator.
 *
 * Extracts agent-browser commands from code blocks, validates them against
 * the command registry and snapshot flags.
 *
 * Used by:
 *   - test/skill-validation.test.ts (Tier 1 static tests)
 *   - scripts/skill-check.ts (health summary)
 *   - scripts/dev-skill.ts (watch mode)
 */

import { ALL_COMMANDS } from '../../lib/agent-browser-commands';
import { parseSnapshotArgs } from '../../lib/snapshot-flags';
import * as fs from 'fs';
import * as path from 'path';

export interface BrowseCommand {
  command: string;
  args: string[];
  line: number;
  raw: string;
}

export interface ValidationResult {
  valid: BrowseCommand[];
  invalid: BrowseCommand[];
  snapshotFlagErrors: Array<{ command: BrowseCommand; error: string }>;
  warnings: string[];
}

/**
 * Known multi-word command prefixes for agent-browser.
 * These are tested first (longest match) to avoid splitting "get text" into "get" + "text".
 */
const MULTI_WORD_PREFIXES = [
  'get', 'is', 'set', 'find', 'diff', 'tab', 'window',
  'cookies', 'storage', 'network', 'dialog', 'frame',
  'storage local', 'storage session',
];

/**
 * Parse a raw command string from an agent-browser invocation into command + args.
 * Handles multi-word commands like "get text", "is visible", "set viewport", etc.
 */
function parseAgentBrowserCommand(rawArgs: string): { command: string; args: string[] } {
  const parts = rawArgs.trim().split(/\s+/);

  // Try longest match first: 3-word commands (e.g., "storage local get")
  if (parts.length >= 3) {
    const three = parts.slice(0, 3).join(' ');
    if (ALL_COMMANDS.has(three)) {
      return { command: three, args: parts.slice(3) };
    }
  }

  // Try 2-word commands (e.g., "get text", "is visible")
  if (parts.length >= 2) {
    const two = parts.slice(0, 2).join(' ');
    if (ALL_COMMANDS.has(two)) {
      return { command: two, args: parts.slice(2) };
    }
  }

  // Single-word command
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * Extract all agent-browser invocations from bash code blocks in a SKILL.md file.
 */
export function extractBrowseCommands(skillPath: string): BrowseCommand[] {
  const content = fs.readFileSync(skillPath, 'utf-8');
  const lines = content.split('\n');
  const commands: BrowseCommand[] = [];

  let inBashBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect code block boundaries
    if (line.trimStart().startsWith('```')) {
      if (inBashBlock) {
        inBashBlock = false;
      } else if (line.trimStart().startsWith('```bash')) {
        inBashBlock = true;
      }
      // Non-bash code blocks (```json, ```, ```js, etc.) are skipped
      continue;
    }

    if (!inBashBlock) continue;

    // Skip lines where agent-browser is an argument to another command (e.g., "command -v agent-browser")
    if (/command\s+(-v\s+)?agent-browser/.test(line)) continue;
    if (/which\s+agent-browser/.test(line)) continue;
    if (/npm\s+install.*agent-browser/.test(line)) continue;

    // Match agent-browser invocations
    // Handle multiple on one line (e.g., "agent-browser click @e3       agent-browser fill @e4 "value"")
    const matches = line.matchAll(/agent-browser\s+(.+?)(?=\s+agent-browser\s|$)/g);
    for (const match of matches) {
      let rawArgs = match[1].trim();

      // Strip inline comments (# ...) — but not inside quotes
      let inQuote = false;
      for (let j = 0; j < rawArgs.length; j++) {
        if (rawArgs[j] === '"') inQuote = !inQuote;
        if (rawArgs[j] === '#' && !inQuote) {
          rawArgs = rawArgs.slice(0, j).trim();
          break;
        }
      }

      const { command, args: rawArgParts } = parseAgentBrowserCommand(rawArgs);

      // Parse args — handle quoted strings
      const args: string[] = [];
      const argsStr = rawArgParts.join(' ');
      if (argsStr) {
        const argMatches = argsStr.matchAll(/"([^"]*)"|(\S+)/g);
        for (const am of argMatches) {
          args.push(am[1] ?? am[2]);
        }
      }

      commands.push({
        command,
        args,
        line: i + 1, // 1-based
        raw: match[0].trim(),
      });
    }
  }

  return commands;
}

/**
 * Extract and validate all agent-browser commands in a SKILL.md file.
 */
export function validateSkill(skillPath: string): ValidationResult {
  const commands = extractBrowseCommands(skillPath);
  const result: ValidationResult = {
    valid: [],
    invalid: [],
    snapshotFlagErrors: [],
    warnings: [],
  };

  if (commands.length === 0) {
    result.warnings.push('no agent-browser commands found');
    return result;
  }

  for (const cmd of commands) {
    if (!ALL_COMMANDS.has(cmd.command)) {
      result.invalid.push(cmd);
      continue;
    }

    // Validate snapshot flags
    if (cmd.command === 'snapshot' && cmd.args.length > 0) {
      try {
        parseSnapshotArgs(cmd.args);
      } catch (err: any) {
        result.snapshotFlagErrors.push({ command: cmd, error: err.message });
        continue;
      }
    }

    result.valid.push(cmd);
  }

  return result;
}

/**
 * Extract all REMOTE_SLUG=$(...) assignment patterns from .md files in given subdirectories.
 * Returns a Map from filename → array of full assignment lines found.
 */
export function extractRemoteSlugPatterns(rootDir: string, subdirs: string[]): Map<string, string[]> {
  const results = new Map<string, string[]>();
  const pattern = /^REMOTE_SLUG=\$\(.*\)$/;

  for (const subdir of subdirs) {
    const dir = path.join(rootDir, subdir);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const matches: string[] = [];

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (pattern.test(trimmed)) {
          matches.push(trimmed);
        }
      }

      if (matches.length > 0) {
        results.set(`${subdir}/${file}`, matches);
      }
    }
  }

  return results;
}

/**
 * Parse a markdown weight table anchored to a "### Weights" heading.
 * Expects rows like: | Category | 15% |
 * Returns Map<category, number> where number is the percentage (e.g., 15).
 */
export function extractWeightsFromTable(content: string): Map<string, number> {
  const weights = new Map<string, number>();

  // Find the ### Weights section
  const weightsIdx = content.indexOf('### Weights');
  if (weightsIdx === -1) return weights;

  // Find the table within that section (stop at next heading or end)
  const section = content.slice(weightsIdx);
  const lines = section.split('\n');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();

    // Stop at next heading
    if (line.startsWith('#') && !line.startsWith('###')) break;
    if (line.startsWith('### ') && i > 0) break;

    // Parse table rows: | Category | N% |
    const match = line.match(/^\|\s*(\w[\w\s]*\w|\w+)\s*\|\s*(\d+)%\s*\|$/);
    if (match) {
      const category = match[1].trim();
      const pct = parseInt(match[2], 10);
      // Skip header row
      if (category !== 'Category' && !isNaN(pct)) {
        weights.set(category, pct);
      }
    }
  }

  return weights;
}
