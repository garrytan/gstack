/**
 * ./setup --loadout through the real ./setup on a default Claude install
 * (GSTA-161, PR 1b). A non-full loadout is saved as claude_loadout and served
 * from the untracked Claude render dir by setup's own gen:skill-docs render
 * (the plan-mode-preamble path), so the checkout stays full. An explicit
 * loadout is bound to no model, so its start lines carry no re-read rule. --loadout full serves the committed files again; an unknown name
 * changes nothing. Fixture: test/helpers/install-fixture.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, defaultRender, failableBun, fakeDetect, record, served, setup } from './helpers/claude-overlay-fixture';
import { ROOT, cleanupFixtures, cleanupSeed, makeFixture, makeSource } from './helpers/install-fixture';
import { readSkillStartup } from './helpers/skill-startup';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const VOICE = '## Voice';

describe.skipIf(process.platform === 'win32')('./setup --loadout', () => {
  test('lite renders the default install without the coaching pieces and keeps the checkout full; full serves the committed files; an unknown name changes nothing', () => {
    const f = makeFixture();
    failableBun(f);
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    fakeDetect(src);
    const skills = join(f.home, '.claude/skills');
    const committed = readSkillStartup(join(ROOT, 'autoplan/SKILL.md'));
    expect(committed).toContain(VOICE);

    const lite = setup(f, src, ['--loadout', 'lite']);
    expect(lite.status, lite.out).toBe(0);
    expect(lite.out).toContain('and the lite loadout');
    expect(config(f, src, 'get', 'claude_loadout').stdout.trim()).toBe('lite');
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'claude', render: 'user', loadout: 'lite' });
    const startup = served(skills);
    expect(startup).not.toContain(VOICE);
    expect(startup).toContain('--skill "autoplan" --model "claude"\n');
    expect(startup).not.toContain('--loadout');
    expect(readSkillStartup(join(src, 'autoplan/SKILL.md'))).toBe(committed);

    const again = setup(f, src);
    expect(again.status, again.out).toBe(0);
    expect(served(skills)).not.toContain(VOICE);

    const unknown = setup(f, src, ['--loadout', 'nope']);
    expect(unknown.status).toBe(1);
    expect(unknown.out).toContain('Nothing was installed or changed');
    expect(config(f, src, 'get', 'claude_loadout').stdout.trim()).toBe('lite');

    const full = setup(f, src, ['--loadout', 'full']);
    expect(full.status, full.out).toBe(0);
    expect(config(f, src, 'get', 'claude_loadout').stdout.trim()).toBe('full');
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(served(skills)).toBe(committed);
    expect(readFileSync(join(src, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(ROOT, 'SKILL.md'), 'utf8'));
  }, 300_000);

  test('gstack-config refuses a claude_loadout that is not a loadout name and stores full', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const bad = config(f, src, 'set', 'claude_loadout', 'Bad Name');
    expect(bad.stderr).toContain('claude_loadout must be a loadout name');
    expect(config(f, src, 'get', 'claude_loadout').stdout.trim()).toBe('full');
  });
});
