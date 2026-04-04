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

// ─── Antigravity Skills ───────────────────────────────────────────

const AGENTS_DIR = path.join(ROOT, '.agents', 'skills');
if (fs.existsSync(AGENTS_DIR)) {
  console.log('\n  Antigravity Skills (.agents/skills/):');
  const antigravityDirs = fs.readdirSync(AGENTS_DIR).sort();
  let antigravityCount = 0;
  let antigravityMissing = 0;
  for (const dir of antigravityDirs) {
    const skillMd = path.join(AGENTS_DIR, dir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      antigravityCount++;
      const content = fs.readFileSync(skillMd, 'utf-8');
      // Quick validation: must have frontmatter with name + description only
      const hasAntigravity = content.includes('.antigravity/skills');
      if (hasAntigravity) {
        hasErrors = true;
        console.log(`  \u274c ${dir.padEnd(30)} — contains .antigravity/skills reference`);
      } else {
        console.log(`  \u2705 ${dir.padEnd(30)} — OK`);
      }
    } else {
      antigravityMissing++;
      hasErrors = true;
      console.log(`  \u274c ${dir.padEnd(30)} — SKILL.md missing`);
    }
  }
  console.log(`  Total: ${antigravityCount} skills, ${antigravityMissing} missing`);
} else {
  console.log('\n  Antigravity Skills: .agents/skills/ not found (run: bun run gen:skill-docs --host antigravity)');
}

// ─── Factory Skills ─────────────────────────────────────────

const FACTORY_DIR = path.join(ROOT, '.factory', 'skills');
if (fs.existsSync(FACTORY_DIR)) {
  console.log('\n  Factory Skills (.factory/skills/):');
  const factoryDirs = fs.readdirSync(FACTORY_DIR).sort();
  let factoryCount = 0;
  let factoryMissing = 0;
  for (const dir of factoryDirs) {
    const skillMd = path.join(FACTORY_DIR, dir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      factoryCount++;
      const content = fs.readFileSync(skillMd, 'utf-8');
      const hasAntigravity = content.includes('.antigravity/skills');
      if (hasAntigravity) {
        hasErrors = true;
        console.log(`  \u274c ${dir.padEnd(30)} — contains .antigravity/skills reference`);
      } else {
        console.log(`  \u2705 ${dir.padEnd(30)} — OK`);
      }
    } else {
      factoryMissing++;
      hasErrors = true;
      console.log(`  \u274c ${dir.padEnd(30)} — SKILL.md missing`);
    }
  }
  console.log(`  Total: ${factoryCount} skills, ${factoryMissing} missing`);
} else {
  console.log('\n  Factory Skills: .factory/skills/ not found (run: bun run gen:skill-docs --host factory)');
}

// ─── Freshness ──────────────────────────────────────────────

console.log('\n  Freshness (Antigravity):');
try {
  execSync('bun run scripts/gen-skill-docs.ts --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Antigravity generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Antigravity generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs');
}

console.log('\n  Freshness (Antigravity):');
try {
  execSync('bun run scripts/gen-skill-docs.ts --host antigravity --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Antigravity generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Antigravity generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs --host antigravity');
}

console.log('\n  Freshness (Factory):');
try {
  execSync('bun run scripts/gen-skill-docs.ts --host factory --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 All Factory generated files are fresh');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c Factory generated files are stale:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      Run: bun run gen:skill-docs --host factory');
}

console.log('');
process.exit(hasErrors ? 1 : 0);
