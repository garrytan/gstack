/**
 * W7 Claude overlay opt-in (`./setup --claude-model <id>`): the overlay render lifecycle with gbrain and failures.
 * Shared fixture and overlay helpers: test/helpers/claude-overlay-fixture.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER, fakeDetect, setup, config, defaultRender, record, served } from './helpers/claude-overlay-fixture';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put } from './helpers/install-fixture';
import { readSkillStartup } from './helpers/skill-startup';

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
    expect(served(join(f.home, '.claude/skills'))).toBe(readSkillStartup(join(src, 'autoplan/SKILL.md')));
  }, 180_000);
});
