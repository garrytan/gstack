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
import { externalSkillName, extractHookSafetyProse as _extractHookSafetyProse, extractNameAndDescription as _extractNameAndDescription, condenseOpenAIShortDescription as _condenseOpenAIShortDescription, generateOpenAIYaml as _generateOpenAIYaml } from './resolvers/codex-helpers';
import { generatePlanCompletionAuditShip, generatePlanCompletionAuditReview, generatePlanVerificationExec } from './resolvers/review';

const ROOT = path.resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Host Detection ─────────────────────────────────────────

const HOST_ARG = process.argv.find(a => a.startsWith('--host'));
type HostArg = Host | 'all';
const HOST_ARG_VAL: HostArg = (() => {
  if (!HOST_ARG) return 'claude';
  const val = HOST_ARG.includes('=') ? HOST_ARG.split('=')[1] : process.argv[process.argv.indexOf(HOST_ARG) + 1];
  if (val === 'codex' || val === 'agents') return 'codex';
  if (val === 'factory' || val === 'droid') return 'factory';
  if (val === 'claude') return 'claude';
  if (val === 'all') return 'all';
  throw new Error(`Unknown host: ${val}. Use claude, codex, factory, droid, agents, or all.`);
})();

// For single-host mode, HOST is the host. For --host all, it's set per iteration below.
let HOST: Host = HOST_ARG_VAL === 'all' ? 'claude' : HOST_ARG_VAL;

// HostPaths, HOST_PATHS, and TemplateContext imported from ./resolvers/types (line 7-8)

// ─── Shared Design Constants ────────────────────────────────

/** gstack's 10 AI slop anti-patterns — shared between DESIGN_METHODOLOGY and DESIGN_HARD_RULES */
const AI_SLOP_BLACKLIST = [
  'Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes',
  '**The 3-column feature grid:** icon-in-colored-circle + bold title + 2-line description, repeated 3x symmetrically. THE most recognizable AI layout.',
  'Icons in colored circles as section decoration (SaaS starter template look)',
  'Centered everything (`text-align: center` on all headings, descriptions, cards)',
  'Uniform bubbly border-radius on every element (same large radius on everything)',
  'Decorative blobs, floating circles, wavy SVG dividers (if a section feels empty, it needs better content, not decoration)',
  'Emoji as design elements (rockets in headings, emoji as bullet points)',
  'Colored left-border on cards (`border-left: 3px solid <accent>`)',
  'Generic hero copy ("Welcome to [X]", "Unlock the power of...", "Your all-in-one solution for...")',
  'Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, every section same height)',
];

/** OpenAI hard rejection criteria (from "Designing Delightful Frontends with GPT-5.4", Mar 2026) */
const OPENAI_HARD_REJECTIONS = [
  'Generic SaaS card grid as first impression',
  'Beautiful image with weak brand',
  'Strong headline with no clear action',
  'Busy imagery behind text',
  'Sections repeating same mood statement',
  'Carousel with no narrative purpose',
  'App UI made of stacked cards instead of layout',
];

/** OpenAI litmus checks — 7 yes/no tests for cross-model consensus scoring */
const OPENAI_LITMUS_CHECKS = [
  'Brand/product unmistakable in first screen?',
  'One strong visual anchor present?',
  'Page understandable by scanning headlines only?',
  'Each section has one job?',
  'Are cards actually necessary?',
  'Does motion improve hierarchy or atmosphere?',
  'Would design feel premium with all decorative shadows removed?',
];

// ─── External Host Helpers ───────────────────────────────────

// Re-export local copy for use in this file (matches codex-helpers.ts)
// Accepts optional frontmatter name to support directory/invocation name divergence
function externalSkillName(skillDir: string, frontmatterName?: string): string {
  // Root skill (skillDir === '' or '.') always maps to 'gstack' regardless of frontmatter
  if (skillDir === '.' || skillDir === '') return 'gstack';
  // Use frontmatter name when it differs from directory name (e.g., run-tests/ with name: test)
  const baseName = frontmatterName && frontmatterName !== skillDir ? frontmatterName : skillDir;
  // Don't double-prefix: gstack-upgrade → gstack-upgrade (not gstack-gstack-upgrade)
  if (baseName.startsWith('gstack-')) return baseName;
  return `gstack-${baseName}`;
}

