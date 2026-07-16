#!/usr/bin/env bun
/**
 * dev:skill — Watch mode for SKILL.md template development.
 *
 * Watches .tmpl files, regenerates SKILL.md files on change,
 * validates all $B commands immediately.
 */

import { validateSkill } from '../test/helpers/skill-parser';
import { discoverTemplates } from './discover-skills';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const TEMPLATES = discoverTemplates(ROOT).map(t => ({
  tmpl: path.join(ROOT, t.tmpl),
  output: t.output,
}));

function regenerateAndValidate() {
  // Regenerate
  try {
    execSync('bun run scripts/gen-skill-docs.ts', { cwd: ROOT, stdio: 'pipe' });
  } catch (err: any) {
    console.log(`  [gen]   ERROR: ${err.stderr?.toString().trim() || err.message}`);
    return;
  }

  // Validate each generated file
  for (const { output } of TEMPLATES) {
    const fullPath = path.join(ROOT, output);
    if (!fs.existsSync(fullPath)) continue;

    const result = validateSkill(fullPath);
    const totalValid = result.valid.length;
    const totalInvalid = result.invalid.length;
    const totalSnapErrors = result.snapshotFlagErrors.length;

    if (totalInvalid > 0 || totalSnapErrors > 0) {
      console.log(`  [check] \u274c ${output} (${totalValid} valid)`);
      for (const inv of result.invalid) {
        console.log(`          Unknown command: '${inv.command}' at line ${inv.line}`);
      }
      for (const se of result.snapshotFlagErrors) {
        console.log(`          ${se.error} at line ${se.command.line}`);
      }
    } else {
      console.log(`  [check] \u2705 ${output} — ${totalValid} commands, all valid`);
    }
  }

  // Dev workspace render isolation: the default in-place regen above keeps the
  // worktree canonical. If bin/dev-setup set up an untracked brain-aware render
  // (.claude/gstack-rendered), refresh it too so live template edits reflect at
  // this workspace's runtime. Only runs when the render dir already exists — we
  // never create it during plain template dev.
  const RENDER_DIR = path.join(ROOT, '.claude', 'gstack-rendered');
  if (fs.existsSync(RENDER_DIR)) {
    try {
      execSync(
        `bun run scripts/gen-skill-docs.ts --respect-detection --host claude --out-dir ${JSON.stringify(RENDER_DIR)}`,
        { cwd: ROOT, stdio: 'pipe' },
      );
      console.log('  [render] refreshed .claude/gstack-rendered (brain-aware workspace copy)');
    } catch (err: any) {
      console.log(`  [render] ERROR: ${err.stderr?.toString().trim() || err.message}`);
    }
  }
}

// Initial run
console.log('  [watch] Watching *.md.tmpl files...');
regenerateAndValidate();

// Watch for changes
for (const { tmpl } of TEMPLATES) {
  if (!fs.existsSync(tmpl)) continue;
  fs.watch(tmpl, () => {
    console.log(`\n  [watch] ${path.relative(ROOT, tmpl)} changed`);
    regenerateAndValidate();
  });
}

// Also watch commands.ts and snapshot.ts (source of truth changes)
const SOURCE_FILES = [
  path.join(ROOT, 'browse', 'src', 'commands.ts'),
  path.join(ROOT, 'browse', 'src', 'snapshot.ts'),
];

for (const src of SOURCE_FILES) {
  if (!fs.existsSync(src)) continue;
  fs.watch(src, () => {
    console.log(`\n  [watch] ${path.relative(ROOT, src)} changed`);
    regenerateAndValidate();
  });
}

// Keep alive
console.log('  [watch] Press Ctrl+C to stop\n');
