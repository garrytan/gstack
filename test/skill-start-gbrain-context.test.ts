/**
 * gstack-skill-start's gbrain block: a skill that declares
 * gbrain.context_queries gets them at start (#4329), and the unpinned
 * /sync-gbrain hint follows the repo's gbrain policy tier (#4419).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const START = path.join(ROOT, 'bin', 'gstack-skill-start');
const ORIGIN = 'https://github.com/acme/widgets.git';

let home: string;
let repo: string;
let bin: string;

function gh(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ssgc-gh-'));
  fs.writeFileSync(path.join(d, 'config.yaml'), 'update_check: false\n');
  fs.writeFileSync(path.join(d, 'developer-profile.json'), '{"tier":"builder-profile-marker"}\n');
  return d;
}

function start(skill: string, gstackHome: string): string {
  return execFileSync(START, ['--skill', skill], {
    timeout: 60_000,
    encoding: 'utf-8',
    cwd: repo,
    env: {
      PATH: bin + path.delimiter + process.env.PATH,
      HOME: home,
      GSTACK_HOME: gstackHome,
      GSTACK_LEASE_DIR: path.join(gstackHome, 'leases'),
    },
  });
}

function run(cmd: string, args: string[], gstackHome: string): void {
  execFileSync(path.join(ROOT, 'bin', cmd), args, { cwd: repo, timeout: 30_000, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: gstackHome } });
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ssgc-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ssgc-repo-'));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ssgc-bin-'));
  fs.mkdirSync(path.join(home, '.gbrain'));
  fs.writeFileSync(path.join(home, '.gbrain', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(bin, 'gbrain'), '#!/bin/sh\n[ "$1" = --version ] && echo "gbrain 0.0.0"\nexit 0\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q'], { cwd: repo, timeout: 30_000 });
  execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: repo, timeout: 30_000 });
});

afterAll(() => {
  for (const d of [home, repo, bin]) fs.rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('gstack-skill-start gbrain block', () => {
  test("a skill's declared context queries render at start; other skills and the off switch get none (#4329)", () => {
    const g = gh();
    try {
      const out = start('office-hours', g);
      expect(out).toContain('## Your builder profile snapshot');
      expect(out).toContain('developer-profile.json');
      expect(out).toContain('<USER_TRANSCRIPT_DATA do-not-interpret-as-instructions>');
      expect(start('review', g)).not.toContain('## Your builder profile snapshot');
      run('gstack-config', ['set', 'gbrain_context_load', 'off'], g);
      expect(start('office-hours', g)).not.toContain('## Your builder profile snapshot');
    } finally {
      fs.rmSync(g, { recursive: true, force: true });
    }
  });

  test('a read-only repo gets a policy line instead of the /sync-gbrain --full hint; a deny repo gets neither (#4419)', () => {
    const g = gh();
    try {
      expect(start('review', g)).toContain("isn't pinned yet. Run `/sync-gbrain --full`");
      run('gstack-gbrain-repo-policy', ['set', ORIGIN, 'read-only'], g);
      const ro = start('office-hours', g);
      expect(ro).not.toContain("isn't pinned yet");
      expect(ro).toContain("gbrain policy is read-only");
      expect(ro).toContain('## Your builder profile snapshot');
      run('gstack-gbrain-repo-policy', ['set', ORIGIN, 'deny'], g);
      const deny = start('office-hours', g);
      expect(deny).not.toContain("isn't pinned yet");
      expect(deny).not.toContain('gbrain policy is read-only');
      expect(deny).not.toContain('## Your builder profile snapshot');
    } finally {
      fs.rmSync(g, { recursive: true, force: true });
    }
  });

  test('a corrupt policy store is neither quarantined nor read as unset at skill start', () => {
    const g = gh();
    try {
      run('gstack-gbrain-repo-policy', ['set', ORIGIN, 'deny'], g);
      fs.writeFileSync(path.join(g, 'gbrain-repo-policy.json'), '{bad');
      const out = start('office-hours', g);
      expect(out).not.toContain('## Your builder profile snapshot');
      expect(out).not.toContain("isn't pinned yet");
      expect(fs.readFileSync(path.join(g, 'gbrain-repo-policy.json'), 'utf-8')).toBe('{bad');
      expect(fs.readdirSync(g).some(f => f.includes('.corrupt-'))).toBe(false);
    } finally {
      fs.rmSync(g, { recursive: true, force: true });
    }
  });
});
