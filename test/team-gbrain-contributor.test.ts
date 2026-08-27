import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { generateBrainSyncBlock } from '../scripts/resolvers/preamble/generate-brain-sync-block';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = join(import.meta.dir, '..');

describe('shared GBrain contributor mode', () => {
  test('pulls team artifacts on a five-minute throttle', () => {
    const out = generateBrainSyncBlock({
      skillName: 'ship',
      tmplPath: '/tmp/ship/SKILL.md.tmpl',
      host: 'claude',
      paths: HOST_PATHS.claude,
    });
    expect(out).toContain('_BRAIN_TRUST_POLICY" = "shared-contributor"');
    expect(out).toContain('_BRAIN_PULL_TTL=300');
    expect(out).toContain('_BRAIN_PULL_TTL=86400');
  });

  test('setup distinguishes contributor access from shared read-only access', () => {
    const setup = readFileSync(join(ROOT, 'setup-gbrain', 'SKILL.md.tmpl'), 'utf8');
    expect(setup).toContain('Shared contributor');
    expect(setup).toContain('Shared read-only');
    expect(setup).toContain('artifacts_sync_mode artifacts-only');
  });

  test('team guide requires server-side indexing after pushes', () => {
    const docs = readFileSync(join(ROOT, 'docs', 'gbrain-sync.md'), 'utf8');
    expect(docs).toContain('Configure the shared GBrain service to index');
    expect(docs).toContain('webhook or a short server-side pull schedule');
  });
});
