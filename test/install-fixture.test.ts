/**
 * ENG-1 tripwire for test/helpers/install-fixture.ts: every fixture checkout
 * is a clone of one read-only seed, never a hard link, so a write in one
 * test's checkout cannot reach the seed or a sibling fixture.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, fixture, fixtureWriteFileSync, makeFixture, makeSource, put, seedSource, setVersion, tree } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const PROBED = ['setup', 'VERSION', 'SKILL.md', 'bin/gstack-config', 'bin/gstack-gbrain-detect', 'browse/dist/browse'];
const modes = (dir: string) => PROBED.map(rel => statSync(join(dir, rel)).mode & 0o7777);

describe.skipIf(process.platform === 'win32')('install fixture isolation (ENG-1)', () => {
  test('put, setVersion and chmod in one clone leave the seed and a sibling clone unchanged', () => {
    const seed = seedSource();
    const seedBefore = tree(seed);
    const seedModes = modes(seed);
    const f = makeFixture();
    const written = makeSource(f, join(f.dir, 'written'));
    const sibling = makeSource(f, join(f.dir, 'sibling'));
    const siblingBefore = tree(sibling);
    const siblingModes = modes(sibling);

    put(join(written, 'bin/gstack-gbrain-detect'), '#!/bin/sh\nexit 1\n', 0o755);
    put(join(written, 'SKILL.md'), 'rewritten in place\n');
    setVersion(written, '9.9.9.9');
    chmodSync(join(written, 'setup'), 0o700);
    chmodSync(join(written, 'bin/gstack-config'), 0o600);
    const codex = fixture('.claude');
    fixtureWriteFileSync(join(codex.source, 'VERSION'), '0.0.0.1\n');

    expect(readFileSync(join(written, 'VERSION'), 'utf8')).toBe('9.9.9.9\n');
    expect(readFileSync(join(written, 'SKILL.md'), 'utf8')).toBe('rewritten in place\n');
    expect(statSync(join(written, 'setup')).mode & 0o777).toBe(0o700);
    expect(tree(seed)).toEqual(seedBefore);
    expect(modes(seed)).toEqual(seedModes);
    expect(tree(sibling)).toEqual(siblingBefore);
    expect(modes(sibling)).toEqual(siblingModes);
  });

  test('the seed is read-only and clones are writable files with their own inodes', () => {
    const seed = seedSource();
    const f = makeFixture();
    const clone = makeSource(f, join(f.dir, 'clone'));
    expect(statSync(seed).mode & 0o222).toBe(0);
    for (const rel of PROBED) {
      const original = statSync(join(seed, rel));
      const copy = statSync(join(clone, rel));
      expect(original.mode & 0o222).toBe(0);
      expect(copy.ino).not.toBe(original.ino);
      expect(copy.nlink).toBe(1);
      expect(copy.mode & 0o200).toBe(0o200);
    }
  });
});
