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
import { PROBE_TIMEOUT_MS, resolveProbe, runProbe } from '../lib/office-hours-probe';
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
  tool(gstackBin, 'gstack-thing', 'echo usage: gstack-thing');
  tool(repo, 'jq', 'echo repo jq');

  test('a listed CLI on PATH and a gstack bin resolve', () => {
    expect(resolveProbe('git', { pathEnv: bin, gstackBin, repoRoot: repo })).toEqual({ exe: path.join(bin, 'git') });
    expect(resolveProbe('gstack-thing', { pathEnv: bin, gstackBin, repoRoot: repo })).toEqual({ exe: path.join(gstackBin, 'gstack-thing') });
  });

  test('unlisted names, paths, shell syntax and repository copies are refused', () => {
    for (const command of ['curl', './jq', '/usr/bin/git', 'git;rm', '$(id)', 'gstack-missing']) {
      expect('refused' in resolveProbe(command, { pathEnv: bin, gstackBin, repoRoot: repo })).toBe(true);
    }
    expect(resolveProbe('jq', { pathEnv: repo, gstackBin, repoRoot: repo })).toEqual({ refused: 'jq resolves inside the repository' });
    expect(resolveProbe('rg', { pathEnv: bin, gstackBin })).toEqual({ refused: 'rg is not on PATH' });
  });

  test('fixed-name subcommands are allowed only for subcommand CLIs, as plain lowercase words', () => {
    expect(resolveProbe('git', { pathEnv: bin, gstackBin, repoRoot: repo }, ['log'])).toEqual({ exe: path.join(bin, 'git') });
    tool(bin, 'node', 'echo node');
    for (const [command, words] of [['node', ['script']], ['gstack-thing', ['prior']], ['git', ['-c']], ['git', ['../x']], ['git', ['Log']], ['git', ['a', 'b', 'c']]] as const) {
      expect('refused' in resolveProbe(command, { pathEnv: bin, gstackBin, repoRoot: repo }, words)).toBe(true);
    }
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
