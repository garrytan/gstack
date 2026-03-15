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
  'ship/SKILL.md',
  'review/SKILL.md',
  'retro/SKILL.md',
  'plan-ceo-review/SKILL.md',
  'plan-eng-review/SKILL.md',
  'setup-browser-cookies/SKILL.md',
].filter(f => fs.existsSync(path.join(ROOT, f)));

let hasErrors = false;

// ─── Skills ─────────────────────────────────────────────────

console.log('  スキル:');
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
    console.log(`  \u274c ${file.padEnd(30)} — 有効 ${totalValid}, 無効 ${totalInvalid}, snapshot エラー ${totalSnapErrors}`);
    for (const inv of result.invalid) {
      console.log(`      行 ${inv.line}: 不明なコマンド '${inv.command}'`);
    }
    for (const se of result.snapshotFlagErrors) {
      console.log(`      行 ${se.command.line}: ${se.error}`);
    }
  } else {
    console.log(`  \u2705 ${file.padEnd(30)} — ${totalValid} コマンド、すべて有効`);
  }
}

// ─── Templates ──────────────────────────────────────────────

console.log('\n  テンプレート:');
const TEMPLATES = [
  { tmpl: 'SKILL.md.tmpl', output: 'SKILL.md' },
  { tmpl: 'browse/SKILL.md.tmpl', output: 'browse/SKILL.md' },
];

for (const { tmpl, output } of TEMPLATES) {
  const tmplPath = path.join(ROOT, tmpl);
  const outPath = path.join(ROOT, output);
  if (!fs.existsSync(tmplPath)) {
    console.log(`  \u26a0\ufe0f  ${output.padEnd(30)} — テンプレートなし`);
    continue;
  }
  if (!fs.existsSync(outPath)) {
    hasErrors = true;
    console.log(`  \u274c ${output.padEnd(30)} — 生成済みファイルがありません。実行: bun run gen:skill-docs`);
    continue;
  }
  console.log(`  \u2705 ${tmpl.padEnd(30)} \u2192 ${output}`);
}

// Skills without templates
for (const file of SKILL_FILES) {
  const tmplPath = path.join(ROOT, file + '.tmpl');
  if (!fs.existsSync(tmplPath) && !TEMPLATES.some(t => t.output === file)) {
    console.log(`  \u26a0\ufe0f  ${file.padEnd(30)} — テンプレートなし（$B コマンドが無ければ問題なし）`);
  }
}

// ─── Freshness ──────────────────────────────────────────────

console.log('\n  鮮度チェック:');
try {
  execSync('bun run scripts/gen-skill-docs.ts --dry-run', { cwd: ROOT, stdio: 'pipe' });
  console.log('  \u2705 すべての生成ファイルは最新です');
} catch (err: any) {
  hasErrors = true;
  const output = err.stdout?.toString() || '';
  console.log('  \u274c 生成ファイルが古いです:');
  for (const line of output.split('\n').filter((l: string) => l.startsWith('STALE'))) {
    console.log(`      ${line}`);
  }
  console.log('      実行: bun run gen:skill-docs');
}

console.log('');
process.exit(hasErrors ? 1 : 0);
