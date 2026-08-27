import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('/ship release-metadata separation', () => {
  const skeleton = read('ship/SKILL.md.tmpl');
  const manifest = JSON.parse(read('ship/sections/manifest.json')) as {
    sections: Array<{ id: string; file: string }>;
  };
  const sectionSources = manifest.sections
    .map(({ file }) => read(`ship/sections/${file}.tmpl`))
    .join('\n');
  const shipSource = `${skeleton}\n${sectionSources}`;

  test('ordinary shipping never allocates or writes a release version', () => {
    expect(shipSource).not.toContain('gstack-version-bump');
    expect(shipSource).not.toContain('gstack-next-version');
    expect(shipSource).not.toContain('BUMP_LEVEL');
    expect(shipSource).not.toContain('NEW_VERSION');
    expect(shipSource).not.toContain('"version":"VERSION"');
    expect(skeleton).toContain('ordinary repository shipping never modifies');
  });

  test('ordinary shipping skips CHANGELOG generation', () => {
    expect(manifest.sections.some(({ id }) => id === 'changelog')).toBe(false);
    expect(skeleton).not.toContain('{{SECTION:changelog}}');
    expect(existsSync(join(ROOT, 'ship/sections/changelog.md.tmpl'))).toBe(false);
    expect(shipSource).not.toContain('CHANGELOG (auto-generate)');
  });

  test('PRs use conventional titles and are ready for review', () => {
    const prBody = read('ship/sections/pr-body.md.tmpl');
    expect(shipSource).toContain('feat: add keeper league settings');
    expect(prBody).toContain('--title "$NEW_TITLE"');
    expect(prBody).not.toContain('v$NEW_VERSION');
    expect(prBody.toLowerCase()).toContain('ready for review');
  });

  test('TODO completion and metrics contain no release metadata', () => {
    expect(skeleton).toContain('**Completed:** YYYY-MM-DD');
    expect(skeleton).not.toContain('**Completed in:**');
    expect(skeleton).not.toContain('"version":"VERSION"');
  });

  test('documentation handoff uses the docs-only mode', () => {
    const prBody = read('ship/sections/pr-body.md.tmpl');
    const documentRelease = read('document-release/SKILL.md.tmpl');
    expect(prBody).toContain('ordinary-ship-docs-only');
    expect(documentRelease).toContain('never change `VERSION`, `CHANGELOG.md`');
  });

  test('reusable explicit release utilities remain available', () => {
    expect(existsSync(join(ROOT, 'bin/gstack-next-version'))).toBe(true);
    expect(existsSync(join(ROOT, 'bin/gstack-version-bump'))).toBe(true);
    expect(existsSync(join(ROOT, 'bin/gstack-pr-title-rewrite.sh'))).toBe(true);
  });
});
