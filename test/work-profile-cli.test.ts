import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

describe('work profile authority CLI', () => {
  test('validates one file and emits exactly one JSON object', () => {
    const result = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts/authority/work-profile.ts'), 'validate', '--file', join(import.meta.dir, 'fixtures/work-profile/valid.yaml'), '--json'], { timeout: 30_000 });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString());
    expect(parsed.valid).toBe(true); expect(parsed.profile_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  test('rejects shell/profile injection without writing or spawning', () => {
    const result = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts/authority/work-profile.ts'), 'validate', '--file', join(import.meta.dir, 'fixtures/work-profile/invalid-shell.yaml'), '--json'], { timeout: 30_000 });
    expect(result.exitCode).toBe(2); expect(JSON.parse(result.stderr.toString()).error.code).toContain('validator_shell_forbidden');
  });
});
