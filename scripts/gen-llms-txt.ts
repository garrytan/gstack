#!/usr/bin/env bun
/**
 * Generate gstack/llms.txt — a single discoverable index of every gstack
 * capability for AI agents.
 *
 * Inputs:
 *   - Skill SKILL.md.tmpl frontmatter (name, description) at root and one
 *     level deep, via scripts/discover-skills.ts
 *   - browse/src/commands.ts COMMAND_DESCRIPTIONS
 *   - design/src/commands.ts COMMAND_DESCRIPTIONS (if present)
 *
 * Output: gstack/llms.txt at repo root.
 *
 * Refresh: invoked from scripts/gen-skill-docs.ts after SKILL.md generation
 * so it regenerates automatically on every skill change.
 *
 * Convention: https://llmstxt.org/ (single-file index agents can crawl).
 */

import * as fs from 'fs';
import * as path from 'path';
import { discoverTemplates } from './discover-skills';
import { COMMAND_DESCRIPTIONS as BROWSE_COMMANDS } from '../browse/src/commands';

const ROOT = path.resolve(import.meta.dir, '..');
const OUTPUT = path.join(ROOT, 'gstack', 'llms.txt');

interface SkillEntry {
  name: string;
  description: string;
}

/**
 * Parse YAML frontmatter at the top of a SKILL.md.tmpl file. We only need
 * `name` and `description`. description: | followed by indented lines is
 * the gstack convention; we collapse those into a single paragraph.
 */
function parseSkillFrontmatter(filePath: string): SkillEntry | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return null;
  const frontmatter = content.slice(3, end).split('\n');

  let name = '';
  let description = '';
  let inDescription = false;
  let descriptionLines: string[] = [];

  for (const rawLine of frontmatter) {
    const line = rawLine.replace(/\r$/, '');
    if (inDescription) {
      // Block-scalar continues until a non-indented (or differently-keyed) line.
      if (line.startsWith('  ') || line === '') {
        descriptionLines.push(line.replace(/^  /, ''));
        continue;
      }
      inDescription = false;
      // Fall through to normal key parsing for this line.
    }
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === 'name') {
      name = value.trim();
    } else if (key === 'description') {
      if (value === '|' || value === '|-' || value === '>' || value === '>-') {
        inDescription = true;
        descriptionLines = [];
      } else {
        description = value.trim();
      }
    }
  }

  if (!description && descriptionLines.length) {
    description = descriptionLines
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  if (!name) return null;
  if (!description) return null;
  return { name, description };
}

/**
 * Best-effort import of the design CLI's COMMAND_DESCRIPTIONS. Only present
 * in a full gstack checkout; absent on minimal installs. Returns {} if the
 * module isn't found rather than throwing.
 */
async function readDesignCommands(): Promise<Record<string, { category: string; description: string; usage?: string }>> {
  const designCommandsPath = path.join(ROOT, 'design', 'src', 'commands.ts');
  if (!fs.existsSync(designCommandsPath)) return {};
  try {
    const mod: unknown = await import(designCommandsPath);
    const m = mod as { COMMAND_DESCRIPTIONS?: Record<string, { category: string; description: string; usage?: string }> };
    return m.COMMAND_DESCRIPTIONS ?? {};
  } catch {
    return {};
  }
}

/**
 * Render a one-line summary from a multi-paragraph description: take the
 * first sentence (up to '.', '!', or '?') and trim. Keeps llms.txt scannable.
 */
function oneLine(text: string): string {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return first.replace(/\s+/g, ' ').trim();
}

interface GenerateOptions {
  /** Override repo root (for tests). */
  root?: string;
  /** When true, missing skill description should fail the build. */
  strict?: boolean;
}

export interface GenerateResult {
  content: string;
  skills: SkillEntry[];
  browseCommands: string[];
  designCommands: string[];
  warnings: string[];
}

