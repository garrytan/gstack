/**
 * #1694 host-render prune: two installs sharing one state root each keep only their own hosts.
 * Split from test/host-renders-prune.test.ts so the free-suite packer can balance it (60 s seed ceiling).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource } from './helpers/install-fixture';
import { OTHER_DIRS, backups, legacyRender, setupOk, skillFiles } from './helpers/host-renders-prune-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('setup prunes unrecorded host renders without losing a file (#1694)', () => {
  test('two installs sharing one state root each end with only their own hosts', async () => {
    const f = makeFixture();
    const a = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    const b = makeSource(f, path.join(f.home, 'src-b/gstack'));
    await legacyRender(a);
    await legacyRender(b);
    setupOk(f, a);
    setupOk(f, b, ['--host', 'codex']);
    for (const dir of OTHER_DIRS) expect(fs.existsSync(path.join(a, dir)), `a ${dir}`).toBe(false);
    expect(skillFiles(path.join(b, '.agents')).length).toBeGreaterThan(40);
    for (const dir of OTHER_DIRS.filter(d => d !== '.agents')) expect(fs.existsSync(path.join(b, dir)), `b ${dir}`).toBe(false);
    expect(backups(f)).toHaveLength(2);
  }, 240_000);
});
