#!/usr/bin/env bun
/**
 * skill:check — Health summary for all SKILL.md files.
 *
 * Reports:
 *   - Command validation (valid/invalid/snapshot errors)
 *   - Template coverage (which SKILL.md files have .tmpl sources)
 *   - Freshness check (generated files match committed files)
 */

import { validateSkill } from '../test/helpers/skill-parser';
import { discoverTemplates, discoverSkillFiles } from './discover-skills';
import { resolveCodexGenerationModel } from './resolve-codex-generation-model';
import { ALL_HOST_CONFIGS, getExternalHosts, getHostConfig } from '../hosts/index';
import type { HostConfig } from './host-config';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const ROOT_REALPATH = fs.realpathSync(ROOT);

function isRepoRootSymlink(candidateDir: string): boolean {
  try {
    return fs.realpathSync(candidateDir) === ROOT_REALPATH;
  } catch {
    return false;
  }
}

/**
 * Canonical in-tree SKILL.md files are the Claude-host render. A host may
 * deliberately exclude a same-name wrapper skill (for example, /claude is an
 * outside-voice skill that must not be installed in Claude Code). Such a
 * template has no canonical Claude output by design and is not "missing".
 */
export function hostGeneratesTemplate(
  tmpl: string,
  hostConfig: HostConfig,
  rootDir = ROOT,
): boolean {
  const parent = path.dirname(tmpl);
  const skillDir = parent === '.' ? path.basename(rootDir) : parent.split(path.sep)[0];
  const included = hostConfig.generation.includeSkills;
  if (included?.length && !included.includes(skillDir)) return false;
  return !hostConfig.generation.skipSkills?.includes(skillDir);
}

export interface FreshnessInvocation {
  args: string[];
  command: string;
  model?: string;
  modelSource?: string;
  warnings: string[];
}

/** Build the exact generator invocation setup uses for the effective host. */
export function freshnessInvocation(
  hostConfig: HostConfig,
  env: NodeJS.ProcessEnv = process.env,
): FreshnessInvocation {
  const args = ['run', 'scripts/gen-skill-docs.ts'];
  if (hostConfig.name !== 'claude') args.push('--host', hostConfig.name);

  let model: string | undefined;
  let modelSource: string | undefined;
  let warnings: string[] = [];
  if (hostConfig.name === 'codex') {
    const resolution = resolveCodexGenerationModel({
      codexHome: env.CODEX_HOME,
      home: env.HOME,
    });
    model = resolution.model;
    modelSource = resolution.source;
    warnings = resolution.warnings;
    args.push('--model', resolution.model);
  }

  args.push('--dry-run');
  return {
    args,
    command: ['bun', ...args].join(' '),
    model,
    modelSource,
    warnings,
  };
}

