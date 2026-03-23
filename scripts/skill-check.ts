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
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

// Find all SKILL.md files
const SKILL_FILES = [
  'SKILL.md',
  'browse/SKILL.md',
  'qa/SKILL.md',
  'qa-only/SKILL.md',
  'ship/SKILL.md',
  'review/SKILL.md',
  'retro/SKILL.md',
  'plan-ceo-review/SKILL.md',
  'plan-eng-review/SKILL.md',
  'setup-browser-cookies/SKILL.md',
  'plan-design-review/SKILL.md',
  'design-review/SKILL.md',
  'gstack-upgrade/SKILL.md',
  'document-release/SKILL.md',
  'canary/SKILL.md',
  'benchmark/SKILL.md',
  'land-and-deploy/SKILL.md',
  'setup-deploy/SKILL.md',
  'cso/SKILL.md',
].filter(f => fs.existsSync(path.join(ROOT, f)));

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
const TEMPLATES = [
  { tmpl: 'SKILL.md.tmpl', output: 'SKILL.md' },
  { tmpl: 'browse/SKILL.md.tmpl', output: 'browse/SKILL.md' },
];

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

// ─── Codex Skills ───────────────────────────────────────────

const AGENTS_DIR = path.join(ROOT, '.agents', 'skills');
if (fs.existsSync(AGENTS_DIR)) {
  console.log('\n  Codex Skills (.agents/skills/):');
  const codexDirs = fs.readdirSync(AGENTS_DIR).sort();
  let codexCount = 0;
  let codexMissing = 0;
  for (const dir of codexDirs) {
    const skillMd = path.join(AGENTS_DIR, dir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      codexCount++;
      const content = fs.readFileSync(skillMd, 'utf-8');
      // Quick validation: must have frontmatter with name + description only
      const hasClaude = content.includes('.claude/skills');
      if (hasClaude) {
        hasErrors = true;
        console.log(`  \u274c ${dir.padEnd(30)} — contains .claude/skills reference`);
      } else {
        console.log(`  \u2705 ${dir.padEnd(30)} — OK`);
      }
    } else {
      codexMissing++;
      hasErrors = true;
      console.log(`  \u274c ${dir.padEnd(30)} — SKILL.md missing`);
    }
  }
  console.log(`  Total: ${codexCount} skills, ${codexMissing} missing`);
} else {
  console.log('\n  Codex Skills: .agents/skills/ not found (run: bun run gen:skill-docs --host codex)');
}

// ─── Freshness ──────────────────────────────────────────────

console.log('\n  Freshness (Claude):');
try {
  execSync('bun run scripts/gen-skill-docs.ts --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Claude generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Claude generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs');
}

console.log('\n  Freshness (Codex):');
try {
  execSync('bun run scripts/gen-skill-docs.ts --host codex --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Codex generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Codex generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs --host codex');
}

console.log('');
process.exit(hasErrors ? 1 : 0);
