#!/usr/bin/env bun
/**
 * Generate SKILL.md files from .tmpl templates.
 *
 * Pipeline:
 *   read .tmpl → find {{PLACEHOLDERS}} → resolve from source → format → write .md
 *
 * Supports --dry-run: generate to memory, exit 1 if different from committed file.
 * Used by skill:check and CI freshness checks.
 */

import { COMMAND_DESCRIPTIONS } from '../browse/src/commands';
import { SNAPSHOT_FLAGS } from '../browse/src/snapshot';
import { discoverTemplates } from './discover-skills';
import * as fs from 'fs';
import * as path from 'path';
import type { Host, TemplateContext } from './resolvers/types';
import { HOST_PATHS } from './resolvers/types';
import { RESOLVERS } from './resolvers/index';
import { codexSkillName, transformFrontmatter, extractHookSafetyProse, extractNameAndDescription, condenseOpenAIShortDescription, generateOpenAIYaml } from './resolvers/codex-helpers';

const ROOT = path.resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Host Detection ─────────────────────────────────────────

const HOST_ARG = process.argv.find(a => a.startsWith('--host'));
const HOST: Host = (() => {
  if (!HOST_ARG) return 'claude';
  const val = HOST_ARG.includes('=') ? HOST_ARG.split('=')[1] : process.argv[process.argv.indexOf(HOST_ARG) + 1];
  if (val === 'codex' || val === 'agents') return 'codex';
  if (val === 'claude') return 'claude';
  throw new Error(`Unknown host: ${val}. Use claude, codex, or agents.`);
})();

// ─── Template Processing ────────────────────────────────────

const GENERATED_HEADER = `<!-- AUTO-GENERATED from {{SOURCE}} — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n`;

function processTemplate(tmplPath: string, host: Host = 'claude'): { outputPath: string; content: string } {
  const tmplContent = fs.readFileSync(tmplPath, 'utf-8');
  const relTmplPath = path.relative(ROOT, tmplPath);
  let outputPath = tmplPath.replace(/\.tmpl$/, '');

  // Determine skill directory relative to ROOT
  const skillDir = path.relative(ROOT, path.dirname(tmplPath));

  let outputDir: string | null = null;

  // For codex host, route output to .agents/skills/{codexSkillName}/SKILL.md
  if (host === 'codex') {
    const codexName = codexSkillName(skillDir === '.' ? '' : skillDir);
    outputDir = path.join(ROOT, '.agents', 'skills', codexName);
    fs.mkdirSync(outputDir, { recursive: true });
    outputPath = path.join(outputDir, 'SKILL.md');
  }

  // Extract skill name from frontmatter for TemplateContext
  const { name: extractedName, description: extractedDescription } = extractNameAndDescription(tmplContent);
  const skillName = extractedName || path.basename(path.dirname(tmplPath));

  // Extract benefits-from list from frontmatter (inline YAML: benefits-from: [a, b])
  const benefitsMatch = tmplContent.match(/^benefits-from:\s*\[([^\]]*)\]/m);
  const benefitsFrom = benefitsMatch
    ? benefitsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  // Extract preamble-tier from frontmatter (1-4, controls which preamble sections are included)
  const tierMatch = tmplContent.match(/^preamble-tier:\s*(\d+)$/m);
  const preambleTier = tierMatch ? parseInt(tierMatch[1], 10) : undefined;

  const ctx: TemplateContext = { skillName, tmplPath, benefitsFrom, host, paths: HOST_PATHS[host], preambleTier };

  // Replace placeholders
  let content = tmplContent.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    const resolver = RESOLVERS[name];
    if (!resolver) throw new Error(`Unknown placeholder {{${name}}} in ${relTmplPath}`);
    return resolver(ctx);
  });

  // Check for any remaining unresolved placeholders
  const remaining = content.match(/\{\{(\w+)\}\}/g);
  if (remaining) {
    throw new Error(`Unresolved placeholders in ${relTmplPath}: ${remaining.join(', ')}`);
  }

  // Inject auto-trigger guard into skill descriptions.
  // Adds explicit trigger criteria so Claude Code doesn't auto-fire skills
  // based on semantic similarity. Preserves existing "Use when" and
  // "Proactively suggest" text (both are tested in skill-validation.test.ts).
  const triggerGuard = `  MANUAL TRIGGER ONLY: invoke only when user types /${skillName}.\n`;
  const descMatch = content.match(/^(description:\s*\|?\s*\n)/m);
  if (descMatch && descMatch.index !== undefined) {
    const insertAt = descMatch.index + descMatch[0].length;
    content = content.slice(0, insertAt) + triggerGuard + content.slice(insertAt);
  }

  // For codex host: transform frontmatter and replace Claude-specific paths
  if (host === 'codex') {
    // Extract hook safety prose BEFORE transforming frontmatter (which strips hooks)
    const safetyProse = extractHookSafetyProse(tmplContent);

    // Transform frontmatter: keep only name + description
    content = transformFrontmatter(content, host);

    // Insert safety advisory at the top of the body (after frontmatter)
    if (safetyProse) {
      const bodyStart = content.indexOf('\n---') + 4;
      content = content.slice(0, bodyStart) + '\n' + safetyProse + '\n' + content.slice(bodyStart);
    }

    // Replace remaining hardcoded Claude paths with host-appropriate paths
    content = content.replace(/~\/\.claude\/skills\/gstack/g, ctx.paths.skillRoot);
    content = content.replace(/\.claude\/skills\/gstack/g, ctx.paths.localSkillRoot);
    content = content.replace(/\.claude\/skills\/review/g, '.agents/skills/gstack/review');
    content = content.replace(/\.claude\/skills/g, '.agents/skills');

    if (outputDir) {
      const codexName = codexSkillName(skillDir === '.' ? '' : skillDir);
      const agentsDir = path.join(outputDir, 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      const displayName = codexName;
      const shortDescription = condenseOpenAIShortDescription(extractedDescription);
      fs.writeFileSync(path.join(agentsDir, 'openai.yaml'), generateOpenAIYaml(displayName, shortDescription));
    }
  }

  // Prepend generated header (after frontmatter)
  const header = GENERATED_HEADER.replace('{{SOURCE}}', path.basename(tmplPath));
  const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
  if (fmEnd !== -1) {
    const insertAt = content.indexOf('\n', fmEnd) + 1;
    content = content.slice(0, insertAt) + header + content.slice(insertAt);
  } else {
    content = header + content;
  }

  return { outputPath, content };
}

