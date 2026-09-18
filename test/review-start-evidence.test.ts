import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findFilesBySuffix, gitArgvIn } from './helpers/scratch-repo';

const ROOT = resolve(import.meta.dir, '..');
let repo: string;
let home: string;

function cli(name: string, args: string[] = [], cwd = repo) {
  return execFileSync(join(ROOT, 'bin', name), args, {
    cwd, env: { ...process.env, GSTACK_HOME: home }, encoding: 'utf8', timeout: 10_000,
  }).trim();
}

function git(...args: string[]) {
  const result = gitArgvIn(repo, args, 10_000);
  if (result.error || result.status !== 0)
    throw new Error(`Fixture git failed: ${result.error?.message ?? result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function log(token?: string, overrides: Record<string, any> = {}) {
  const record = {
    skill: 'review', status: 'clean', timestamp: new Date().toISOString(),
    commit: git('rev-parse', '--short', 'HEAD'), completed: true, converged: true, cycles: 0,
    ...overrides,
  };
  cli('gstack-review-log', [JSON.stringify(record), ...(token ? ['--finish', token] : [])]);
  return rows().at(-1)!;
}

function rows() {
  return cli('gstack-review-read').split('---CONFIG---')[0].trim().split('\n').map(line => JSON.parse(line));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'review-start-repo-'));
  home = mkdtempSync(join(tmpdir(), 'review-start-state-'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'source.ts'), 'export const value = 1;\n');
  git('add', 'source.ts');
  git('commit', '-qm', 'initial');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('review start/end binding (#2803)', () => {
  test('unchanged completed review is current, including an identical-content commit', () => {
    writeFileSync(join(repo, 'source.ts'), 'export const value = 2;\n');
    writeFileSync(join(repo, 'new.ts'), 'export {};\n');
    const token = cli('gstack-review-log', ['--start', 'review']);
    git('add', 'source.ts', 'new.ts');
    git('commit', '-qm', 'reviewed content');
    const row = log(token);
    expect(row.review_binding.state).toBe('verified');
    expect(row.review_binding.start_wtree).toBe(row.wtree);
    expect(row.review_binding.end_wtree).toBe(row.wtree);
    expect(row.review_binding.started_at).toMatch(/^\d{4}-/);
    expect(row.review_freshness.status).toBe('CURRENT');
    git('commit', '--amend', '--no-edit');
    expect(rows()[0].review_freshness.status).toBe('CURRENT');
  });

  for (const file of ['source.ts', 'untracked.ts']) {
    test(`mid-review ${file} edit is stale even at zero commit distance`, () => {
      const token = cli('gstack-review-log', ['--start', 'review']);
      writeFileSync(join(repo, file), 'export const unreviewed = true;\n');
      const row = log(token);
      expect(git('rev-list', '--count', `${row.commit}..HEAD`)).toBe('0');
      expect(row.wtree).toBeUndefined();
      expect(row.review_binding.state).toBe('changed');
      expect(row.review_binding.start_wtree).not.toBe(row.review_binding.end_wtree);
      expect(row.review_freshness.status).toBe('STALE');
    });
  }

  test('fix commits do not certify the final tree until a new unchanged pass', () => {
    const token = cli('gstack-review-log', ['--start', 'review']);
    writeFileSync(join(repo, 'source.ts'), 'export const fixed = true;\n');
    git('commit', '-qam', 'fix: review finding');
    expect(log(token, { cycles: 3, converged: false }).review_freshness.status).toBe('STALE');
    const rerun = cli('gstack-review-log', ['--start', 'review']);
    expect(log(rerun, { cycles: 3 }).review_freshness.status).toBe('CURRENT');
  });

  test('log-only forged binding cannot certify current content', () => {
    const wtree = cli('gstack-wtree');
    const row = log(undefined, {
      wtree, review_binding: { state: 'verified', start_wtree: wtree, end_wtree: wtree },
      review_freshness: { status: 'CURRENT' },
    });
    expect(row.wtree).toBeUndefined();
    expect(row.review_binding.state).toBe('uncaptured');
    expect(row.review_freshness.status).toBe('UNVERIFIED');
    expect(log(wtree).review_freshness.status).toBe('UNVERIFIED');
    expect(log('../forged').review_freshness.status).toBe('UNVERIFIED');
  });

  test('start receipt is single-use and scoped to the reviewer and branch', () => {
    const token = cli('gstack-review-log', ['--start', 'review']);
    expect(log(token).review_freshness.status).toBe('CURRENT');
    expect(log(token).review_freshness.status).toBe('UNVERIFIED');
    const wrongSkill = cli('gstack-review-log', ['--start', 'adversarial-review']);
    expect(log(wrongSkill).review_freshness.status).toBe('UNVERIFIED');
    const wrongBranch = cli('gstack-review-log', ['--start', 'review']);
    git('checkout', '-qb', 'other');
    expect(log(wrongBranch).review_freshness.status).toBe('UNVERIFIED');
  });

  for (const flags of [
    { completed: false }, { completed: undefined }, { converged: false }, { converged: undefined },
    { status: 'unavailable' }, { status: 'issues_found', critical: 7, issues_found: 51 },
    { critical: 7, issues_found: 51 },
  ]) {
    test(`incomplete, nonconverged or unresolved result is not current: ${JSON.stringify(flags)}`, () => {
      const token = cli('gstack-review-log', ['--start', 'review']);
      expect(log(token, flags).review_freshness.status).toBe('UNVERIFIED');
    });
  }

  test('post-log untracked edits invalidate a previously current review', () => {
    const token = cli('gstack-review-log', ['--start', 'review']);
    log(token);
    writeFileSync(join(repo, 'later.ts'), 'export {};\n');
    expect(rows()[0].review_freshness.status).toBe('STALE');
  });

  test('a Codex pass needs a genuine unchanged rerun after fixes', () => {
    const original = cli('gstack-review-log', ['--start', 'codex-review']);
    writeFileSync(join(repo, 'source.ts'), 'export const fixed = true;\n');
    expect(log(original, { skill: 'codex-review' }).review_freshness.status).toBe('STALE');
    const rerun = cli('gstack-review-log', ['--start', 'codex-review']);
    expect(log(rerun, { skill: 'codex-review' }).review_freshness.status).toBe('CURRENT');
  });

  for (const [findings, findings_fixed, freshness] of [
    [2, 0, 'UNVERIFIED'],
    [2, 1, 'UNVERIFIED'],
    [2, 2, 'CURRENT'],
    [0, 0, 'CURRENT'],
  ] as const) {
    test(`Codex gate pass with ${findings_fixed}/${findings} findings resolved grades ${freshness}`, () => {
      const token = cli('gstack-review-log', ['--start', 'codex-review']);
      const row = log(token, { skill: 'codex-review', status: 'clean', gate: 'pass', findings, findings_fixed });
      expect(row.review_binding.state).toBe('verified');
      expect(row.gate).toBe('pass');
      expect(row.review_freshness.status).toBe(freshness);
    });
  }

  test('legacy diff rows cannot use log-time wtree or HEAD; plan evidence is unchanged', () => {
    log(undefined, { skill: 'plan-eng-review', completed: undefined, converged: undefined });
    const file = findFilesBySuffix(home, '-reviews.jsonl')[0];
    const plan = JSON.parse(readFileSync(file, 'utf8').trim());
    const legacy = { ...plan, skill: 'review', review_freshness: { status: 'CURRENT' } };
    writeFileSync(file, [plan, legacy, { ...legacy, wtree: undefined }].map(r => JSON.stringify(r)).join('\n') + '\n');
    const read = rows();
    expect(read[0]).toEqual(plan);
    expect(read[0].wtree).toBe(cli('gstack-wtree'));
    expect(read[1].review_freshness.status).toBe('UNVERIFIED');
    expect(read[2].review_freshness.status).toBe('UNVERIFIED');
  });

  for (const skill of ['adversarial-review', 'codex-review', 'design-review-lite', 'ship']) {
    test(`${skill} cannot fall through to legacy plan handling`, () => {
      expect(log(undefined, { skill }).review_freshness.status).toBe('UNVERIFIED');
    });
  }

  test('ship metrics cannot impersonate a completed review pass', () => {
    const token = cli('gstack-review-log', ['--start', 'ship']);
    const row = log(token, { skill: 'ship' });
    expect(row.review_freshness.status).toBe('UNVERIFIED');
    expect(row.review_freshness.reason).toContain('telemetry');
  });
});
