/**
 * W7 Claude overlay opt-in (`./setup --claude-model <id>`): a failed render and an upgrade keep a valid render, and concurrent refreshes leave one. Split from test/claude-overlay-setup-lifecycle.test.ts so the free-suite packer can balance it (60 s seed ceiling). Shared fixture and overlay helpers: test/helpers/claude-overlay-fixture.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER, failableBun, fakeDetect, setup, config, defaultRender, record, served } from './helpers/claude-overlay-fixture';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put, setVersion } from './helpers/install-fixture';
import { readSkillStartup } from './helpers/skill-startup';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('overlay render lifecycle with gbrain and failures', () => {
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
    expect(served(skills)).toBe(readSkillStartup(join(src, 'autoplan/SKILL.md')));
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
    expect(readSkillStartup(join(defaultRender(f), 'autoplan/SKILL.md'))).toContain(MARKER);
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'opus-4-7', gbrain: 'ok' });
  }, 240_000);
});
