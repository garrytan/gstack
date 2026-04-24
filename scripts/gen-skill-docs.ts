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
import { ALL_HOST_CONFIGS, ALL_HOST_NAMES, resolveHostArg, getHostConfig } from '../hosts/index';
import type { HostConfig } from './host-config';

const ROOT = path.resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Host Detection (config-driven) ─────────────────────────

const HOST_ARG = process.argv.find(a => a.startsWith('--host'));
type HostArg = Host | 'all';
const HOST_ARG_VAL: HostArg = (() => {
  if (!HOST_ARG) return 'claude';
  const val = HOST_ARG.includes('=') ? HOST_ARG.split('=')[1] : process.argv[process.argv.indexOf(HOST_ARG) + 1];
  if (val === 'all') return 'all';
  try {
    return resolveHostArg(val) as Host;
  } catch {
    throw new Error(`Unknown host: ${val}. Use ${ALL_HOST_NAMES.join(', ')}, or all.`);
  }
})();

// For single-host mode, HOST is the host. For --host all, it's set per iteration below.
let HOST: Host = HOST_ARG_VAL === 'all' ? 'claude' : HOST_ARG_VAL;

// ─── Model Overlay Selection ────────────────────────────────
// --model is explicit. We do NOT auto-detect from host (host ≠ model).
// Default is 'claude'. Missing overlay file → empty string (graceful).
import { ALL_MODEL_NAMES, resolveModel, type Model } from './models';
const MODEL_ARG = process.argv.find(a => a.startsWith('--model'));
const MODEL_ARG_VAL: Model = (() => {
  if (!MODEL_ARG) return 'claude';
  const val = MODEL_ARG.includes('=') ? MODEL_ARG.split('=')[1] : process.argv[process.argv.indexOf(MODEL_ARG) + 1];
  const resolved = resolveModel(val);
  if (!resolved) {
    throw new Error(`Unknown model: ${val}. Use ${ALL_MODEL_NAMES.join(', ')}, or a family variant (e.g., claude-opus-4-7, gpt-5.4-mini, o3).`);
  }
  return resolved;
})();

// HostPaths, HOST_PATHS, and TemplateContext imported from ./resolvers/types (line 7-8)
// Design constants (AI_SLOP_BLACKLIST, OPENAI_HARD_REJECTIONS, OPENAI_LITMUS_CHECKS)
// live in ./resolvers/constants and are consumed by resolvers directly.

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

// ─── Voice Trigger Processing ────────────────────────────────

/**
 * Extract voice-triggers YAML list from frontmatter.
 * Returns an array of trigger strings, or [] if no voice-triggers field.
 */
function extractVoiceTriggers(content: string): string[] {
  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return [];
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return [];
  const frontmatter = content.slice(fmStart + 4, fmEnd);

  const triggers: string[] = [];
  let inVoice = false;
  for (const line of frontmatter.split('\n')) {
    if (/^voice-triggers:/.test(line)) { inVoice = true; continue; }
    if (inVoice) {
      const m = line.match(/^\s+-\s+"(.+)"$/);
      if (m) triggers.push(m[1]);
      else if (!/^\s/.test(line)) break;
    }
  }
  return triggers;
}

/**
 * Preprocess voice triggers: fold voice-triggers YAML field into description,
 * then strip the field from frontmatter. Must run BEFORE transformFrontmatter
 * and extractNameAndDescription so all hosts see the updated description.
 */
