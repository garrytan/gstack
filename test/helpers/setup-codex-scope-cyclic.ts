import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'bun:test';
import { fixtureWriteFileSync, fixtureMkdirSync, tree, fixture, install } from './install-fixture';

/** F13: a Claude-only setup run twice leaves a cyclic foreign ownership link at `target` and the rest of the global tree untouched. */
export function claudeOnlySetupPreservesCyclicLink(target: string): void {
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
}
