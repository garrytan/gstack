import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildChangeManifest } from '../lib/change-manifest';
import { parseWorkProfile } from '../lib/work-profile';

const roots: string[] = [];
const git = (cwd: string, args: string[]) => { const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); };
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'change-manifest-')); roots.push(root); git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Test']); git(root, ['config', 'user.email', 'test@example.com']);
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/base.ts'), 'export const base = 1;\n'); writeFileSync(join(root, 'package.json'), '{"version":"1.0.0","scripts":{"test":"bun test"}}\n'); git(root, ['add', '.']); git(root, ['commit', '-m', 'base']); git(root, ['switch', '-c', 'feature']); return root;
}
const profile = () => parseWorkProfile(readFileSync(join(import.meta.dir, 'fixtures/work-profile/valid.yaml'), 'utf8'));
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('semantic change manifest', () => {
  test('unions committed, staged, unstaged, and untracked changes with multi-role classification', () => {
    const cwd = makeRepo(); const base = git(cwd, ['rev-parse', 'main']);
    writeFileSync(join(cwd, 'src/committed.ts'), 'export {};\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'committed']);
    writeFileSync(join(cwd, 'src/staged.ts'), 'export {};\n'); git(cwd, ['add', 'src/staged.ts']);
    writeFileSync(join(cwd, 'src/base.ts'), 'export const base = 2;\n');
    writeFileSync(join(cwd, 'mystery.asset'), 'x\n');
    const manifest = buildChangeManifest({ cwd, profile: profile(), targetBaseRef: 'origin/main', targetBaseSha: base, mergeBaseSha: base });
    expect(manifest.changed.map((item) => [item.path, item.source])).toEqual([
      ['mystery.asset', 'untracked'], ['src/base.ts', 'unstaged'], ['src/committed.ts', 'committed'], ['src/staged.ts', 'staged'],
    ]);
    expect(manifest.fallback_paths).toEqual(['mystery.asset']); expect(manifest.roles).toEqual(['code', 'runtime']); expect(manifest.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('requires a literal semantic declaration for a new coarse docs path', () => {
    const cwd = makeRepo(); const base = git(cwd, ['rev-parse', 'main']); mkdirSync(join(cwd, 'docs')); writeFileSync(join(cwd, 'docs/new.md'), '# new\n');
    const withoutProse = parseWorkProfile(readFileSync(join(import.meta.dir, 'fixtures/work-profile/valid.yaml'), 'utf8').replace('prose_only_surfaces: [docs/**]\n', ''));
    const manifest = buildChangeManifest({ cwd, profile: withoutProse, targetBaseSha: base, mergeBaseSha: base });
    expect(manifest.classification_state).toBe('semantic_declaration_required'); expect(manifest.declaration_required_paths).toEqual(['docs/new.md']);
  });

  test('package version-only changes stay release metadata while script changes add runtime', () => {
    const cwd = makeRepo(); const base = git(cwd, ['rev-parse', 'main']);
    writeFileSync(join(cwd, 'package.json'), '{"version":"1.0.1","scripts":{"test":"bun test"}}\n');
    expect(buildChangeManifest({ cwd, profile: profile(), targetBaseSha: base, mergeBaseSha: base }).changed[0].roles).toEqual(['release_metadata']);
    writeFileSync(join(cwd, 'package.json'), '{"version":"1.0.1","scripts":{"test":"bun test","build":"bun build"}}\n');
    expect(buildChangeManifest({ cwd, profile: profile(), targetBaseSha: base, mergeBaseSha: base }).changed[0].roles).toEqual(['release_metadata', 'runtime']);
  });

  test('binds the manifest to changed bytes, not only changed path names', () => {
    const cwd = makeRepo(); const base = git(cwd, ['rev-parse', 'main']);
    writeFileSync(join(cwd, 'src/base.ts'), 'export const base = 2;\n');
    const first = buildChangeManifest({ cwd, profile: profile(), targetBaseSha: base, mergeBaseSha: base });
    writeFileSync(join(cwd, 'src/base.ts'), 'export const base = 3;\n');
    const second = buildChangeManifest({ cwd, profile: profile(), targetBaseSha: base, mergeBaseSha: base });
    expect(first.wtree).not.toBe(second.wtree); expect(first.manifest_hash).not.toBe(second.manifest_hash);
  });
});
