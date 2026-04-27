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
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const ROOT_REALPATH = fs.realpathSync(ROOT);

function isRepoRootSymlink(candidateDir: string): boolean {
  try {
    return fs.realpathSync(candidateDir) === ROOT_REALPATH;
  } catch {
    return false;
  }
}

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

for (const { tmpl, output } of TEMPLATES) {
  const tmplPath = path.join(ROOT, tmpl);
  const outPath = path.join(ROOT, output);
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

import { getExternalHosts } from '../hosts/index';

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

import { ALL_HOST_CONFIGS } from '../hosts/index';

for (const hostConfig of ALL_HOST_CONFIGS) {
  const hostFlag = hostConfig.name === 'claude' ? '' : ` --host ${hostConfig.name}`;
  console.log(`\n  Freshness (${hostConfig.displayName}):`);
  try {
    execSync(`bun run scripts/gen-skill-docs.ts${hostFlag} --dry-run`, { cwd: ROOT, stdio: 'pipe' });
    console.log(`  \u2705 All ${hostConfig.displayName} generated files are fresh`);
  } catch (err: any) {
    hasErrors = true;
    const output = err.stdout?.toString() || '';
    console.log(`  \u274c ${hostConfig.displayName} generated files are stale:`);
    for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
      console.log(`      ${line}`);
    }
    console.log(`      Run: bun run gen:skill-docs${hostFlag}`);
  }
}

console.log('');
process.exit(hasErrors ? 1 : 0);
