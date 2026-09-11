import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateFusedAuthorityProjection } from '../scripts/gen-skill-docs';

describe('post-080 authority overhead', () => {
  test('generation rejects serial authority fan-out in governed Codex projections', () => {
    expect(() => validateFusedAuthorityProjection('codex', 'review/SKILL.md', 'run gstack-project-identity')).toThrow('serial_authority_projection_forbidden');
    expect(() => validateFusedAuthorityProjection('codex', 'review/SKILL.md', 'run gstack-execution-plan resolve')).not.toThrow();
  });
  test('compiled authority bundle stays below the 8 MiB decision hashing ceiling', () => {
    const manifest = JSON.parse(readFileSync('dist/authority/manifest.json', 'utf8'));
    const bytes = Object.values(manifest.commands).reduce((sum: number, item: any) => sum + item.size, 0);
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
