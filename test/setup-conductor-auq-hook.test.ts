/**
 * Q3 (#2207, #2208): in a Conductor workspace the PreToolUse question-
 * preference hook breaks Conductor's native AskUserQuestion round-trip even
 * when it only defers. setup no longer auto-installs it there, removes one an
 * earlier setup added (keeping the other plan-tune hooks), and still honors
 * an explicit opt-in. Real ./setup into a temp HOME (test/helpers/install-fixture).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupFixtures, makeFixture, makeSource, type Fixture } from './helpers/install-fixture';

afterEach(cleanupFixtures);

function setup(f: Fixture, src: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(src, 'setup'), ...args], { cwd: f.home, env: { ...f.env, ...env }, encoding: 'utf8', timeout: 60_000, input: '' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return r.stdout + r.stderr;
}

function items(f: Fixture, src: string, event: string): string {
  const r = spawnSync('bash', [join(src, 'bin/gstack-settings-hook'), 'list-items', '--event', event, '--owned-by', 'plan-tune-cathedral'],
    { env: f.env, encoding: 'utf8', timeout: 30_000 });
  return r.stdout.trim();
}

const CONDUCTOR = { CONDUCTOR_WORKSPACE_PATH: '/tmp/conductor/workspaces/demo' };

describe.skipIf(process.platform === 'win32')('setup: Conductor and the AskUserQuestion preference hook (Q3)', () => {
  test('a Conductor setup with no explicit choice does not install it', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    setup(f, src, [], CONDUCTOR);
    expect(items(f, src, 'PreToolUse')).toBe('');
  }, 90_000);

  test('a Conductor setup removes one an earlier setup added and keeps the other plan-tune hooks', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    setup(f, src, ['--plan-tune-hooks']);
    expect(items(f, src, 'PreToolUse')).toContain('question-preference-hook');
    const out = setup(f, src, [], CONDUCTOR);
    expect(out).toContain("removed the AskUserQuestion preference hook: it breaks Conductor's native AskUserQuestion");
    expect(out).toContain('Keep it anyway: gstack-config set plan_tune_hooks yes, then ./setup');
    expect(items(f, src, 'PreToolUse')).toBe('');
    expect(items(f, src, 'PostToolUse')).toContain('question-log-hook');
    // A later run neither re-adds it nor repeats the notice.
    expect(setup(f, src, [], CONDUCTOR)).not.toContain('removed the AskUserQuestion preference hook');
    expect(items(f, src, 'PreToolUse')).toBe('');
  }, 120_000);

  test('an explicit opt-in in Conductor still installs it', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    setup(f, src, [], { ...CONDUCTOR, GSTACK_PLAN_TUNE_HOOKS: 'yes' });
    expect(items(f, src, 'PreToolUse')).toContain('question-preference-hook');
  }, 90_000);
});
