/**
 * W7 Claude overlay opt-in (`./setup --claude-model <id>`): a project install keeps its own per-install render. Split from test/claude-overlay-setup-installs.test.ts so the free-suite packer can balance it (60 s seed ceiling). Shared fixture and overlay helpers: test/helpers/claude-overlay-fixture.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { MARKER, failableBun, setup, record, served } from './helpers/claude-overlay-fixture';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put, registryRows } from './helpers/install-fixture';

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
});
