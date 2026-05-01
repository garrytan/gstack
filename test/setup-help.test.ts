import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');

describe('setup: --help flag (#1133)', () => {
  test('setup script defines a usage() function', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    expect(content).toMatch(/^usage\(\)\s*\{/m);
  });

  test('setup script short-circuits on -h/--help before env checks', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    const helpIdx = content.search(/-h\|--help\)\s*usage;\s*exit 0/);
    const bunCheckIdx = content.indexOf('command -v bun');
    expect(helpIdx).toBeGreaterThan(-1);
    expect(bunCheckIdx).toBeGreaterThan(-1);
    // --help must be handled before the bun availability check so the flag
    // works on machines that haven't installed bun yet.
    expect(helpIdx).toBeLessThan(bunCheckIdx);
  });

  test('usage text documents every supported flag', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    const usageMatch = content.match(/usage\(\)\s*\{[\s\S]*?\n\}/);
    expect(usageMatch).toBeTruthy();
    const usage = usageMatch![0];
    for (const flag of [
      '--host',
      '--prefix',
      '--no-prefix',
      '--team',
      '--no-team',
      '--quiet',
      '--help',
    ]) {
      expect(usage).toContain(flag);
    }
  });

  test('./setup --help exits 0, prints usage, and does not run installer', () => {
    const res = spawnSync('bash', [SETUP_SCRIPT, '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage:');
    expect(res.stdout).toContain('gstack setup');
    // Hard guarantee it short-circuited — none of the install-side output appears.
    expect(res.stdout).not.toMatch(/Installing|bun install|Building|gen:skill-docs/);
  });

  test('./setup -h is equivalent to ./setup --help', () => {
    const res = spawnSync('bash', [SETUP_SCRIPT, '-h'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage:');
  });
});
