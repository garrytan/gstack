import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const digest = (file: string) => new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');
describe('deterministic authority bundles', () => {
  test('rebuild is byte-identical and complete', () => {
    const script = path.join(root, 'scripts/build-authority-bundles.ts');
    expect(Bun.spawnSync(['bun', 'run', script], { timeout: 30_000, cwd: root }).exitCode).toBe(0);
    const first = digest(path.join(root, 'dist/authority/manifest.json'));
    expect(Bun.spawnSync(['bun', 'run', script], { timeout: 30_000, cwd: root }).exitCode).toBe(0);
    expect(digest(path.join(root, 'dist/authority/manifest.json'))).toBe(first);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/authority/manifest.json'), 'utf8'));
    expect(Object.keys(manifest.commands)).toEqual([
      'gstack-candidate-preview',
      'gstack-counterpart-proof',
      'gstack-effect-scope',
      'gstack-execution-plan',
      'gstack-lane-canary',
      'gstack-next-version',
      'gstack-pr-checks',
      'gstack-pr-head-guard',
      'gstack-pr-title-rewrite',
      'gstack-project-identity',
      'gstack-review-read',
      'gstack-section-delivery',
      'gstack-semantic-manifest',
      'gstack-ship-handoff',
      'gstack-validator-runtime',
      'gstack-version-bump',
      'gstack-work-profile',
    ]);
    expect(manifest.commands['gstack-project-identity'].entrypoint).toBe('scripts/authority/project-identity.ts');
    expect(manifest.commands['gstack-section-delivery'].entrypoint).toBe('scripts/authority/section-delivery.ts');
    expect(manifest.commands['gstack-ship-handoff'].entrypoint).toBe('scripts/authority/ship-handoff.ts');
    expect(manifest.commands['gstack-work-profile'].entrypoint).toBe('scripts/authority/work-profile.ts');
    expect(manifest.commands['gstack-semantic-manifest'].entrypoint).toBe('scripts/authority/semantic-manifest.ts');
    expect(manifest.commands['gstack-execution-plan'].entrypoint).toBe('scripts/authority/execution-plan.ts');
    expect(manifest.commands['gstack-lane-canary'].entrypoint).toBe('scripts/authority/lane-canary.ts');
    expect(manifest.commands['gstack-validator-runtime'].entrypoint).toBe('scripts/authority/validator-runtime.ts');
    expect(manifest.commands['gstack-review-read'].entrypoint).toBe('scripts/authority/review-read.ts');
    expect(manifest.commands['gstack-counterpart-proof'].entrypoint).toBe('scripts/authority/counterpart-proof.ts');
    expect(manifest.commands['gstack-candidate-preview'].entrypoint).toBe('scripts/authority/candidate-preview.ts');
    expect(manifest.commands['gstack-next-version'].entrypoint).toBe('bin/gstack-next-version');
    const nextVersionBundle = fs.readFileSync(
      path.join(root, manifest.commands['gstack-next-version'].output),
      'utf8',
    );
    expect(nextVersionBundle).not.toContain(path.join(root, 'bin'));
    expect(nextVersionBundle).toContain('import.meta.dir');
    expect(manifest.commands['gstack-version-bump'].entrypoint).toBe('bin/gstack-version-bump');
    expect(manifest.commands['gstack-pr-title-rewrite'].entrypoint).toBe('bin/gstack-pr-title-rewrite');
    expect(Object.keys(manifest.commands)).toEqual([...Object.keys(manifest.commands)].sort());
    for (const entry of Object.values(manifest.commands) as any[]) expect(digest(path.join(root, entry.output))).toBe(entry.sha256);
  });
});
