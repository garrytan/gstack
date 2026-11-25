import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

setDefaultTimeout(60_000);
const BIN = path.join(import.meta.dir, '..', 'bin');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const money = (cap: number) => `export const spendCapUsd = ${cap};\nexport function charge(amountUsd: number) { if (amountUsd > spendCapUsd) throw new Error("over cap"); return amountUsd; }\n`;
const bootstrap = '#!/usr/bin/env bash\nset -euo pipefail\n' + Array.from({ length: 66 }, (_, i) => `echo "step ${i + 1}"\n`).join('');
const pregate = (stages: string[]) => JSON.stringify({ stages: stages.map(name => ({ name, run: `bun test ${name}` })) }, null, 2) + '\n';

/**
 * The harness-evals #354 shape: the targeted reader read R, round 1 fixed a below-floor finding after R, and then a plain main
 * merge brought gate-class content (an executable bootstrap script and
 * .gstack/pregate.json) next to the PR's own small change since R: a changelog fragment, a docs line and a manifest line.
 */
function merged(own: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-range-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-range-state-'));
  dirs.push(dir, state);
  const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_APPROVALS_MIRROR: '0' };
  delete env.GSTACK_APPROVALS_DIR;
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
  const commit = (files: Record<string, string>, msg: string) => {
    for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
    git('add', '.'); git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  commit({ 'README.md': '# x\n', 'docs/README.md': '# Docs\n\nIntro.\n', 'manifest.json': '{\n  "name": "x",\n  "files": ["src"]\n}\n', '.gstack/pregate.json': pregate(['unit']) }, 'base');
  git('checkout', '-qb', 'feat');
  const read = commit({ 'src/billing.ts': money(25) }, 'feature');
  const plan = (args: string[]) => spawnSync(path.join(BIN, 'gstack-review-plan'), ['--base', 'main', '--gate-tagged', '0', ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
  const ran = JSON.parse(plan(['--json']).stdout).targeted.targeted_patch_id as string;
  commit({ 'src/billing.ts': money(30) }, 'round 1 fix');
  git('checkout', '-q', 'main');
  commit({ 'scripts/ubicloud/bootstrap.sh': bootstrap, '.gstack/pregate.json': pregate(['unit', 'e2e', 'smoke']) }, 'main: ubicloud bootstrap');
  fs.chmodSync(path.join(dir, 'scripts/ubicloud/bootstrap.sh'), 0o755); git('add', '.'); git('commit', '-qm', 'main: executable bootstrap');
  git('checkout', '-q', 'feat');
  expect(spawnSync('git', ['merge', '-q', '--no-edit', 'main'], { cwd: dir, encoding: 'utf8', timeout: 10_000 }).status).toBe(0);
  commit(own, 'own change after the merge');
  return plan(['--pass', '1', '--last', 'full', '--fixed-below', '--range-base', read, '--targeted-ran', ran]);
}
const lineOf = (stdout: string, key: string) => stdout.split('\n').find(l => l.startsWith(`${key}: `)) ?? '';
const small = { 'changelog.d/billing-cap.md': '- **Billing cap documented.**\n', 'docs/README.md': '# Docs\n\nIntro, with the billing cap.\n', 'manifest.json': '{\n  "name": "x",\n  "files": ["src", "docs"]\n}\n' };

describe('the fix range counts only the PR\'s own change after a main merge (GST-2229, harness-evals #354)', () => {
  // Value: protects=a plain main merge since --range-base does not make gate-class content main already shipped count as the PR's
  //   own fix range: with a small own change, round 2 is the plain full pass, not a gate-class one;
  //   fails_when=the fix range diffs --range-base against HEAD, so main's bootstrap script and pregate.json mark it touched_gate and the
  //   plan reads round 2 as a gate-class fix (harness-evals #354: next=voices); seam=bin/gstack-review-plan's fix range;
  //   no_claim=what the targeted reader finds
  test('main\'s merged gate-class files leave the fix range, and round 2 is the plain full pass', () => {
    const p = merged(small);
    expect(p.status, p.stderr).toBe(0);
    expect(Number(/^FIX_RANGE: runtime_lines=(\d+) /.exec(lineOf(p.stdout, 'FIX_RANGE'))?.[1])).toBeLessThan(10);
    expect(lineOf(p.stdout, 'NEXT')).toStartWith('NEXT: full (below-floor fixes changed code after round 1');
    expect(p.stdout).not.toContain('gate-class');
  });

  // Value: protects=hold: a gate-class edit in the PR's own change since --range-base still escalates after the same merge;
  //   fails_when=measuring the PR's own change drops its own pregate.json edit and round 2 reads as a plain fix;
  //   seam=bin/gstack-review-plan's fix range; no_claim=none
  test('the PR\'s own pregate.json edit after the merge still marks the fix range gate class', () => {
    const p = merged({ ...small, '.gstack/pregate.json': pregate(['unit', 'e2e', 'smoke', 'billing']) });
    expect(p.status, p.stderr).toBe(0);
    expect(lineOf(p.stdout, 'NEXT')).toBe('NEXT: full (a fix touched a gate-class path: full pass on the range)');
  });
});