if (import.meta.main) {

// Find all SKILL.md files (dynamic discovery — no hardcoded list)
const SKILL_FILES = discoverSkillFiles(ROOT);

let hasErrors = false;

// ─── Skills ─────────────────────────────────────────────────

console.log('  Skills:');
for (const file of SKILL_FILES) {
  const fullPath = path.join(ROOT, file);
  const result = validateSkill(fullPath);

  if (result.warnings.length > 0) {
    console.log(`  \u26a0\ufe0f  ${file.padEnd(30)} — ${result.warnings.join(', ')}`);
    continue;
  }

  const totalValid = result.valid.length;
  const totalInvalid = result.invalid.length;
  const totalSnapErrors = result.snapshotFlagErrors.length;

  if (totalInvalid > 0 || totalSnapErrors > 0) {
    hasErrors = true;
    console.log(`  \u274c ${file.padEnd(30)} — ${totalValid} valid, ${totalInvalid} invalid, ${totalSnapErrors} snapshot errors`);
    for (const inv of result.invalid) {
      console.log(`      line ${inv.line}: unknown command '${inv.command}'`);
    }
    for (const se of result.snapshotFlagErrors) {
      console.log(`      line ${se.command.line}: ${se.error}`);
    }
  } else {
    console.log(`  \u2705 ${file.padEnd(30)} — ${totalValid} commands, all valid`);
  }
}

// ─── Templates ──────────────────────────────────────────────

console.log('\n  Templates:');
const TEMPLATES = discoverTemplates(ROOT);
const canonicalHost = getHostConfig('claude');

for (const { tmpl, output } of TEMPLATES) {
  const tmplPath = path.join(ROOT, tmpl);
  const outPath = path.join(ROOT, output);
  if (!hostGeneratesTemplate(tmpl, canonicalHost)) {
    console.log(`  -  ${tmpl.padEnd(30)} — skipped for ${canonicalHost.displayName}`);
    continue;
  }
  if (!fs.existsSync(tmplPath)) {
    console.log(`  \u26a0\ufe0f  ${output.padEnd(30)} — no template`);
    continue;
  }
  if (!fs.existsSync(outPath)) {
    hasErrors = true;
    console.log(`  \u274c ${output.padEnd(30)} — generated file missing! Run: bun run gen:skill-docs`);
    continue;
  }
  console.log(`  \u2705 ${tmpl.padEnd(30)} \u2192 ${output}`);
}

// Skills without templates
for (const file of SKILL_FILES) {
  const tmplPath = path.join(ROOT, file + '.tmpl');
  if (!fs.existsSync(tmplPath) && !TEMPLATES.some(t => t.output === file)) {
    console.log(`  \u26a0\ufe0f  ${file.padEnd(30)} — no template (OK if no $B commands)`);
  }
}

// ─── External Host Skills (config-driven) ───────────────────

for (const hostConfig of getExternalHosts()) {
  const hostDir = path.join(ROOT, hostConfig.hostSubdir, 'skills');
  if (fs.existsSync(hostDir)) {
    console.log(`\n  ${hostConfig.displayName} Skills (${hostConfig.hostSubdir}/skills/):`);
    const dirs = fs.readdirSync(hostDir).sort();
    let count = 0;
    let missing = 0;
    for (const dir of dirs) {
      const skillDir = path.join(hostDir, dir);
      if (isRepoRootSymlink(skillDir)) {
        console.log(`  -  ${dir.padEnd(30)} — sidecar symlink, skipped`);
        continue;
      }
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        count++;
        const content = fs.readFileSync(skillMd, 'utf-8');
        const hasClaude = content.includes('.claude/skills');
        if (hasClaude) {
          hasErrors = true;
          console.log(`  \u274c ${dir.padEnd(30)} — contains .claude/skills reference`);
        } else {
          console.log(`  \u2705 ${dir.padEnd(30)} — OK`);
        }
      } else {
        missing++;
        hasErrors = true;
        console.log(`  \u274c ${dir.padEnd(30)} — SKILL.md missing`);
      }
    }
    console.log(`  Total: ${count} skills, ${missing} missing`);
  } else {
    console.log(`\n  ${hostConfig.displayName} Skills: ${hostConfig.hostSubdir}/skills/ not found (run: bun run gen:skill-docs --host ${hostConfig.name})`);
  }
}

// ─── Freshness (config-driven) ──────────────────────────────

for (const hostConfig of ALL_HOST_CONFIGS) {
  const invocation = freshnessInvocation(hostConfig);
  console.log(`\n  Freshness (${hostConfig.displayName}):`);
  if (invocation.model) {
    console.log(`  Profile: ${invocation.model} (${invocation.modelSource})`);
  }
  for (const warning of invocation.warnings) {
    console.log(`  ⚠️  ${warning}`);
  }
  const result = spawnSync('bun', invocation.args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 120_000,
  });
  if (!result.error && result.status === 0) {
    console.log(`  \u2705 All ${hostConfig.displayName} generated files are fresh`);
  } else {
    hasErrors = true;
    const output = result.stdout || '';
    console.log(`  \u274c ${hostConfig.displayName} generated files are stale:`);
    for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
      console.log(`      ${line}`);
    }
    if (result.error) console.log(`      ${result.error.message}`);
    console.log(`      Run: ${invocation.command.replace(/ --dry-run$/, '')}`);
  }
}

console.log('');
process.exit(hasErrors ? 1 : 0);
}