// ─── Main ───────────────────────────────────────────────────

function findTemplates(): string[] {
  return discoverTemplates(ROOT).map(t => path.join(ROOT, t.tmpl));
}

let hasChanges = false;
const tokenBudget: Array<{ skill: string; lines: number; tokens: number }> = [];

for (const tmplPath of findTemplates()) {
  // Skip /codex skill for codex host (self-referential — it's a Claude wrapper around codex exec)
  if (HOST === 'codex') {
    const dir = path.basename(path.dirname(tmplPath));
    if (dir === 'codex') continue;
  }

  const { outputPath, content } = processTemplate(tmplPath, HOST);
  const relOutput = path.relative(ROOT, outputPath);

  if (DRY_RUN) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
    if (existing !== content) {
      console.log(`STALE: ${relOutput}`);
      hasChanges = true;
    } else {
      console.log(`FRESH: ${relOutput}`);
    }
  } else {
    fs.writeFileSync(outputPath, content);
    console.log(`GENERATED: ${relOutput}`);
  }

  // Track token budget
  const lines = content.split('\n').length;
  const tokens = Math.round(content.length / 4); // ~4 chars per token
  tokenBudget.push({ skill: relOutput, lines, tokens });
}

if (DRY_RUN && hasChanges) {
  console.error('\nGenerated SKILL.md files are stale. Run: bun run gen:skill-docs');
  process.exit(1);
}

// Print token budget summary
if (!DRY_RUN && tokenBudget.length > 0) {
  tokenBudget.sort((a, b) => b.lines - a.lines);
  const totalLines = tokenBudget.reduce((s, t) => s + t.lines, 0);
  const totalTokens = tokenBudget.reduce((s, t) => s + t.tokens, 0);

  console.log('');
  console.log(`Token Budget (${HOST} host)`);
  console.log('═'.repeat(60));
  for (const t of tokenBudget) {
    const name = t.skill.replace(/\/SKILL\.md$/, '').replace(/^\.agents\/skills\//, '');
    console.log(`  ${name.padEnd(30)} ${String(t.lines).padStart(5)} lines  ~${String(t.tokens).padStart(6)} tokens`);
  }
  console.log('─'.repeat(60));
  console.log(`  ${'TOTAL'.padEnd(30)} ${String(totalLines).padStart(5)} lines  ~${String(totalTokens).padStart(6)} tokens`);
  console.log('');
}
