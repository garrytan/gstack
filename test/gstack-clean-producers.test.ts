/**
 * gstack-clean removes only top-level tmp/codex-* files in a repository's
 * .gstack (lib/repo-state-clean.ts, #2627 D8). This test greps the tracked
 * templates, lib, bin and scripts for every producer of a .gstack/tmp/ entry
 * and fails when one is not classified below, as scratch gstack-clean may
 * remove or as kept, or when a codex-* name is not on the scratch list (a kept
 * file named codex-* would be deleted after 7 days). Classify a new producer
 * here before shipping it.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCRATCH_PREFIX } from '../lib/repo-state-clean';

const ROOT = path.resolve(import.meta.dir, '..');

/** Throwaway names gstack-clean removes after 7 days; every one starts with SCRATCH_PREFIX. Exact names, so a new codex-* producer must be looked at. */
const SCRATCH: Record<string, string> = {
  'codex-err-XXXXXX': 'codex stderr capture under TMP_ROOT, which falls back to .gstack/tmp (codex/sections/*.md.tmpl)',
  'codex-resp-XXXXXX': 'codex response capture under TMP_ROOT (codex/sections/*.md.tmpl)',
  'codex-out-XXXXXX': 'codex review output under TMP_ROOT (codex/sections/review-mode.md.tmpl)',
  'codex-prompt-XXXXXX': 'codex review prompt under TMP_ROOT (codex/sections/review-mode.md.tmpl)',
  'codex-prompt.XXXXXX': 'codex challenge and consult prompt, a free-text file in .gstack/tmp (codex/sections/*.md.tmpl)',
  'codex-focus.XXXXXX': 'codex review focus, a free-text file in .gstack/tmp (codex/sections/review-mode.md.tmpl)',
};

/** Names or name patterns (prefix* or *suffix) gstack-clean never touches. */
const KEPT: Record<string, string> = {
  'restamp-journal.json': 'gstack-restamp rollback journal (lib/restamp.ts)',
  'gate-ahead*': 'gate-ahead record and worktree (lib/restamp.ts)',
  'pregate.json': 'pregate result (lib/pregate/index.ts)',
  'ship-queue': 'ship-queue state (lib/ship-queue-gate.ts)',
  'ship-receipt.md': '/ship handoff receipt',
  'ship-gate.json': '/ship handoff gate record',
  'issues.json': '/ship issue links',
  'docs-audit.json': '/ship documentation audit record',
  'tree-receipt.json': 'gstack-tree-receipt output',
  'base-red.json': '/ship base-red record',
  'review-*': '/ship review loop records',
  'fix-check-*': '/ship fix-check inputs',
  'autoplan': 'autoplan phase artifacts (autoplan/SKILL.md.tmpl)',
  'eval-bisect': '/investigate eval bisect cache',
  'price-gate': 'gstack-eval-plan price receipts',
  'qt.txt': 'question-tuning summary file',
  'tune-words.txt': '/plan-tune free text',
  'before.txt': '/ship PR screenshot input',
  'after.txt': '/ship PR screenshot input',
  '*.XXXXXX': 'free-text and page mktemp files (scripts/resolvers/free-text-file.ts, scripts/resolvers/gbrain.ts)',
  '<*': 'a free-text file named by the basename its mktemp printed',
  'name*': 'bin/gstack-paths comment example for TMP_ROOT',
};

const matches = (name: string, pattern: string) => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern.startsWith('*') ? name.endsWith(pattern.slice(1)) : name === pattern;

function trackedSources(): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--', '*.tmpl', 'lib', 'bin', 'scripts', 'autoplan/bin', 'browse/src'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error('git ls-files failed: ' + r.stderr);
  return r.stdout.split('\0').filter(f => f && !/(^|\/)test\//.test(f) && !f.endsWith('.test.ts') && fs.existsSync(path.join(ROOT, f)));
}

/** Every .gstack/tmp entry name a source can create, with where it was seen. */
function producers(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (name: string, where: string) => { if (name && !found.has(name)) found.set(name, where); };
  for (const file of trackedSources()) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const at = (index: number) => file + ':' + (text.slice(0, index).split('\n').length);
    for (const m of text.matchAll(/\.gstack\/tmp\/([^\s"'`)\]}$;,|&*\\]*)/g)) add(m[1]!.split('/')[0]!.replace(/\.+$/, ''), at(m.index!));
    for (const m of text.matchAll(/['"]\.gstack['"],\s*['"]tmp['"](?:,\s*['"]([^'"]+)['"])?/g)) add(m[1] ?? '', at(m.index!));
    for (const m of text.matchAll(/\$\{?TMP_ROOT\}?\/([A-Za-z0-9._<>-]+)/g)) add(m[1]!, at(m.index!));
    for (const m of text.matchAll(/\{\{FREE_TEXT_FILE(?::([^}]*))?\}\}/g)) {
      for (const spec of (m[1] ?? 'TEXT_FILE=text').split(':')) add((spec.split('=')[1] || 'text') + '.XXXXXX', at(m.index!));
    }
  }
  return found;
}

describe('gstack-clean producer classification', () => {
  const found = producers();

  test('the scan sees the known producers', () => {
    for (const name of ['restamp-journal.json', 'pregate.json', 'ship-queue', 'autoplan', 'codex-err-XXXXXX']) expect(found.has(name)).toBe(true);
  });

  test('every .gstack/tmp producer is classified', () => {
    const problems: string[] = [];
    for (const [name, where] of found) {
      if (name.startsWith(SCRATCH_PREFIX)) {
        if (!(name in SCRATCH)) problems.push(where + ': ' + name + ' starts with ' + SCRATCH_PREFIX + ', so gstack-clean removes it after 7 days; add it to SCRATCH if it is throwaway, or rename it');
      } else if (!Object.keys(KEPT).some(pattern => matches(name, pattern))) {
        problems.push(where + ': ' + name + ' is not classified; add it to KEPT (or name it ' + SCRATCH_PREFIX + '* and add it to SCRATCH)');
      }
    }
    expect(problems).toEqual([]);
  });

  test('every classified entry still has a producer, and scratch is what gstack-clean removes', () => {
    expect(Object.keys(SCRATCH).filter(name => !name.startsWith(SCRATCH_PREFIX))).toEqual([]);
    const names = [...found.keys()];
    expect(Object.keys(SCRATCH).filter(name => !found.has(name))).toEqual([]);
    expect(Object.keys(KEPT).filter(pattern => !names.some(name => !name.startsWith(SCRATCH_PREFIX) && matches(name, pattern)))).toEqual([]);
  });
});
