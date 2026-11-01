/**
 * Split from test/setup-codex-scope-namespaces.test.ts so the free-suite packer can balance it (60 s seed ceiling): supported generation-namespace and generated-skill leaf aliases.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, fixtureWriteFileSync, fixtureMkdirSync, fixtureUtimesSync, tree, fixture, install } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('setup Codex destination follows recognized source scope', () => {
  for (const level of ['agents', 'skills']) for (const preexisting of [false, true]) for (const windows of [false, true]) test(`internal generation namespace alias remains supported: ${level}, preexisting=${preexisting}, Windows=${windows}`, () => {
    const f = fixture('.claude');
    const internal = join(f.source, 'generated-codex');
    fixtureMkdirSync(internal);
    if (level === 'agents') symlinkSync(internal, join(f.source, '.agents'), 'dir');
    else {
      fixtureMkdirSync(join(f.source, '.agents'));
      symlinkSync(internal, join(f.source, '.agents/skills'), 'dir');
    }
    const generated = join(f.source, '.agents/skills');
    if (preexisting) {
      fixtureMkdirSync(join(generated, 'gstack-review'), { recursive: true });
      fixtureWriteFileSync(join(generated, 'gstack-review/SKILL.md'), 'Prior internal render.\n');
    }
    if (windows) {
      fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
      for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
        fixtureWriteFileSync(join(f.source, rel), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fixtureUtimesSync(join(f.source, rel), new Date('2040-01-01'), new Date('2040-01-01'));
      }
    }
    fixtureWriteFileSync(join(f.source, 'uncommitted-work'), 'Preserve source edits.\n');
    const excluded = tree(f.global), sibling = tree(f.other);
    const sourceBefore = Object.fromEntries(['SKILL.md', 'bin', 'lib', 'uncommitted-work'].map(rel => [rel, tree(join(f.source, rel))]));
    for (let run = 0; run < 2; run++) {
      install(f);
      expect(tree(f.global)).toEqual(excluded);
      expect(tree(f.other)).toEqual(sibling);
      for (const [rel, before] of Object.entries(sourceBefore)) expect(tree(join(f.source, rel))).toEqual(before);
      expect(readFileSync(join(f.project, '.agents/skills/gstack-review/SKILL.md'))).toEqual(readFileSync(join(generated, 'gstack-review/SKILL.md')));
      expect(existsSync(join(f.source, 'bin/bin'))).toBe(false);
    }
  }, 90_000);

  for (const windows of [false, true]) test(`individual generated skill leaf alias remains supported, Windows=${windows}`, () => {
    const f = fixture('.claude');
    const rendered = join(f.source, '.agents/skills/gstack-review');
    const local = join(f.project, '.agents/skills');
    fixtureMkdirSync(rendered, { recursive: true });
    fixtureMkdirSync(local, { recursive: true });
    fixtureWriteFileSync(join(rendered, 'user-notes'), 'Keep notes beside the source render.\n');
    symlinkSync(rendered, join(local, 'gstack-review'), 'dir');
    if (windows) {
      fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n', { mode: 0o755 });
      for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
        fixtureWriteFileSync(join(f.source, rel), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fixtureUtimesSync(join(f.source, rel), new Date('2040-01-01'), new Date('2040-01-01'));
      }
    }
    const excluded = tree(f.global);
    for (let run = 0; run < 2; run++) {
      install(f);
      expect(tree(f.global)).toEqual(excluded);
      expect(readFileSync(join(rendered, 'user-notes'), 'utf8')).toBe('Keep notes beside the source render.\n');
      expect(readFileSync(join(local, 'gstack-review/SKILL.md'))).toEqual(readFileSync(join(rendered, 'SKILL.md')));
    }
  }, 90_000);
});