function extractNameAndDescription(content: string): { name: string; description: string } {
  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return { name: '', description: '' };
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return { name: '', description: '' };

  const frontmatter = content.slice(fmStart + 4, fmEnd);
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : '';

  let description = '';
  const lines = frontmatter.split('\n');
  let inDescription = false;
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.match(/^description:\s*\|?\s*$/)) {
      inDescription = true;
      continue;
    }
    if (line.match(/^description:\s*\S/)) {
      description = line.replace(/^description:\s*/, '').trim();
      break;
    }
    if (inDescription) {
      if (line === '' || line.match(/^\s/)) {
        descLines.push(line.replace(/^  /, ''));
      } else {
        break;
      }
    }
  }
  if (descLines.length > 0) {
    description = descLines.join('\n').trim();
  }

  return { name, description };
}

const OPENAI_SHORT_DESCRIPTION_LIMIT = 120;

function condenseOpenAIShortDescription(description: string): string {
  const firstParagraph = description.split(/\n\s*\n/)[0] || description;
  const collapsed = firstParagraph.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= OPENAI_SHORT_DESCRIPTION_LIMIT) return collapsed;

  const truncated = collapsed.slice(0, OPENAI_SHORT_DESCRIPTION_LIMIT - 3);
  const lastSpace = truncated.lastIndexOf(' ');
  const safe = lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated;
  return `${safe}...`;
}

function generateOpenAIYaml(displayName: string, shortDescription: string): string {
  return `interface:
  display_name: ${JSON.stringify(displayName)}
  short_description: ${JSON.stringify(shortDescription)}
  default_prompt: ${JSON.stringify(`Use ${displayName} for this task.`)}
policy:
  allow_implicit_invocation: true
`;
}

/**
 * Transform frontmatter for external hosts.
 * Claude: strips `sensitive:` field (only Factory uses it).
 * Codex: keeps name + description only, enforces 1024-char limit.
 * Factory: keeps name + description + user-invocable, conditionally adds disable-model-invocation.
 */
function transformFrontmatter(content: string, host: Host): string {
  if (host === 'claude') {
    // Strip sensitive: field from Claude output (only Factory uses it)
    return content.replace(/^sensitive:\s*true\n/m, '');
  }

  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return content;
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return content;
  const frontmatter = content.slice(fmStart + 4, fmEnd);
  const body = content.slice(fmEnd + 4); // includes the leading \n after ---
  const { name, description } = extractNameAndDescription(content);

  if (host === 'codex') {
    // Codex 1024-char description limit — fail build, don't ship broken skills
    const MAX_DESC = 1024;
    if (description.length > MAX_DESC) {
      throw new Error(
        `Codex description for "${name}" is ${description.length} chars (max ${MAX_DESC}). ` +
        `Compress the description in the .tmpl file.`
      );
    }
    const indentedDesc = description.split('\n').map(l => `  ${l}`).join('\n');
    return `---\nname: ${name}\ndescription: |\n${indentedDesc}\n---` + body;
  }

  if (host === 'factory') {
    const sensitive = /^sensitive:\s*true/m.test(frontmatter);
    const indentedDesc = description.split('\n').map(l => `  ${l}`).join('\n');
    let fm = `---\nname: ${name}\ndescription: |\n${indentedDesc}\nuser-invocable: true\n`;
    if (sensitive) fm += `disable-model-invocation: true\n`;
    fm += '---';
    return fm + body;
  }

  return content; // unknown host: passthrough
}

/**
 * Extract hook descriptions from frontmatter for inline safety prose.
 * Returns a description of what the hooks do, or null if no hooks.
 */
function extractHookSafetyProse(tmplContent: string): string | null {
  if (!tmplContent.match(/^hooks:/m)) return null;

  // Parse the hook matchers to build a human-readable safety description
  const matchers: string[] = [];
  const matcherRegex = /matcher:\s*"(\w+)"/g;
  let m;
  while ((m = matcherRegex.exec(tmplContent)) !== null) {
    if (!matchers.includes(m[1])) matchers.push(m[1]);
  }

  if (matchers.length === 0) return null;

  // Build safety prose based on what tools are hooked
  const toolDescriptions: Record<string, string> = {
    Bash: 'check bash commands for destructive operations (rm -rf, DROP TABLE, force-push, git reset --hard, etc.) before execution',
    Edit: 'verify file edits are within the allowed scope boundary before applying',
    Write: 'verify file writes are within the allowed scope boundary before applying',
  };

  const safetyChecks = matchers
    .map(t => toolDescriptions[t] || `check ${t} operations for safety`)
    .join(', and ');

  return `> **Safety Advisory:** This skill includes safety checks that ${safetyChecks}. When using this skill, always pause and verify before executing potentially destructive operations. If uncertain about a command's safety, ask the user for confirmation before proceeding.`;
}

// ─── External Host Config ────────────────────────────────────

interface ExternalHostConfig {
  hostSubdir: string;          // '.agents' | '.factory'
  generateMetadata: boolean;   // true for codex (openai.yaml), false for factory
  descriptionLimit?: number;   // 1024 for codex, undefined for factory
}

