/**
 * browser-skill-commands tests — covers the dispatch surface, env scrubbing,
 * spawn lifecycle, timeout, stdout cap.
 *
 * The `run` and `test` subcommands spawn `bun` subprocesses, so these tests
 * write tiny inline scripts to the synthetic skill dir and assert behavior
 * end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rotateRoot, initRegistry, validateToken, listTokens,
} from '../src/token-registry';
import {
  handleSkillCommand,
  spawnSkill,
  buildSpawnEnv,
  parseSkillRunArgs,
} from '../src/browser-skill-commands';
import { readBrowserSkill, type TierPaths } from '../src/browser-skills';

let tmpRoot: string;
let tiers: TierPaths;

beforeEach(() => {
  rotateRoot();
  initRegistry('root-token-for-tests');
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-skill-cmd-test-'));
  tiers = {
    project: path.join(tmpRoot, 'project', '.gstack', 'browser-skills'),
    global: path.join(tmpRoot, 'home', '.gstack', 'browser-skills'),
    bundled: path.join(tmpRoot, 'gstack-install', 'browser-skills'),
  };
  fs.mkdirSync(tiers.project!, { recursive: true });
  fs.mkdirSync(tiers.global, { recursive: true });
  fs.mkdirSync(tiers.bundled, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSkillDir(tierRoot: string, name: string, frontmatter: string, scriptBody: string = '') {
  const dir = path.join(tierRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\nbody\n`);
  if (scriptBody) {
    fs.writeFileSync(path.join(dir, 'script.ts'), scriptBody);
  }
  return dir;
}

describe('parseSkillRunArgs', () => {
  it('extracts --timeout=N', () => {
    const r = parseSkillRunArgs(['--timeout=10', '--arg', 'foo=bar']);
    expect(r.timeoutSeconds).toBe(10);
    expect(r.passthrough).toEqual(['--arg', 'foo=bar']);
  });

  it('defaults to 60s when no timeout', () => {
    const r = parseSkillRunArgs(['--arg', 'foo=bar']);
    expect(r.timeoutSeconds).toBe(60);
    expect(r.passthrough).toEqual(['--arg', 'foo=bar']);
  });

  it('passes through unknown flags', () => {
    const r = parseSkillRunArgs(['--keywords=ai', '--limit=10']);
    expect(r.passthrough).toEqual(['--keywords=ai', '--limit=10']);
  });

  it('ignores invalid --timeout values', () => {
    const r = parseSkillRunArgs(['--timeout=abc', '--timeout=-5']);
    expect(r.timeoutSeconds).toBe(60);
  });
});

describe('handleSkillCommand: list', () => {
  it('shows empty message when no skills', async () => {
    const result = await handleSkillCommand(['list'], { port: 9999, tiers });
    expect(result).toContain('No browser-skills found');
  });

  it('lists skills with their resolved tier', async () => {
    makeSkillDir(tiers.bundled, 'foo', 'name: foo\nhost: a.com\ndescription: foo desc');
    makeSkillDir(tiers.global, 'bar', 'name: bar\nhost: b.com\ndescription: bar desc');
    const result = await handleSkillCommand(['list'], { port: 9999, tiers });
    expect(result).toContain('foo');
    expect(result).toContain('bundled');
    expect(result).toContain('a.com');
    expect(result).toContain('bar');
    expect(result).toContain('global');
  });

  it('prints project tier when same name in multiple tiers', async () => {
    makeSkillDir(tiers.bundled, 'shared', 'name: shared\nhost: bundled.com');
    makeSkillDir(tiers.project!, 'shared', 'name: shared\nhost: project.com');
    const result = await handleSkillCommand(['list'], { port: 9999, tiers });
    expect(result).toContain('project');
    expect(result).toContain('project.com');
    expect(result).not.toContain('bundled.com');
  });
});

describe('handleSkillCommand: show', () => {
  it('prints SKILL.md', async () => {
    makeSkillDir(tiers.bundled, 'foo', 'name: foo\nhost: a.com\ndescription: hi');
    const result = await handleSkillCommand(['show', 'foo'], { port: 9999, tiers });
    expect(result).toContain('name: foo');
    expect(result).toContain('host: a.com');
    expect(result).toContain('body');
  });

  it('throws when skill missing', async () => {
    await expect(handleSkillCommand(['show', 'nope'], { port: 9999, tiers })).rejects.toThrow(/not found/);
  });

  it('throws when name omitted', async () => {
    await expect(handleSkillCommand(['show'], { port: 9999, tiers })).rejects.toThrow(/Usage/);
  });
});

describe('handleSkillCommand: rm', () => {
  it('tombstones global skill by default', async () => {
    makeSkillDir(tiers.global, 'gone', 'name: gone\nhost: x.com');
    // No project tier skill, so default tier resolution should target global anyway.
    // But the function defaults to 'project' unless --global. With no project
    // skill, it would error — pass --global explicitly.
    const result = await handleSkillCommand(['rm', 'gone', '--global'], { port: 9999, tiers });
    expect(result).toContain('Tombstoned');
    expect(fs.existsSync(path.join(tiers.global, 'gone'))).toBe(false);
  });

  it('tombstones project skill', async () => {
    makeSkillDir(tiers.project!, 'gone', 'name: gone\nhost: x.com');
    const result = await handleSkillCommand(['rm', 'gone'], { port: 9999, tiers });
    expect(result).toContain('Tombstoned');
    expect(fs.existsSync(path.join(tiers.project!, 'gone'))).toBe(false);
  });

  it('falls back to global when no project tier path', async () => {
    const tiersNoProject = { ...tiers, project: null };
    makeSkillDir(tiers.global, 'gone', 'name: gone\nhost: x.com');
    const result = await handleSkillCommand(['rm', 'gone'], { port: 9999, tiers: tiersNoProject });
    expect(result).toContain('global');
  });
});

describe('handleSkillCommand: help / unknown', () => {
  it('prints usage with no subcommand', async () => {
    const r = await handleSkillCommand([], { port: 9999, tiers });
    expect(r).toContain('Usage');
  });

  it('throws on unknown subcommand', async () => {
    await expect(handleSkillCommand(['frobnicate'], { port: 9999, tiers }))
      .rejects.toThrow(/Unknown skill subcommand/);
  });
});

describe('buildSpawnEnv', () => {
  let origEnv: Record<string, string | undefined>;
  beforeEach(() => {
    origEnv = { ...process.env };
    // Plant some secrets for scrub-tests
    process.env.GITHUB_TOKEN = 'gh-secret';
    process.env.OPENAI_API_KEY = 'oai-secret';
    process.env.MY_PASSWORD = 'sup3r';
    process.env.NPM_TOKEN = 'npmtok';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.GSTACK_TOKEN = 'root-token';
    process.env.HOME = '/Users/test';
    process.env.PATH = '/test/bin:/usr/bin';
    process.env.LANG = 'en_US.UTF-8';
  });
  afterEach(() => {
    process.env = origEnv;
  });

  it('untrusted: drops $HOME and secrets', () => {
    const env = buildSpawnEnv({ trusted: false, port: 1234, skillToken: 'tok' });
    expect(env.HOME).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.MY_PASSWORD).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GSTACK_TOKEN).toBeUndefined();
  });

  it('untrusted: keeps locale + TERM', () => {
    process.env.TERM = 'xterm-256color';
    const env = buildSpawnEnv({ trusted: false, port: 1234, skillToken: 'tok' });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
  });

  it('untrusted: PATH is minimal (no /test/bin override)', () => {
    const env = buildSpawnEnv({ trusted: false, port: 1234, skillToken: 'tok' });
    expect(env.PATH).not.toContain('/test/bin');
    expect(env.PATH).toMatch(/\/(usr\/local\/)?bin/);
  });

  it('untrusted: injects GSTACK_PORT + GSTACK_SKILL_TOKEN', () => {
    const env = buildSpawnEnv({ trusted: false, port: 1234, skillToken: 'tok-xyz' });
    expect(env.GSTACK_PORT).toBe('1234');
    expect(env.GSTACK_SKILL_TOKEN).toBe('tok-xyz');
  });

  it('trusted: keeps $HOME', () => {
    const env = buildSpawnEnv({ trusted: true, port: 1234, skillToken: 'tok' });
    expect(env.HOME).toBe('/Users/test');
  });

  it('trusted: still strips GSTACK_TOKEN (defense in depth)', () => {
    const env = buildSpawnEnv({ trusted: true, port: 1234, skillToken: 'tok' });
    expect(env.GSTACK_TOKEN).toBeUndefined();
  });

  it('trusted: keeps developer secrets (intentional)', () => {
    const env = buildSpawnEnv({ trusted: true, port: 1234, skillToken: 'tok' });
    expect(env.GITHUB_TOKEN).toBe('gh-secret');
  });

  it('GSTACK_PORT/GSTACK_SKILL_TOKEN can never be overridden by parent env', () => {
    process.env.GSTACK_PORT = '99999'; // attacker-set
    process.env.GSTACK_SKILL_TOKEN = 'attacker-tok';
    const env = buildSpawnEnv({ trusted: true, port: 1234, skillToken: 'real-tok' });
    expect(env.GSTACK_PORT).toBe('1234');
    expect(env.GSTACK_SKILL_TOKEN).toBe('real-tok');
  });
});

// ─── Spawn integration ──────────────────────────────────────────
//
// Tests below shell out to `bun run` against a synthesized script.ts, so they
// take 1-3s each. Skip the suite if BUN_TEST_NO_SPAWN is set.
const SKIP_SPAWN = process.env.BUN_TEST_NO_SPAWN === '1';

describe.skipIf(SKIP_SPAWN)('spawnSkill: lifecycle', () => {
  it('happy path: returns stdout, exit 0, token revoked', async () => {
    const dir = makeSkillDir(tiers.bundled, 'echo-skill',
      'name: echo-skill\nhost: x.com\ntrusted: true',
      `console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));`,
    );
    const skill = readBrowserSkill('echo-skill', tiers)!;
    const result = await spawnSkill({
      skill,
      skillArgs: ['hello'],
      trusted: true,
      timeoutSeconds: 30,
      port: 9999,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    // Only --timeout filtering happens; -- is preserved by Bun.
    expect(parsed.args).toContain('hello');
    // Token revoked: nothing left in the registry for this client.
    expect(listTokens().filter(t => t.clientId.startsWith('skill:echo-skill:'))).toEqual([]);
  });

  it('untrusted spawn: GSTACK_SKILL_TOKEN visible, root env scrubbed', async () => {
    const dir = makeSkillDir(tiers.bundled, 'env-probe',
      'name: env-probe\nhost: x.com',  // trusted defaults to false
      `console.log(JSON.stringify({
        port: process.env.GSTACK_PORT,
        token: process.env.GSTACK_SKILL_TOKEN,
        home: process.env.HOME ?? null,
        gh: process.env.GITHUB_TOKEN ?? null,
        gstack: process.env.GSTACK_TOKEN ?? null,
      }));`,
    );
    const origEnv = { ...process.env };
    process.env.GITHUB_TOKEN = 'gh-secret';
    process.env.GSTACK_TOKEN = 'root';
    try {
      const skill = readBrowserSkill('env-probe', tiers)!;
      const result = await spawnSkill({
        skill, skillArgs: [], trusted: false, timeoutSeconds: 30, port: 4242,
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.port).toBe('4242');
      expect(parsed.token).toMatch(/^gsk_sess_/);
      expect(parsed.home).toBeNull();
      expect(parsed.gh).toBeNull();
      expect(parsed.gstack).toBeNull();
    } finally {
      process.env = origEnv;
    }
  });

  it('trusted spawn: HOME passes through', async () => {
    const dir = makeSkillDir(tiers.bundled, 'env-trusted',
      'name: env-trusted\nhost: x.com\ntrusted: true',
      `console.log(JSON.stringify({ home: process.env.HOME ?? null }));`,
    );
    const origEnv = { ...process.env };
    process.env.HOME = '/Users/test-user';
    try {
      const skill = readBrowserSkill('env-trusted', tiers)!;
      const result = await spawnSkill({
        skill, skillArgs: [], trusted: true, timeoutSeconds: 30, port: 9999,
      });
      const parsed = JSON.parse(result.stdout);
      expect(parsed.home).toBe('/Users/test-user');
    } finally {
      process.env = origEnv;
    }
  });

  it('timeout fires, exit code 124, token revoked', async () => {
    const dir = makeSkillDir(tiers.bundled, 'sleeper',
      'name: sleeper\nhost: x.com\ntrusted: true',
      // Sleep longer than the test timeout; the spawn should kill us.
      `await new Promise(r => setTimeout(r, 30000)); console.log("done");`,
    );
    const skill = readBrowserSkill('sleeper', tiers)!;
    const result = await spawnSkill({
      skill, skillArgs: [], trusted: true, timeoutSeconds: 1, port: 9999,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(listTokens().filter(t => t.clientId.startsWith('skill:sleeper:'))).toEqual([]);
  }, 10_000);

  it('script crash propagates nonzero exit', async () => {
    const dir = makeSkillDir(tiers.bundled, 'crasher',
      'name: crasher\nhost: x.com\ntrusted: true',
      `process.exit(7);`,
    );
    const skill = readBrowserSkill('crasher', tiers)!;
    const result = await spawnSkill({
      skill, skillArgs: [], trusted: true, timeoutSeconds: 5, port: 9999,
    });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it('stdout > 1MB truncates and reports truncated', async () => {
    const dir = makeSkillDir(tiers.bundled, 'flood',
      'name: flood\nhost: x.com\ntrusted: true',
      // Emit ~2MB of "x" so the cap fires deterministically.
      `const chunk = 'x'.repeat(64 * 1024);
       for (let i = 0; i < 40; i++) process.stdout.write(chunk);`,
    );
    const skill = readBrowserSkill('flood', tiers)!;
    const result = await spawnSkill({
      skill, skillArgs: [], trusted: true, timeoutSeconds: 10, port: 9999,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  }, 10_000);
});
