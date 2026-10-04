/**
 * W7 Claude overlay opt-in (`./setup --claude-model <id>`): the overlay render lifecycle with gbrain and failures.
 * Shared fixture and overlay helpers: test/helpers/claude-overlay-fixture.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER, failableBun, fakeDetect, setup, config, defaultRender, record, served } from './helpers/claude-overlay-fixture';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put, setVersion } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('overlay render lifecycle with gbrain and failures', () => {
  test('gbrain present → absent keeps a pinned overlay; a failed detector still renders it', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    fakeDetect(src);
    const skills = join(f.home, '.claude/skills');

    put(join(f.home, 'gbrain-mode'), 'ok');
    expect(setup(f, src, ['--claude-model', 'claude-opus-4-8']).status).toBe(0);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-8', gbrain: 'ok' });
    expect(served(skills)).toContain(MARKER);

    put(join(f.home, 'gbrain-mode'), 'absent');
    const refresh = config(f, src, 'gbrain-refresh');
    expect(refresh.status, refresh.stdout + refresh.stderr).toBe(0);
    expect(refresh.stdout).toContain('gbrain not detected');
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-8', gbrain: 'absent' });
    expect(served(skills)).toContain(MARKER);

    put(join(f.home, 'gbrain-mode'), 'fail');
    const failed = setup(f, src);
    expect(failed.status, failed.out).toBe(0);
    expect(failed.out).toContain('gstack-gbrain-detect failed');
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-8', gbrain: 'unknown' });
    expect(served(skills)).toContain(MARKER);
  }, 240_000);

  test('gbrain present → absent with the default overlay drops the brain render', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    fakeDetect(src);
    expect(setup(f, src).status).toBe(0);
    put(join(f.home, 'gbrain-mode'), 'ok');
    expect(config(f, src, 'gbrain-refresh').status).toBe(0);
    expect(existsSync(join(defaultRender(f), 'autoplan/SKILL.md'))).toBe(true);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'claude', source: 'default', gbrain: 'ok' });

    put(join(f.home, 'gbrain-mode'), 'absent');
    const r = config(f, src, 'gbrain-refresh');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(existsSync(`${defaultRender(f)}.overlay`)).toBe(false);
    expect(served(join(f.home, '.claude/skills'))).toBe(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8'));
  }, 180_000);

  test('a failed render keeps the previous render; after an upgrade it serves the committed files', () => {
    const f = makeFixture();
    failableBun(f);
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const skills = join(f.home, '.claude/skills');
    expect(setup(f, src, ['--claude-model', 'claude-sonnet-5']).status).toBe(0);
    expect(record(defaultRender(f)).overlay).toBe('sonnet-5');

    put(join(f.home, 'fail-render'), '1');
    const kept = setup(f, src);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.out).toContain('the previous render (sonnet-5 overlay) stays in use');
    expect(existsSync(join(defaultRender(f), 'autoplan/SKILL.md'))).toBe(true);

    setVersion(src, '9.9.9.9');
    const upgraded = setup(f, src);
    expect(upgraded.status, upgraded.out).toBe(0);
    expect(upgraded.out).toContain('the committed claude render is served');
    expect(upgraded.out).toContain('Claude skill overlay: claude (was sonnet-5).');
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'claude', source: 'explicit', render: 'committed', version: '9.9.9.9' });
    expect(served(skills)).toBe(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8'));
  }, 240_000);

  test('concurrent gbrain-refresh runs leave one valid render and no temp, old or lock dirs', async () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    fakeDetect(src);
    expect(setup(f, src, ['--claude-model', 'claude-opus-4-7']).status).toBe(0);
    put(join(f.home, 'gbrain-mode'), 'ok');
    const run = () => new Promise<{ code: number | null; err: string }>(resolve => {
      const child = spawn('bash', [join(src, 'bin/gstack-config'), 'gbrain-refresh'], { env: f.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('exit', code => resolve({ code, err }));
    });
    const runs = await Promise.all([run(), run(), run()]);
    expect(runs).toEqual([{ code: 0, err: '' }, { code: 0, err: '' }, { code: 0, err: '' }]);
    const renderParent = join(f.home, '.gstack/render');
    expect(readdirSync(renderParent).sort()).toEqual(['claude', 'claude.overlay']);
    expect(readdirSync(defaultRender(f)).filter(name => name.startsWith('claude'))).toEqual([]);
    expect(readFileSync(join(defaultRender(f), 'autoplan/SKILL.md'), 'utf8')).toContain(MARKER);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-7', gbrain: 'ok' });
  }, 240_000);
});