const EXTERNAL_HOST_CONFIG: Record<string, ExternalHostConfig> = {
  codex:   { hostSubdir: '.agents',  generateMetadata: true,  descriptionLimit: 1024 },
  factory: { hostSubdir: '.factory', generateMetadata: false },
};

// ─── Template Processing ────────────────────────────────────

const GENERATED_HEADER = `<!-- AUTO-GENERATED from {{SOURCE}} — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n`;

/**
 * Process external host output: routing, frontmatter, path rewrites, metadata.
 * Shared between Codex and Factory (and future external hosts).
 */
function processExternalHost(
  content: string,
  tmplContent: string,
  host: Host,
  skillDir: string,
  extractedDescription: string,
  ctx: TemplateContext,
  frontmatterName?: string,
): { content: string; outputPath: string; outputDir: string; symlinkLoop: boolean } {
  const config = EXTERNAL_HOST_CONFIG[host];
  if (!config) throw new Error(`No external host config for: ${host}`);

  const name = externalSkillName(skillDir === '.' ? '' : skillDir, frontmatterName);
  const outputDir = path.join(ROOT, config.hostSubdir, 'skills', name);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'SKILL.md');

  // Guard against symlink loops
  let symlinkLoop = false;
  const claudePath = ctx.tmplPath.replace(/\.tmpl$/, '');
  try {
    const resolvedClaude = fs.realpathSync(claudePath);
    const resolvedExternal = fs.realpathSync(path.dirname(outputPath)) + '/' + path.basename(outputPath);
    if (resolvedClaude === resolvedExternal) {
      symlinkLoop = true;
    }
  } catch {
    // realpathSync fails if file doesn't exist yet — no symlink loop
  }

  // Extract hook safety prose BEFORE transforming frontmatter (which strips hooks)
  const safetyProse = extractHookSafetyProse(tmplContent);

  // Transform frontmatter (host-aware)
  let result = transformFrontmatter(content, host);

  // Insert safety advisory at the top of the body (after frontmatter)
  if (safetyProse) {
    const bodyStart = result.indexOf('\n---') + 4;
    result = result.slice(0, bodyStart) + '\n' + safetyProse + '\n' + result.slice(bodyStart);
  }

  // Replace hardcoded Claude paths with host-appropriate paths
  result = result.replace(/~\/\.claude\/skills\/gstack/g, ctx.paths.skillRoot);
  result = result.replace(/\.claude\/skills\/gstack/g, ctx.paths.localSkillRoot);
  result = result.replace(/\.claude\/skills\/review/g, `${config.hostSubdir}/skills/gstack/review`);
  result = result.replace(/\.claude\/skills/g, `${config.hostSubdir}/skills`);

  // Factory-only: translate Claude Code tool names to generic phrasing
  if (host === 'factory') {
    result = result.replace(/use the Bash tool/g, 'run this command');
    result = result.replace(/use the Write tool/g, 'create this file');
    result = result.replace(/use the Read tool/g, 'read the file');
    result = result.replace(/use the Agent tool/g, 'dispatch a subagent');
    result = result.replace(/use the Grep tool/g, 'search for');
    result = result.replace(/use the Glob tool/g, 'find files matching');
  }

  // Codex-only: generate openai.yaml metadata
  if (config.generateMetadata && !symlinkLoop) {
    const agentsDir = path.join(outputDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const shortDescription = condenseOpenAIShortDescription(extractedDescription);
    fs.writeFileSync(path.join(agentsDir, 'openai.yaml'), generateOpenAIYaml(name, shortDescription));
  }

  return { content: result, outputPath, outputDir, symlinkLoop };
}

