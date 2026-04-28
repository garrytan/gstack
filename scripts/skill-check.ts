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
import { ALL_HOST_CONFIGS, getExternalHosts, getHostConfig } from '../hosts/index';
import { discoverTemplates, discoverSkillFiles } from './discover-skills';
import { collectSkillContextBudget, evaluateSkillContextBudget, formatBytes } from './skill-context-budget';
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
const CLAUDE_SKIPPED_SKILL_DIRS = new Set(getHostConfig('claude').generation.skipSkills ?? []);

function templateSkillDir(tmpl: string): string {
  const dir = path.dirname(tmpl);
  return dir === '.' ? '' : dir;
}

for (const { tmpl, output } of TEMPLATES) {
  const tmplPath = path.join(ROOT, tmpl);
  const outPath = path.join(ROOT, output);
  const skippedForClaude = CLAUDE_SKIPPED_SKILL_DIRS.has(templateSkillDir(tmpl));

  if (!fs.existsSync(tmplPath)) {
    console.log(`  \u26a0\ufe0f  ${output.padEnd(30)} — no template`);
    continue;
  }
  if (skippedForClaude) {
    console.log(`  -  ${tmpl.padEnd(30)} — skipped for Claude host`);
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

// ─── Context Budget ─────────────────────────────────────────

console.log('\n  Context Budget:');
const budgetReport = collectSkillContextBudget(ROOT);
const budgetEvaluation = evaluateSkillContextBudget(budgetReport);

console.log(
  `  Visible: ${budgetReport.visibleSkills.length} skills, ` +
  `${formatBytes(budgetReport.totals.visibleBytes)} ` +
  `(~${budgetReport.totals.visibleApproxTokens} tokens)`,
);
console.log(
  `  Discovery: ${budgetReport.totals.visibleDescriptionChars} description chars, ` +
  `${budgetReport.eagerCatalog.chars} catalog chars`,
);
console.log(
  `  Hidden host outputs: ${budgetReport.hiddenHostSkills.length} skills, ` +
  `${formatBytes(budgetReport.totals.hiddenHostBytes)}`,
);

for (const error of budgetEvaluation.errors) {
  hasErrors = true;
  console.log(`  \u274c ${error.path ?? error.code} — ${error.message}`);
}

const hiddenHostWarningCount = budgetEvaluation.warnings.filter(warning => warning.path?.startsWith('.')).length;
const budgetWarnings = budgetEvaluation.warnings.filter(warning => !warning.path?.startsWith('.'));
const warningPreview = budgetWarnings.slice(0, 8);
for (const warning of warningPreview) {
  console.log(`  \u26a0\ufe0f  ${warning.path ?? warning.code} — ${warning.message}`);
}
if (hiddenHostWarningCount > 0) {
  console.log(
    `  \u26a0\ufe0f  ${budgetReport.hiddenHostSkills.length} hidden host generated skill file(s) present ` +
    `(${hiddenHostWarningCount} warning(s)); run: bun run skill:budget`,
  );
}
if (budgetWarnings.length > warningPreview.length) {
  console.log(`  \u26a0\ufe0f  ${budgetWarnings.length - warningPreview.length} more budget warning(s); run: bun run skill:budget`);
}
if (budgetEvaluation.errors.length === 0) {
  console.log('  \u2705 Hard budget checks pass');
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