function processVoiceTriggers(content: string): string {
  const triggers = extractVoiceTriggers(content);
  if (triggers.length === 0) return content;

  // Strip voice-triggers block from frontmatter
  content = content.replace(/^voice-triggers:\n(?:\s+-\s+"[^"]*"\n?)*/m, '');

  // Get current description (after stripping voice-triggers, so it's clean)
  const { description } = extractNameAndDescription(content);
  if (!description) return content;

  // Build new description with voice triggers appended
  const voiceLine = `Voice triggers (speech-to-text aliases): ${triggers.map(t => `"${t}"`).join(', ')}.`;
  const newDescription = description + '\n' + voiceLine;

  // Replace old indented description with new in frontmatter
  const oldIndented = description.split('\n').map(l => `  ${l}`).join('\n');
  const newIndented = newDescription.split('\n').map(l => `  ${l}`).join('\n');
  content = content.replace(oldIndented, newIndented);

  return content;
}

// Export for testing
export { extractVoiceTriggers, processVoiceTriggers };

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
  const hostConfig = getHostConfig(host);
  const fm = hostConfig.frontmatter;

  if (fm.mode === 'denylist') {
    // Denylist mode: strip listed fields, keep everything else
    for (const field of fm.stripFields || []) {
      if (field === 'voice-triggers') {
        content = content.replace(/^voice-triggers:\n(?:\s+-\s+"[^"]*"\n?)*/m, '');
      } else {
        content = content.replace(new RegExp(`^${field}:\\s*.*\\n`, 'm'), '');
      }
    }
    return content;
  }

  // Allowlist mode: reconstruct frontmatter with only allowed fields
  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return content;
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return content;
  const frontmatter = content.slice(fmStart + 4, fmEnd);
  const body = content.slice(fmEnd + 4);
  const { name, description } = extractNameAndDescription(content);

  // Description limit enforcement
  if (fm.descriptionLimit) {
    const behavior = fm.descriptionLimitBehavior || 'error';
    if (description.length > fm.descriptionLimit) {
      if (behavior === 'error') {
        throw new Error(
          `${hostConfig.displayName} description for "${name}" is ${description.length} chars (max ${fm.descriptionLimit}). ` +
          `Compress the description in the .tmpl file.`
        );
      } else if (behavior === 'warn') {
        console.warn(`WARNING: ${hostConfig.displayName} description for "${name}" exceeds ${fm.descriptionLimit} chars`);
      }
      // 'truncate' — silently proceed
    }
  }

  // Build frontmatter with allowed fields
  const indentedDesc = description.split('\n').map(l => `  ${l}`).join('\n');
  let newFm = `---\nname: ${name}\ndescription: |\n${indentedDesc}\n`;

  // Add extra fields (host-wide)
  if (fm.extraFields) {
    for (const [key, value] of Object.entries(fm.extraFields)) {
      if (key !== 'name' && key !== 'description') {
        newFm += `${key}: ${value}\n`;
      }
    }
  }

  // Add conditional fields
  if (fm.conditionalFields) {
    for (const rule of fm.conditionalFields) {
      const match = Object.entries(rule.if).every(([k, v]) =>
        new RegExp(`^${k}:\\s*${v}`, 'm').test(frontmatter)
      );
      if (match) {
        for (const [key, value] of Object.entries(rule.add)) {
          newFm += `${key}: ${value}\n`;
        }
      }
    }
  }

  // Preserve additional keepFields beyond name and description
  if (fm.keepFields) {
    for (const field of fm.keepFields) {
      if (field === 'name' || field === 'description') continue;
      // Match YAML field with possible multi-line/array value (indented lines after colon)
      const fieldMatch = frontmatter.match(new RegExp(`^${field}:(.*(?:\\n(?:[ \\t]+.+))*)`, 'm'));
      if (fieldMatch) {
        newFm += `${field}:${fieldMatch[1]}\n`;
      }
    }
  }

  // Rename fields (copy values from template frontmatter with new keys)
  if (fm.renameFields) {
    for (const [oldName, newName] of Object.entries(fm.renameFields)) {
      const fieldMatch = frontmatter.match(new RegExp(`^${oldName}:(.+(?:\\n(?:\\s+.+)*)?)`, 'm'));
      if (fieldMatch) {
        newFm += `${newName}:${fieldMatch[1]}\n`;
      }
    }
  }

  newFm += '---';
  return newFm + body;
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

// ─── External Host Config (now derived from hosts/*.ts) ──────
// EXTERNAL_HOST_CONFIG replaced by getHostConfig() from hosts/index.ts

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
  const hostConfig = getHostConfig(host);

  const name = externalSkillName(skillDir === '.' ? '' : skillDir, frontmatterName);
  const outputDir = path.join(ROOT, hostConfig.hostSubdir, 'skills', name);
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

  // Config-driven path rewrites (order matters, replaceAll)
  for (const rewrite of hostConfig.pathRewrites) {
    result = result.replaceAll(rewrite.from, rewrite.to);
  }

  // Config-driven tool rewrites
  if (hostConfig.toolRewrites) {
    for (const [from, to] of Object.entries(hostConfig.toolRewrites)) {
      result = result.replaceAll(from, to);
    }
  }

  // Config-driven: generate metadata (e.g., openai.yaml for Codex)
  if (hostConfig.generation.generateMetadata && !symlinkLoop) {
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

  // Extract interactive flag from frontmatter (generator-only; controls plan-mode handshake inclusion)
  const interactiveMatch = tmplContent.match(/^interactive:\s*(true|false)\s*$/m);
  const interactive = interactiveMatch ? interactiveMatch[1] === 'true' : undefined;

  const ctx: TemplateContext = { skillName, tmplPath, benefitsFrom, host, paths: HOST_PATHS[host], preambleTier, model: MODEL_ARG_VAL, interactive };

  // Replace placeholders (supports parameterized: {{NAME:arg1:arg2}})
  // Config-driven: suppressedResolvers return empty string for this host
  const currentHostConfig = getHostConfig(host);
  const suppressed = new Set(currentHostConfig.suppressedResolvers || []);
  let content = tmplContent.replace(/\{\{(\w+(?::[^}]+)?)\}\}/g, (match, fullKey) => {
    const parts = fullKey.split(':');
    const resolverName = parts[0];
    const args = parts.slice(1);
    if (suppressed.has(resolverName)) return '';
    const resolver = RESOLVERS[resolverName];
    if (!resolver) throw new Error(`Unknown placeholder {{${resolverName}}} in ${relTmplPath}`);
    return args.length > 0 ? resolver(ctx, args) : resolver(ctx);
  });

  // Check for any remaining unresolved placeholders
  const remaining = content.match(/\{\{(\w+(?::[^}]+)?)\}\}/g);
  if (remaining) {
    throw new Error(`Unresolved placeholders in ${relTmplPath}: ${remaining.join(', ')}`);
  }

  // Preprocess voice triggers: fold into description, strip field from frontmatter.
  // Must run BEFORE transformFrontmatter so all hosts see the updated description,
  // and BEFORE extractedDescription is used by external host metadata.
  content = processVoiceTriggers(content);

  // Re-extract description AFTER voice trigger preprocessing so Codex openai.yaml
  // metadata gets the updated description with voice triggers included.
  const postProcessDescription = extractNameAndDescription(content).description;

  // For Claude: strip sensitive: field (only Factory uses it)
  // For external hosts: route output, transform frontmatter, rewrite paths
  let symlinkLoop = false;
  if (host === 'claude') {
    content = transformFrontmatter(content, host);
  } else {
    const result = processExternalHost(content, tmplContent, host, skillDir, postProcessDescription, ctx, extractedName || undefined);
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

const ALL_HOSTS: Host[] = ALL_HOST_NAMES as Host[];
const hostsToRun: Host[] = HOST_ARG_VAL === 'all' ? ALL_HOSTS : [HOST];
const failures: { host: string; error: Error }[] = [];

for (const currentHost of hostsToRun) {
  HOST = currentHost;

  try {
    let hasChanges = false;
    const tokenBudget: Array<{ skill: string; lines: number; tokens: number }> = [];

    const currentHostConfig = getHostConfig(currentHost);
    for (const tmplPath of findTemplates()) {
      const dir = path.basename(path.dirname(tmplPath));

      // includeSkills allowlist (union logic: include minus skip)
      if (currentHostConfig.generation.includeSkills?.length) {
        if (!currentHostConfig.generation.includeSkills.includes(dir)) continue;
      }
      // skipSkills denylist (subtracts from includeSkills or full set)
      if (currentHostConfig.generation.skipSkills?.length) {
        if (currentHostConfig.generation.skipSkills.includes(dir)) continue;
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

      // Token ceiling check: warn if any generated SKILL.md exceeds ~40K tokens (160KB).
      // The ceiling is a "watch for feature bloat" guardrail, not a hard gate. Modern
      // flagship models have 200K-1M context windows, so 40K (4-20% of window) is fine.
      // Prompt caching further reduces the marginal cost of larger skills. This ceiling
      // exists to catch a runaway preamble or resolver that's grown by 10K+ tokens in
      // a release, not to force compression on carefully-tuned big skills (ship,
      // plan-ceo-review, office-hours all legitimately pack 25-35K tokens of behavior).
      const TOKEN_CEILING_BYTES = 160_000;
      if (content.length > TOKEN_CEILING_BYTES) {
        console.warn(`⚠️  TOKEN CEILING: ${relOutput} is ${content.length} bytes (~${tokens} tokens), exceeds ${TOKEN_CEILING_BYTES} byte ceiling (~40K tokens)`);
      }
    }

    // Generate gstack-lite and gstack-full for OpenClaw host
    if (currentHost === 'openclaw' && !DRY_RUN) {
      const openclawDir = path.join(ROOT, 'openclaw');
      if (!fs.existsSync(openclawDir)) fs.mkdirSync(openclawDir, { recursive: true });

      const gstackLite = `# gstack-lite Planning Discipline

Injected by the orchestrator into spawned Claude Code sessions. Append to existing CLAUDE.md.

## Planning Discipline
1. Read every file you will modify. Understand existing patterns first.
2. Before writing code, state your plan: what, why, which files, test case, risk.
3. When ambiguous, prefer: completeness over shortcuts, existing patterns over new ones,
   reversible choices over irreversible ones, safe defaults over clever ones.
4. Self-review your changes before reporting done. Check for: missed files, broken
   imports, untested paths, style inconsistencies.
5. Report when done: what shipped, what decisions you made, anything uncertain.
`;
      fs.writeFileSync(path.join(openclawDir, 'gstack-lite-CLAUDE.md'), gstackLite);
      console.log('GENERATED: openclaw/gstack-lite-CLAUDE.md');

      const gstackFull = `# gstack-full Pipeline

Injected by the orchestrator for complete feature builds. Append to existing CLAUDE.md.

## Full Pipeline
1. Read CLAUDE.md and understand the project context.
2. Run /autoplan to review your approach (CEO + eng + design review pipeline).
3. Implement the approved plan. Follow the planning discipline above.
4. Run /ship to create a PR with tests, changelog, and version bump.
5. Report back: PR URL, what shipped, decisions made, anything uncertain.

Do not ask for human input until the PR is ready for review.
`;
      fs.writeFileSync(path.join(openclawDir, 'gstack-full-CLAUDE.md'), gstackFull);
      console.log('GENERATED: openclaw/gstack-full-CLAUDE.md');

      const gstackPlan = `# gstack-plan: Full Review Gauntlet

Injected by the orchestrator when the user wants to plan a Claude Code project.
Append to existing CLAUDE.md.

## Planning Pipeline
1. Read CLAUDE.md and understand the project context.
2. Run /office-hours to produce a design doc (problem statement, premises, alternatives).
3. Run /autoplan to review the design (CEO + eng + design + DX reviews + codex adversarial).
4. Save the final reviewed plan to a file the orchestrator can reference later.
   Write it to: plans/<project-slug>-plan-<date>.md in the current repo.
   Include the design doc, all review decisions, and the implementation sequence.
5. Report back to the orchestrator:
   - Plan file path
   - One-paragraph summary of what was designed and the key decisions
   - List of accepted scope expansions (if any)
   - Recommended next step (usually: spawn a new session with gstack-full to implement)

Do not implement anything. This is planning only.
The orchestrator will persist the plan link to its own memory/knowledge store.
`;
      fs.writeFileSync(path.join(openclawDir, 'gstack-plan-CLAUDE.md'), gstackPlan);
      console.log('GENERATED: openclaw/gstack-plan-CLAUDE.md');
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
        const hostSubdirs = ALL_HOST_CONFIGS.map(c => c.hostSubdir.replace('.', '\\.')).join('|');
        const name = t.skill.replace(/\/SKILL\.md$/, '').replace(new RegExp(`^\\.(${hostSubdirs})\\/skills\\/`), '');
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