function processTemplate(tmplPath: string, host: Host = 'claude'): { outputPath: string; content: string; symlinkLoop?: boolean } {
  const tmplContent = fs.readFileSync(tmplPath, 'utf-8');
  const relTmplPath = path.relative(ROOT, tmplPath);
  let outputPath = tmplPath.replace(/\.tmpl$/, '');

  // Determine skill directory relative to ROOT
  const skillDir = path.relative(ROOT, path.dirname(tmplPath));

  // Extract skill name from frontmatter early — needed for both TemplateContext and external host output paths.
  // When frontmatter name: differs from directory name (e.g., run-tests/ with name: test),
  // the frontmatter name is used for external skill naming and setup script symlinks.
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

  // Replace placeholders (supports parameterized: {{NAME:arg1:arg2}})
  let content = tmplContent.replace(/\{\{(\w+(?::[^}]+)?)\}\}/g, (match, fullKey) => {
    const parts = fullKey.split(':');
    const resolverName = parts[0];
    const args = parts.slice(1);
    const resolver = RESOLVERS[resolverName];
    if (!resolver) throw new Error(`Unknown placeholder {{${resolverName}}} in ${relTmplPath}`);
    return args.length > 0 ? resolver(ctx, args) : resolver(ctx);
  });

  // Check for any remaining unresolved placeholders
  const remaining = content.match(/\{\{(\w+(?::[^}]+)?)\}\}/g);
  if (remaining) {
    throw new Error(`Unresolved placeholders in ${relTmplPath}: ${remaining.join(', ')}`);
  }

  // For Claude: strip sensitive: field (only Factory uses it)
  // For external hosts: route output, transform frontmatter, rewrite paths
  let symlinkLoop = false;
  if (host === 'claude') {
    content = transformFrontmatter(content, host);
  } else {
    const result = processExternalHost(content, tmplContent, host, skillDir, extractedDescription, ctx, extractedName || undefined);
    content = result.content;
    outputPath = result.outputPath;
    symlinkLoop = result.symlinkLoop;
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

  return { outputPath, content, symlinkLoop };
}

// ─── Main ───────────────────────────────────────────────────

function findTemplates(): string[] {
  return discoverTemplates(ROOT).map(t => path.join(ROOT, t.tmpl));
}

const ALL_HOSTS: Host[] = ['claude', 'codex', 'factory'];
const hostsToRun: Host[] = HOST_ARG_VAL === 'all' ? ALL_HOSTS : [HOST];
const failures: { host: string; error: Error }[] = [];

for (const currentHost of hostsToRun) {
  HOST = currentHost;

  try {
    let hasChanges = false;
    const tokenBudget: Array<{ skill: string; lines: number; tokens: number }> = [];

    for (const tmplPath of findTemplates()) {
      // Skip /codex skill for non-Claude hosts (it's a Claude wrapper around codex exec)
      if (currentHost !== 'claude') {
        const dir = path.basename(path.dirname(tmplPath));
        if (dir === 'codex') continue;
      }

      const { outputPath, content, symlinkLoop } = processTemplate(tmplPath, currentHost);
      const relOutput = path.relative(ROOT, outputPath);

      if (symlinkLoop) {
        console.log(`SKIPPED (symlink loop): ${relOutput}`);
      } else if (DRY_RUN) {
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
      console.error(`\nGenerated SKILL.md files are stale (${currentHost} host). Run: bun run gen:skill-docs --host ${currentHost}`);
      if (HOST_ARG_VAL !== 'all') process.exit(1);
      failures.push({ host: currentHost, error: new Error('Stale files detected') });
    }

    // Print token budget summary
    if (!DRY_RUN && tokenBudget.length > 0) {
      tokenBudget.sort((a, b) => b.lines - a.lines);
      const totalLines = tokenBudget.reduce((s, t) => s + t.lines, 0);
      const totalTokens = tokenBudget.reduce((s, t) => s + t.tokens, 0);

      console.log('');
      console.log(`Token Budget (${currentHost} host)`);
      console.log('═'.repeat(60));
      for (const t of tokenBudget) {
        const name = t.skill.replace(/\/SKILL\.md$/, '').replace(/^\.(agents|factory)\/skills\//, '');
        console.log(`  ${name.padEnd(30)} ${String(t.lines).padStart(5)} lines  ~${String(t.tokens).padStart(6)} tokens`);
      }
      console.log('─'.repeat(60));
      console.log(`  ${'TOTAL'.padEnd(30)} ${String(totalLines).padStart(5)} lines  ~${String(totalTokens).padStart(6)} tokens`);
      console.log('');
    }
  } catch (e) {
    failures.push({ host: currentHost, error: e as Error });
    console.error(`WARNING: ${currentHost} generation failed: ${(e as Error).message}`);
  }
}

// --host all: report failures. Only exit(1) if claude failed.
if (failures.length > 0 && HOST_ARG_VAL === 'all') {
  console.error(`\n${failures.length} host(s) failed: ${failures.map(f => f.host).join(', ')}`);
  if (failures.some(f => f.host === 'claude')) process.exit(1);
}
// Single host dry-run failure already handled above

// After all hosts processed, warn if prefix patches may need re-applying
if (!DRY_RUN) {
  try {
    const configPath = path.join(process.env.HOME || '', '.gstack', 'config.yaml');
    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, 'utf-8');
      if (/^skill_prefix:\s*true/m.test(config)) {
        console.log('\nNote: skill_prefix is true. Run gstack-relink to re-apply name: patches.');
      }
    }
  } catch { /* non-fatal */ }
}
