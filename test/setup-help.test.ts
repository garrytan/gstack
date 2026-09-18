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

describe('setup: host accept-list ↔ hosts/index.ts registry cross-check (#2361)', () => {
  // The #2361 failure class: a host passes --host validation but has no
  // install arm, so `./setup --host <it>` configures nothing and exits 0.
  // This cross-check derives BOTH sides — the registry from hosts/index.ts
  // and the case arms from setup — so adding a host to either place without
  // the other goes red at the moment of the drift, not in a user report.

  const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');

  function hostCaseArms(): { installTargets: string[]; namedArms: string[] } {
    const start = content.indexOf('case "$HOST" in');
    expect(start).toBeGreaterThan(-1);
    const block = content.slice(start, content.indexOf('\nesac', start));
    // The pipe list is the install accept-list; single-name arms are informational.
    const installTargets: string[] = [];
    const namedArms: string[] = [];
    for (const m of block.matchAll(/^ {2}([a-z|]+)\)/gm)) {
      const names = m[1].split('|');
      if (names.length > 1) installTargets.push(...names.filter((n) => n !== 'auto'));
      else if (names[0] !== 'auto') namedArms.push(names[0]);
    }
    return { installTargets, namedArms };
  }

  test('registry names == accept-list (minus auto) + informational arms', async () => {
    const { ALL_HOST_CONFIGS } = await import('../hosts/index');
    const registered = ALL_HOST_CONFIGS.map((c: { name: string }) => c.name).sort();
    const { installTargets, namedArms } = hostCaseArms();
    const covered = [...new Set([...installTargets, ...namedArms])].sort();
    expect(covered).toEqual(registered);
  });

  test('every accept-listed install target has a dispatch arm (the exact #2361 hole)', () => {
    // Set-membership alone would have passed while slate sat accepted-but-
    // unwired: the invariant that bites is accept-list ⊆ dispatch arms.
    const { installTargets } = hostCaseArms();
    expect(installTargets.length).toBeGreaterThan(0);
    for (const host of installTargets) {
      expect(content).toMatch(new RegExp(`\\[ "\\$HOST" = "${host}" \\]`));
    }
  });

  test('slate informational arm: explains itself, points at --host claude, exit 0', () => {
    const res = spawnSync('bash', [SETUP_SCRIPT, '--host', 'slate'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('./setup --host claude');
    expect(res.stdout).toContain('.claude/skills');
    // It must not fall through into the installer.
    expect(res.stdout).not.toMatch(/Installing|bun install|Building/);
  });

  test('zero-dispatch guard exists: unwired host errors loudly instead of exit-0 no-op', () => {
    // The guard is only reachable when a future host is accepted but unwired,
    // so pin its presence and shape statically: it must name the host, call
    // itself a setup bug, and exit 1.
    const guard = content.match(/no install arm exists for host[^\n]*\n\s*exit 1/);
    expect(guard).toBeTruthy();
    expect(content).toContain("[ \"$HOST\" != \"auto\" ]");
  });
});
