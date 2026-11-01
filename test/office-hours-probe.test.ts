/**
 * G1 (#973): the office-hours spec reviewer may check a cited flag with
 * `gstack-office-hours-review probe --help <command>`. The bin enforces the
 * allowlist; the prompt confines Read/Grep to the repository and names the
 * probe instead of forbidding every check.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROBE_TIMEOUT_MS, repoRootOf, resolveProbe, runProbe } from '../lib/office-hours-probe';
import { renderOfficeHoursReviewerPrompt } from '../lib/office-hours-review';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-office-hours-review');

function tool(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

describe('resolveProbe', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-bin-'));
  const gstackBin = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-gstack-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-repo-'));
  tool(bin, 'git', 'echo usage: git');
  tool(bin, 'curl', 'echo nope');
  tool(gstackBin, 'gstack-thing', '[ "$1" = --help ] && echo usage: gstack-thing');
  tool(gstackBin, 'gstack-login', 'echo logged in');
  tool(repo, 'jq', 'echo repo jq');

  test('a listed CLI on PATH and a gstack bin resolve', () => {
    expect(resolveProbe('git', { pathEnv: bin, gstackBin, repoRoot: repo })).toEqual({ exe: path.join(bin, 'git') });
    expect(resolveProbe('gstack-thing', { pathEnv: bin, gstackBin, repoRoot: repo })).toEqual({ exe: path.join(gstackBin, 'gstack-thing') });
  });

  test('unlisted names, paths, shell syntax and repository copies are refused', () => {
    for (const command of ['curl', './jq', '/usr/bin/git', 'git;rm', '$(id)', 'gstack-missing']) {
      expect('refused' in resolveProbe(command, { pathEnv: bin, gstackBin, repoRoot: repo })).toBe(true);
    }
    expect(resolveProbe('jq', { pathEnv: repo, gstackBin, repoRoot: repo })).toEqual({ refused: 'jq is not on PATH' });
    fs.symlinkSync(path.join(repo, 'jq'), path.join(bin, 'jq'));
    expect(resolveProbe('jq', { pathEnv: bin, gstackBin, repoRoot: repo })).toEqual({ refused: 'jq resolves inside the repository' });
    expect(resolveProbe('rg', { pathEnv: bin, gstackBin })).toEqual({ refused: 'rg is not on PATH' });
  });

  test('fixed-name subcommands are allowed only for subcommand CLIs, as plain lowercase words', () => {
    expect(resolveProbe('git', { pathEnv: bin, gstackBin, repoRoot: repo }, ['log'])).toEqual({ exe: path.join(bin, 'git') });
    tool(bin, 'node', 'echo node');
    for (const [command, words] of [['node', ['script']], ['gstack-thing', ['prior']], ['git', ['-c']], ['git', ['../x']], ['git', ['Log']], ['git', ['a', 'b', 'c']]] as const) {
      expect('refused' in resolveProbe(command, { pathEnv: bin, gstackBin, repoRoot: repo }, words)).toBe(true);
    }
  });

  test('a subcommand word must be a listed built-in of that CLI, never one that runs a named program, image or extension', () => {
    for (const c of ['gh', 'docker', 'uv', 'go', 'npm']) tool(bin, c, 'echo usage');
    const o = { pathEnv: bin, gstackBin, repoRoot: repo };
    for (const [command, w] of [['gh', ['pr', 'create']], ['git', ['worktree']], ['docker', ['compose', 'up']], ['uv', ['pip', 'install']], ['go', ['mod', 'tidy']]] as const) {
      expect(resolveProbe(command, o, w)).toEqual({ exe: path.join(bin, command) });
    }
    for (const [command, w] of [['uv', ['run', 'probetarget']], ['uv', ['tool', 'run']], ['docker', ['run', 'img']], ['docker', ['container', 'run']], ['go', ['test', 'pkg']], ['go', ['run', 'x']], ['cargo', ['fmt']], ['cargo', ['clippy']], ['npm', ['exec', 'x']], ['npm', ['run', 'x']], ['gh', ['myext']], ['git', ['log', 'x']]] as const) {
      expect('refused' in resolveProbe(command, o, w)).toBe(true);
    }
  });

  test('a gstack bin that does not handle --help is refused', () => {
    expect(resolveProbe('gstack-login', { pathEnv: bin, gstackBin })).toEqual({ refused: 'gstack-login does not handle --help' });
  });

  test('the probe sees no keys or tokens, keeps HOME, drops in-repository PATH entries, and never retries a gstack bin with -h', () => {
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, GH_TOKEN: process.env.GH_TOKEN };
    process.env.OPENAI_API_KEY = 'planted'; process.env.GH_TOKEN = 'planted';
    try {
      tool(repo, 'man', 'echo repo man');
      const peek = tool(bin, 'peek', 'echo "key=${OPENAI_API_KEY:-none} gh=${GH_TOKEN:-none} home=$HOME path=$PATH args=$*"');
      const out = runProbe(peek, [], { pathEnv: [repo, 'rel/bin', bin].join(path.delimiter), repoRoot: repo }).output.trim();
      expect(out).toBe(`key=none gh=none home=${process.env.HOME} path=${bin} args=-h`);
      expect(resolveProbe('man' as string, { pathEnv: repo, gstackBin, repoRoot: repo })).toHaveProperty('refused');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const g = tool(gstackBin, 'gstack-quiet', 'echo "args=$*" # --help');
    expect(runProbe(g).output.trim()).toBe('args=--help');
  });

  test('repoRootOf finds the enclosing repository without running git', () => {
    fs.mkdirSync(path.join(repo, '.git', 'x'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    expect(repoRootOf(path.join(repo, 'a', 'b'))).toBe(repo);
    expect(repoRootOf(bin)).toBeUndefined();
  });

  test('runProbe passes only --help, closes stdin and stops a hanging command', () => {
    const echo = tool(bin, 'args', 'echo "usage: args=$*"; read x && echo "stdin=$x"');
    expect(runProbe(echo).output).toBe('usage: args=--help\n');
    const hang = tool(bin, 'hang', 'sleep 30');
    const t0 = Date.now();
    expect(runProbe(hang).timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(PROBE_TIMEOUT_MS + 5_000);
  }, 20_000);

  test('subcommands come before --help, help without a usage line falls back to -h, and the probe runs in an empty directory', () => {
    const sub = tool(bin, 'sub', '[ "$2" = --help ] && exit 1; echo "args=$* files=$(ls -A | wc -l) pager=$PAGER"');
    expect(runProbe(sub, ['log']).output.trim()).toBe('args=log -h files=0 pager=cat');
  });
});

describe('gstack-office-hours-review probe', () => {
  test('a refused command exits 3 with OFFICE_HOURS_PROBE_REFUSED; a listed one prints its help', () => {
    const refused = spawnSync('bun', [BIN, 'probe', '--help', 'curl'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('(OFFICE_HOURS_PROBE_REFUSED)');
    const git = spawnSync('bun', [BIN, 'probe', '--help', 'git'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(git.stdout).toMatch(/^PROBE: git exit=\d+/);
    expect(spawnSync('bun', [BIN, 'probe', '--help', 'git', 'log'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout).toMatch(/^PROBE: git log exit=\d+/);
    expect(spawnSync('bun', [BIN, 'probe', '--help', 'node', 'script'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).status).toBe(3);
    expect(spawnSync('bun', [BIN, 'probe', 'git'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).status).toBe(1);
  });
});

describe('reviewer prompt', () => {
  test('names the probe and repository-only reads, keeps Edit forbidden, and makes wrong facts blocking', () => {
    const prompt = renderOfficeHoursReviewerPrompt({ document: '/tmp/design.md', verdictPath: '/tmp/review/round-1.json' });
    expect(prompt).toContain('Read, Grep and Glob (on files inside the repository checkout, never elsewhere)');
    expect(prompt).toContain('`Probe:` command');
    expect(prompt).toContain('instead of running code');
    expect(prompt).toContain('A wrong path, flag or number is blocking.');
    expect(prompt).toContain('Never use Edit');
  });
});
