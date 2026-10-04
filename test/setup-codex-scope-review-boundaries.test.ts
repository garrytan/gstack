import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, fixtureWriteFileSync, fixtureCopyFileSync, fixtureMkdirSync, fixtureUtimesSync, tree, fixture, install } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('F13 independent review boundaries', () => {
  for (const target of ['legacy', 'replacement', 'legacy-skill', 'runtime', 'runtime-bin', 'runtime-lib']) {
    test(`Claude-only setup preserves cyclic foreign ownership link: ${target}`, () => {
      const f = fixture('ordinary');
      rmSync(join(f.global, 'gstack-retired'));
      for (const rel of ['bin', 'lib']) {
        const asset = join(f.global, 'gstack', rel);
        rmSync(asset);
        symlinkSync(join(f.source, rel), asset, 'dir');
      }
      const old = join(f.global, 'gstack-claude');
      rmSync(old, { recursive: true });
      const oldRender = join(f.source, '.agents/skills/gstack-claude');
      fixtureMkdirSync(oldRender, { recursive: true });
      fixtureWriteFileSync(join(oldRender, 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl -->\n<!-- Regenerate: bun run gen:skill-docs -->\nPrior legacy render.\n');
      symlinkSync(oldRender, old, 'dir');
      const link = target === 'legacy' ? old
        : target === 'replacement' ? join(f.global, 'gstack-claude-code')
        : target === 'legacy-skill' ? join(old, 'SKILL.md')
        : target === 'runtime' ? join(f.global, 'gstack')
        : join(f.global, 'gstack', target === 'runtime-bin' ? 'bin' : 'lib');
      if (target === 'legacy-skill') {
        rmSync(old);
        fixtureMkdirSync(old);
      }
      if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { recursive: true });
      symlinkSync(link, link);
      const before = tree(f.global);
      for (let run = 0; run < 2; run++) {
        install(f, '--host claude');
        expect(tree(f.global)).toEqual(before);
      }
    }, 90_000);
  }

  for (const alias of [false, true]) for (const windows of [false, true]) {
    test(`global generation namespace is refused before mutation: alias=${alias}, Windows=${windows}`, () => {
      const f = fixture('ordinary');
      const agents = join(f.source, '.agents');
      fixtureMkdirSync(agents, { recursive: true });
      const codexHome = alias ? join(f.home, 'generation-alias') : agents;
      if (alias) symlinkSync(agents, codexHome, 'dir');
      if (windows) {
        fixtureWriteFileSync(join(f.dir, 'commands/uname'), '#!/bin/sh\nprintf "MINGW64_NT-10.0\n"\n', { mode: 0o755 });
        for (const rel of ['browse/dist/browse.exe', 'design/dist/design.exe', 'make-pdf/dist/pdf.exe']) {
          fixtureCopyFileSync(join(f.source, rel.replace('.exe', '')), join(f.source, rel));
          fixtureUtimesSync(join(f.source, rel), new Date('2040-01-01'), new Date('2040-01-01'));
        }
      }
      const before = tree(f.dir);
      for (let run = 0; run < 2; run++) {
        const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
          cwd: f.other, env: { ...f.env, CODEX_HOME: codexHome }, encoding: 'utf8', timeout: 60_000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain('host namespace');
        expect(tree(f.dir)).toEqual(before);
      }
    }, 90_000);
  }

  for (const leaf of ['SKILL.md', 'agents']) {
    test(`selected generated cyclic write remains fail-closed: ${leaf}`, () => {
      const f = fixture('ordinary');
      const generated = join(f.source, '.agents/skills/gstack-review');
      fixtureMkdirSync(generated, { recursive: true });
      const link = join(generated, leaf);
      symlinkSync(link, link);
      const before = tree(f.dir);
      for (let run = 0; run < 2; run++) {
        const result = spawnSync('bash', [join(f.source, 'setup'), '--host', 'codex', '--no-team', '--no-plan-tune-hooks', '--no-timeline-stop-hook'], {
          cwd: f.other, env: f.env, encoding: 'utf8', timeout: 60_000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain('ELOOP');
        expect(tree(f.dir)).toEqual(before);
      }
    }, 90_000);
  }

});
