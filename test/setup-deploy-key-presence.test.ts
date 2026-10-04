/**
 * D4 (#1078): /setup-deploy ran `echo $RENDER_API_KEY | head -c 4`, printing
 * the key's first bytes into the transcript. It now reports presence only.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SKILL = fs.readFileSync(path.resolve(import.meta.dir, '..', 'setup-deploy', 'SKILL.md'), 'utf-8');
const KEY = 'rnd_D4testKeyValue1234567890';

describe('D4: setup-deploy reports Render key presence, never key bytes', () => {
  const at = SKILL.indexOf('Check only whether the Render API key is set');
  const block = SKILL.slice(at).match(/```bash\n([\s\S]*?)\n```/)?.[1] ?? '';

  test('the check runs and prints only set / not set', () => {
    expect(at).toBeGreaterThanOrEqual(0);
    const run = (env: Record<string, string>) => spawnSync('bash', ['-c', block], {
      env: { PATH: process.env.PATH!, ...env }, encoding: 'utf-8', timeout: 10_000,
    });
    const set = run({ RENDER_API_KEY: KEY });
    expect(set.stdout).toBe('RENDER_API_KEY: set\n');
    expect(set.stdout).not.toContain(KEY.slice(0, 4));
    expect(run({}).stdout).toBe('RENDER_API_KEY: not set\n');
  });

  test('no setup-deploy command prints a credential variable value', () => {
    const fences = [...SKILL.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(m => m[1]).join('\n');
    const inline = [...SKILL.matchAll(/`([^`\n]*)`/g)].map(m => m[1]).join('\n');
    for (const text of [fences, inline]) {
      expect(text).not.toMatch(/(echo|printf)[^\n|;]*\$\{?[A-Z0-9_]*(API_KEY|TOKEN|SECRET)\b/);
    }
  });
});
