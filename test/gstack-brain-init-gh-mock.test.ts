/**
 * gstack-brain-init — mocked-gh integration tests.
 *
 * The regular brain-sync tests pass `--remote <bare-git-url>` to skip the
 * gh-repo-creation path entirely. That left the happy path (user just
 * presses Enter, gstack-brain-init calls `gh repo create --private`)
 * with zero coverage — you'd only know it broke when a real user tried
 * it with a real GitHub account.
 *
 * These tests put a fake `gh` binary on PATH that records every call
 * into a file, then run gstack-brain-init in its non-flag interactive
 * mode and assert the fake `gh` was invoked with the expected arguments.
 *
 * No real GitHub account, no live API, deterministic per-run.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const INIT_BIN = path.join(BIN_DIR, 'gstack-brain-init');

let tmpHome: string;
let bareRemote: string;
let fakeBinDir: string;
let ghCallLog: string;

function makeFakeGh(opts: {
  authStatus?: 'ok' | 'fail';
  repoCreate?: 'success' | 'already-exists' | 'fail';
  sshUrl?: string;
}) {
  const authStatus = opts.authStatus ?? 'ok';
  const repoCreate = opts.repoCreate ?? 'success';
  const sshUrl = opts.sshUrl ?? bareRemote;
  const script = `#!/bin/bash
echo "gh $@" >> "${ghCallLog}"
case "$1" in
  auth)
    ${authStatus === 'ok' ? 'exit 0' : 'exit 1'}
    ;;
  repo)
    shift
    case "$1" in
      create)
        ${
          repoCreate === 'success'
            ? 'exit 0'
            : repoCreate === 'already-exists'
            ? 'echo "GraphQL: Name already exists on this account" >&2; exit 1'
            : 'echo "network error" >&2; exit 1'
        }
        ;;
      view)
        # Emulate \`gh repo view <name> --json sshUrl -q .sshUrl\`
        echo "${sshUrl}"
        exit 0
        ;;
    esac
    ;;
esac
exit 0
`;
  const ghPath = path.join(fakeBinDir, 'gh');
  fs.writeFileSync(ghPath, script, { mode: 0o755 });
  return ghPath;
}

function run(
  argv: string[],
  opts: { env?: Record<string, string>; input?: string } = {}
) {
  const env = {
    // Put the fake bin dir FIRST on PATH so our mock gh wins.
    PATH: `${fakeBinDir}:/usr/bin:/bin:/opt/homebrew/bin`,
    GSTACK_HOME: tmpHome,
    USER: 'testuser',
    HOME: tmpHome,
    ...(opts.env || {}),
  };
  const res = spawnSync(INIT_BIN, argv, {
    env,
    encoding: 'utf-8',
    input: opts.input,
    cwd: ROOT,
  });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    status: res.status ?? -1,
  };
}

function readGhCalls(): string[] {
  if (!fs.existsSync(ghCallLog)) return [];
  return fs.readFileSync(ghCallLog, 'utf-8').trim().split('\n').filter(Boolean);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-gh-mock-'));
  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-bare-'));
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-fake-bin-'));
  ghCallLog = path.join(fakeBinDir, 'gh-calls.log');
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', bareRemote]);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(bareRemote, { recursive: true, force: true });
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
  const remoteFile = path.join(os.homedir(), '.gstack-brain-remote.txt');
  if (fs.existsSync(remoteFile)) {
    const contents = fs.readFileSync(remoteFile, 'utf-8');
    if (contents.includes(bareRemote)) fs.unlinkSync(remoteFile);
  }
});

describe('gstack-brain-init uses gh CLI when present + authed', () => {
  test('calls gh repo create --private with the computed default name', () => {
    makeFakeGh({ authStatus: 'ok', repoCreate: 'success' });
    // Interactive mode; pressing Enter accepts the gh default.
    const r = run([], { input: '\n' });
    expect(r.status).toBe(0);
    const calls = readGhCalls();
    // First call: auth status check
    expect(calls.some((c) => c.startsWith('gh auth'))).toBe(true);
    // The create call
    const createCall = calls.find((c) => c.startsWith('gh repo create'));
    expect(createCall).toBeDefined();
    expect(createCall).toContain('gstack-brain-testuser');
    expect(createCall).toContain('--private');
    expect(createCall).toContain('--description');
    // --source is intentionally omitted: gh requires the source dir to already
    // be a git repo, but brain-init doesn't `git init $GSTACK_HOME` until later.
    // Creating bare and wiring up the remote explicitly avoids that ordering bug.
    expect(createCall).not.toContain('--source');
  });

  test('falls back to gh repo view when create reports already-exists', () => {
    makeFakeGh({ authStatus: 'ok', repoCreate: 'already-exists' });
    const r = run([], { input: '\n' });
    expect(r.status).toBe(0);
    const calls = readGhCalls();
    // create was attempted
    expect(calls.some((c) => c.startsWith('gh repo create'))).toBe(true);
    // then view was called to recover the URL
    expect(calls.some((c) => c.startsWith('gh repo view') && c.includes('gstack-brain-testuser'))).toBe(true);
    // The view output (bareRemote URL) should have been wired up as origin.
    const remote = spawnSync('git', ['-C', tmpHome, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
    });
    expect(remote.stdout.trim()).toBe(bareRemote);
  });

  test('user-provided URL bypasses gh create entirely', () => {
    makeFakeGh({ authStatus: 'ok', repoCreate: 'fail' });
    const r = run([], { input: `${bareRemote}\n` });
    expect(r.status).toBe(0);
    const calls = readGhCalls();
    // gh auth was still checked
    expect(calls.some((c) => c.startsWith('gh auth'))).toBe(true);
    // but create was NOT called (user bypassed the default)
    expect(calls.some((c) => c.startsWith('gh repo create'))).toBe(false);
  });
});

describe('gstack-brain-init without gh CLI', () => {
  test('prompts for URL when gh is not on PATH', () => {
    // Don't install fake gh — PATH will not have it.
    // Use a bare-minimum PATH so nothing else shadows.
    const stripped = `${fakeBinDir}:/usr/bin:/bin`;
    const res = spawnSync(INIT_BIN, [], {
      env: {
        PATH: stripped,
        GSTACK_HOME: tmpHome,
        USER: 'testuser',
        HOME: tmpHome,
      },
      encoding: 'utf-8',
      input: `${bareRemote}\n`,
      cwd: ROOT,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('gh CLI not found');
    // Remote got set from the stdin paste
    const remote = spawnSync('git', ['-C', tmpHome, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
    });
    expect(remote.stdout.trim()).toBe(bareRemote);
  });

  test('prompts for URL when gh is present but not authed', () => {
    makeFakeGh({ authStatus: 'fail' });
    const r = run([], { input: `${bareRemote}\n` });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gh CLI not found or not authenticated');
    const calls = readGhCalls();
    // Only `gh auth status` was called; no create attempt.
    expect(calls.some((c) => c.startsWith('gh auth'))).toBe(true);
    expect(calls.some((c) => c.startsWith('gh repo create'))).toBe(false);
  });
});

describe('idempotency via flag', () => {
  test('--remote <url> skips all gh calls', () => {
    makeFakeGh({ authStatus: 'ok', repoCreate: 'success' });
    const r = run(['--remote', bareRemote]);
    expect(r.status).toBe(0);
    const calls = readGhCalls();
    // Zero calls to gh — the --remote flag short-circuits the interactive path.
    expect(calls.length).toBe(0);
  });

  test('re-run with matching --remote is safe (no conflicting-remote error)', () => {
    run(['--remote', bareRemote]);
    const r2 = run(['--remote', bareRemote]);
    expect(r2.status).toBe(0);
  });

  test('re-run with DIFFERENT --remote exits 1 with a conflict message', () => {
    run(['--remote', bareRemote]);
    const otherRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-other-'));
    spawnSync('git', ['init', '--bare', '-q', '-b', 'main', otherRemote]);
    try {
      const r2 = run(['--remote', otherRemote]);
      expect(r2.status).not.toBe(0);
      expect(r2.stderr).toContain('already a git repo');
    } finally {
      fs.rmSync(otherRemote, { recursive: true, force: true });
    }
  });
});
