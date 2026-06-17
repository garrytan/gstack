// Deterministic end-to-end coverage of the bin/gstack-merge CLI (arg parsing,
// file IO, and the lib/merge.ts wiring through the real binary). Free + fast —
// no claude -p, no network. The submit/wait/classify *logic* is unit-tested in
// gstack-merge.test.ts; this proves the executable plumbs it correctly and that
// the handoff contract (write → consume, with null/stale/foreign rejection)
// round-trips through the actual CLI surface /land and /land-and-deploy call.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dir, '..', 'bin', 'gstack-merge');

function runCli(args: string[], opts: { cwd?: string; home?: string } = {}) {
  const r = spawnSync('bun', [BIN, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.home ? { HOME: opts.home } : {}) },
    timeout: 30000,
  });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'gstack-merge-cli-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('gstack-merge CLI: detect', () => {
  test('an explicit "Merge queue: trunk" config wins (no git/gh needed)', () => {
    // A non-git temp dir: gh/git calls return nothing, so the config key is the
    // only signal — exactly the precedence /land relies on.
    writeFileSync(join(tmp, 'CLAUDE.md'), '# proj\n\n## Merge Configuration\n- Merge queue: trunk\n');
    const r = runCli(['detect', '--base', 'main', '--json'], { cwd: tmp });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.regime).toBe('trunk');
    expect(out.source).toBe('config');
  });

  test('config "Merge queue: github" is honored', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '## Merge Configuration\n- Merge queue: github\n');
    const r = runCli(['detect', '--base', 'main', '--json'], { cwd: tmp });
    expect(JSON.parse(r.stdout.trim()).regime).toBe('github');
  });

  test('no config + no signals → none', () => {
    const r = runCli(['detect', '--base', 'main', '--json'], { cwd: tmp });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).regime).toBe('none');
  });
});

describe('gstack-merge CLI: handoff round-trip (write → consume)', () => {
  const SLUG = 'acme-widget';
  const REPO = 'acme/widget';

  function seedHandoff(home: string, overrides: Record<string, unknown> = {}) {
    const dir = join(home, '.gstack', 'projects', SLUG);
    mkdirSync(dir, { recursive: true });
    const state = {
      schema_version: 1,
      pr: 42,
      sha: 'deadbeefcafe',
      headRefOid: 'cafef00d',
      base: 'main',
      head_branch: 'feat/x',
      repo: REPO,
      regime: 'trunk',
      ts: new Date().toISOString(),
      ...overrides,
    };
    writeFileSync(join(dir, 'last-land.json'), JSON.stringify(state, null, 2));
  }

  test('read-state accepts a matching recent handoff and emits the SHA', () => {
    seedHandoff(tmp);
    const r = runCli(['read-state', '--slug', SLUG, '--pr', '42', '--repo', REPO], { home: tmp });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('LAND_SHA=deadbeefcafe');
    expect(r.stdout).toContain('LAND_REGIME=trunk');
  });

  test('read-state rejects a handoff for a different PR (no cross-PR deploy)', () => {
    seedHandoff(tmp);
    const r = runCli(['read-state', '--slug', SLUG, '--pr', '99', '--repo', REPO], { home: tmp });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('READ_STATE_INVALID');
  });

  test('read-state rejects a handoff for a different repo', () => {
    seedHandoff(tmp);
    const r = runCli(['read-state', '--slug', SLUG, '--pr', '42', '--repo', 'other/repo'], { home: tmp });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('READ_STATE_INVALID');
  });

  test('read-state rejects a stale handoff', () => {
    seedHandoff(tmp, { ts: '2020-01-01T00:00:00.000Z' });
    const r = runCli(['read-state', '--slug', SLUG, '--pr', '42', '--repo', REPO], { home: tmp });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('READ_STATE_INVALID');
  });

  test('read-state rejects a handoff with an empty SHA (the null-SHA STOP)', () => {
    seedHandoff(tmp, { sha: '' });
    const r = runCli(['read-state', '--slug', SLUG, '--pr', '42', '--repo', REPO], { home: tmp });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('READ_STATE_INVALID');
  });

  test('read-state reports missing when there is no handoff at all', () => {
    const r = runCli(['read-state', '--slug', 'nope', '--pr', '1', '--repo', REPO], { home: tmp });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('READ_STATE_INVALID');
  });
});

describe('gstack-merge CLI: argument handling', () => {
  test('unknown subcommand exits 2 with usage', () => {
    const r = runCli(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage: gstack-merge');
  });

  test('submit without --pr exits 2', () => {
    const r = runCli(['submit', '--regime', 'none']);
    expect(r.code).toBe(2);
  });
});
