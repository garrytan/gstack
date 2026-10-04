/**
 * W7 Claude overlay opt-in (`./setup --claude-model <id>`): nondefault installs, refresh and status.
 * Shared fixture and overlay helpers: test/helpers/claude-overlay-fixture.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { MARKER, failableBun, setup, config, defaultRender, record, served } from './helpers/claude-overlay-fixture';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put, registryRows, runSetup } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('nondefault installs, refresh and status', () => {
  test('a project install keeps its own per-install render: pinned, back to claude, failure keeps the previous render', () => {
    const f = makeFixture();
    failableBun(f);
    const project = join(f.home, 'proj');
    const vendored = makeSource(f, join(project, '.claude/skills/gstack'));
    const skills = join(project, '.claude/skills');
    const renderOf = () => registryRows(f).find(row => row[0] === 'claude')?.[8] ?? '';

    expect(setup(f, vendored, ['--claude-model', 'claude-opus-4-7'], project).status).toBe(0);
    const render = renderOf();
    expect(render).toContain('/render/installs/claude-');
    expect(record(render)).toMatchObject({ overlay: 'opus-4-7', source: 'explicit' });
    expect(served(skills)).toContain(MARKER);
    expect(served(skills)).toContain(`${vendored}/bin/gstack-skill-start`);

    expect(setup(f, vendored, ['--claude-model', 'claude'], project).status).toBe(0);
    expect(renderOf()).toBe(render);
    expect(record(render).overlay).toBe('claude');
    expect(served(skills)).not.toContain(MARKER);
    expect(served(skills)).toContain(`${vendored}/bin/gstack-skill-start`);

    put(join(f.home, 'fail-render'), '1');
    const failed = setup(f, vendored, ['--claude-model', 'claude-opus-4-8'], project);
    expect(failed.status, failed.out).toBe(0);
    expect(failed.out).toContain('the previous render stays in use');
    expect(served(skills)).toContain(`${vendored}/bin/gstack-skill-start`);
    expect(served(skills)).not.toContain(MARKER);
  }, 240_000);

  test('--refresh-registered persists the overlay before refreshing; later refreshes honor it with no flag', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    expect(setup(f, src).status).toBe(0);
    const refreshed = setup(f, src, ['--refresh-registered', '--claude-model', 'claude-opus-4-7']);
    expect(refreshed.status, refreshed.out).toBe(0);
    expect(config(f, src, 'get', 'claude_overlay_model').stdout).toBe('claude-opus-4-7');
    expect(record(defaultRender(f)).overlay).toBe('opus-4-7');

    const quiet = runSetup(f, join(src, 'setup'), ['-q', '--refresh-registered']);
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(record(defaultRender(f)).overlay).toBe('opus-4-7');
    expect(served(join(f.home, '.claude/skills'))).toContain(MARKER);
  }, 180_000);

  test('./setup --status reports the overlay without bun on PATH', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    expect(setup(f, src, ['--claude-model', 'claude-opus-4-7']).status).toBe(0);
    const noBunPath = '/usr/bin:/bin';
    expect(spawnSync('bash', ['-c', 'command -v bun'], { env: { ...f.env, PATH: noBunPath }, encoding: 'utf8', timeout: 10_000 }).status).not.toBe(0);
    const r = spawnSync('bash', [join(src, 'setup'), '--status'], { env: { ...f.env, PATH: noBunPath }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Claude skill overlay:');
    expect(r.stdout).toContain('~/.claude/skills: opus-4-7 (explicit: claude-opus-4-7, user render, gstack ');
  }, 120_000);
});