export async function generateLlmsTxt(opts: GenerateOptions = {}): Promise<GenerateResult> {
  const root = opts.root ?? ROOT;
  const warnings: string[] = [];

  const templates = discoverTemplates(root);
  const skills: SkillEntry[] = [];
  for (const t of templates) {
    const filePath = path.join(root, t.tmpl);
    const entry = parseSkillFrontmatter(filePath);
    if (!entry) {
      warnings.push(`skill ${t.tmpl}: missing name or description in frontmatter`);
      if (opts.strict) {
        throw new Error(`gen-llms-txt: ${t.tmpl} is missing name or description in frontmatter`);
      }
      continue;
    }
    skills.push(entry);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const browseCommands = Object.keys(BROWSE_COMMANDS).sort();
  const designCommands = Object.keys(await readDesignCommands()).sort();

  const lines: string[] = [];
  lines.push('# gstack');
  lines.push('');
  lines.push("> gstack is Garry's Stack: AI coding skills + a fast headless browser binary + a design CLI. This file indexes every capability so agents can discover and invoke them without crawling individual SKILL.md files.");
  lines.push('');
  lines.push('Conventions:');
  lines.push('- Skills are invoked by name (e.g. `/ship`, `/plan-ceo-review`).');
  lines.push('- Browse commands run as `browse <command> [args]` (or `$B` shorthand).');
  lines.push('- Design commands run as `design <command> [args]` (or `$D`).');
  lines.push('- Project-specific config lives in `CLAUDE.md`. Always read it first.');
  lines.push('');

  lines.push('## Skills');
  lines.push('');
  for (const skill of skills) {
    const summary = oneLine(skill.description);
    lines.push(`- [/${skill.name}](${skill.name}/SKILL.md): ${summary}`);
  }
  lines.push('');

  lines.push('## Browse Commands');
  lines.push('');
  lines.push('Run with `browse <command> [args]`. Full reference: `browse/SKILL.md`.');
  lines.push('');
  const byCategory: Record<string, Array<{ name: string; description: string; usage?: string }>> = {};
  for (const cmd of browseCommands) {
    const meta = BROWSE_COMMANDS[cmd];
    const cat = meta.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({ name: cmd, description: meta.description, usage: meta.usage });
  }
  for (const cat of Object.keys(byCategory).sort()) {
    lines.push(`### ${cat}`);
    for (const cmd of byCategory[cat]) {
      const usage = cmd.usage ? `\`${cmd.usage}\`` : `\`${cmd.name}\``;
      lines.push(`- ${usage}: ${oneLine(cmd.description)}`);
    }
    lines.push('');
  }

  if (designCommands.length > 0) {
    lines.push('## Design Commands');
    lines.push('');
    lines.push('Run with `design <command> [args]`. Full reference: `design/SKILL.md`.');
    lines.push('');
    const designMeta = await readDesignCommands();
    for (const cmd of designCommands) {
      const meta = designMeta[cmd];
      lines.push(`- \`${cmd}\`: ${oneLine(meta.description)}`);
    }
    lines.push('');
  }

  lines.push('## More');
  lines.push('');
  lines.push('- Repository: https://github.com/garrytan/gstack');
  lines.push('- Top-level guide: `SKILL.md`');
  lines.push('- Project ethos: `ETHOS.md`');
  lines.push('- This file is auto-generated by `bun run gen:skill-docs`.');
  lines.push('');

  return {
    content: lines.join('\n'),
    skills,
    browseCommands,
    designCommands,
    warnings,
  };
}

export async function writeLlmsTxt(opts: GenerateOptions & { outputPath?: string } = {}): Promise<GenerateResult> {
  const result = await generateLlmsTxt(opts);
  const outputPath = opts.outputPath ?? OUTPUT;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, result.content, { encoding: 'utf-8' });
  return result;
}

// ─── CLI entry ──────────────────────────────────────────────
// Wrapped in an IIFE so top-level await doesn't make this module async-by-
// import (which would break require() consumers like
// test/gen-skill-docs.test.ts that pull writeLlmsTxt indirectly via
// gen-skill-docs).
if (import.meta.main) {
  void (async () => {
    const strict = process.argv.includes('--strict');
    const dryRun = process.argv.includes('--dry-run');
    const result = dryRun
      ? await generateLlmsTxt({ strict })
      : await writeLlmsTxt({ strict });

    for (const w of result.warnings) console.error(`[gen-llms-txt] WARN: ${w}`);

    if (dryRun) {
      const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf-8') : '';
      if (existing !== result.content) {
        console.error('[gen-llms-txt] OUT OF DATE — run `bun run gen:skill-docs` to regenerate gstack/llms.txt');
        process.exit(1);
      }
      console.log('[gen-llms-txt] up to date');
    } else {
      console.log(`[gen-llms-txt] wrote ${OUTPUT}`);
      console.log(`[gen-llms-txt]   skills=${result.skills.length} browse=${result.browseCommands.length} design=${result.designCommands.length}`);
    }
  })();
}
