/**
 * gstack-artifacts-init — provider-selection + brain-admin-hookup tests.
 *
 * Mirrors the gstack-brain-init-gh-mock.test.ts pattern: install fake gh /
 * glab / git binaries on PATH, drive the script's three host-pref branches,
 * assert it (a) creates the right repo name, (b) stores HTTPS canonical in
 * ~/.gstack-artifacts-remote.txt, (c) prints the "Send this to your brain
 * admin" block in the right form depending on --url-form-supported.
 *
 * Per codex Finding #3: the script always prints the hookup command, never
 * auto-executes (no MCP probe). Per Finding #10: stored URL is HTTPS.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const INIT_BIN = path.join(ROOT, 'bin', 'gstack-artifacts-init');

let tmpHome: string;
let bareRemote: string;
let fakeBinDir: string;
let ghCallLog: string;
let glabCallLog: string;

function makeFakeGh(opts: { authStatus?: 'ok' | 'fail'; repoCreate?: 'success' | 'already-exists' | 'fail'; webUrl?: string } = {}) {
  const authStatus = opts.authStatus ?? 'ok';
  const repoCreate = opts.repoCreate ?? 'success';
  const webUrl = opts.webUrl ?? `https://github.com/testuser/gstack-artifacts-testuser`;
  const script = `#!/bin/bash
echo "gh $@" >> "${ghCallLog}"
case "$1" in
  auth) ${authStatus === 'ok' ? 'exit 0' : 'exit 1'} ;;
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
        # gh repo view <name> --json url -q .url
        echo "${webUrl}"
        exit 0
        ;;
    esac
    ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(fakeBinDir, 'gh'), script, { mode: 0o755 });
}

function makeFakeGlab(opts: { authStatus?: 'ok' | 'fail'; repoCreate?: 'success' | 'fail'; webUrl?: string } = {}) {
  const authStatus = opts.authStatus ?? 'ok';
  const repoCreate = opts.repoCreate ?? 'success';
  const webUrl = opts.webUrl ?? 'https://gitlab.com/testuser/gstack-artifacts-testuser';
  const script = `#!/bin/bash
echo "glab $@" >> "${glabCallLog}"
case "$1" in
  auth) ${authStatus === 'ok' ? 'exit 0' : 'exit 1'} ;;
  repo)
    shift
    case "$1" in
      create) ${repoCreate === 'success' ? 'exit 0' : 'exit 1'} ;;
      view)
        # glab repo view <name> -F json
        echo '{"web_url":"${webUrl}"}'
        exit 0
        ;;
    esac
    ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(fakeBinDir, 'glab'), script, { mode: 0o755 });
}

/**
 * git shim that no-ops the network calls (ls-remote, fetch, push, pull) so
 * tests don't actually need a reachable remote. Real git is used for local
 * operations like init / config / commit / remote set-url. This keeps the
 * test focused on artifacts-init's branching logic, not git plumbing.
 */
function makeFakeGit() {
  const realGit = spawnSync('which', ['git'], { encoding: 'utf-8' }).stdout.trim();
  const script = `#!/bin/bash
# Walk argv past leading -C <dir> and similar flags to find the real subcommand.
args=("$@")
i=0
while [ $i -lt \${#args[@]} ]; do
  case "\${args[$i]}" in
    -C) i=$((i+2)) ;;
    -c) i=$((i+2)) ;;
    --) break ;;
    -*) i=$((i+1)) ;;
    *) break ;;
  esac
done
sub="\${args[$i]:-}"
case "$sub" in
  ls-remote|fetch|push|pull) exit 0 ;;
  *) exec "${realGit}" "$@" ;;
esac
`;
  fs.writeFileSync(path.join(fakeBinDir, 'git'), script, { mode: 0o755 });
}

function run(argv: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  // Include the bin/ dir so artifacts-init can find artifacts-url.
  const binDir = path.join(ROOT, 'bin');
  const env = {
    PATH: `${fakeBinDir}:${binDir}:/usr/bin:/bin:/opt/homebrew/bin`,
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

function readCalls(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-init-'));
  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-bare-'));
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-fake-bin-'));
  ghCallLog = path.join(fakeBinDir, 'gh-calls.log');
  glabCallLog = path.join(fakeBinDir, 'glab-calls.log');
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', bareRemote]);
  makeFakeGit();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(bareRemote, { recursive: true, force: true });
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

describe('gstack-artifacts-init provider selection', () => {
  test('--host github invokes gh repo create with gstack-artifacts-$USER', () => {
    makeFakeGh({});
    const r = run(['--host', 'github']);
    if (r.status !== 0) console.error('STDERR:', r.stderr);
    expect(r.status).toBe(0);
    const calls = readCalls(ghCallLog);
    const createCall = calls.find((c) => c.startsWith('gh repo create'));
    expect(createCall).toBeDefined();
    expect(createCall).toContain('gstack-artifacts-testuser');
    expect(createCall).toContain('--private');
  });

  test('--host gitlab invokes glab repo create', () => {
    makeFakeGlab({});
    const r = run(['--host', 'gitlab']);
    if (r.status !== 0) console.error('STDERR:', r.stderr);
    expect(r.status).toBe(0);
    const calls = readCalls(glabCallLog);
    const createCall = calls.find((c) => c.startsWith('glab repo create'));
    expect(createCall).toBeDefined();
    expect(createCall).toContain('gstack-artifacts-testuser');
    expect(createCall).toContain('--private');
  });

  test('both gh and glab authed → interactive prompt picks GitHub by default (Enter = 1)', () => {
    makeFakeGh({});
    makeFakeGlab({});
    const r = run([], { input: '\n' });
    expect(r.status).toBe(0);
    expect(readCalls(ghCallLog).some((c) => c.startsWith('gh repo create'))).toBe(true);
    expect(readCalls(glabCallLog).some((c) => c.startsWith('glab repo create'))).toBe(false);
  });

  test('both gh and glab authed → user picks 2 → glab is used', () => {
    makeFakeGh({});
    makeFakeGlab({});
    const r = run([], { input: '2\n' });
    expect(r.status).toBe(0);
    expect(readCalls(glabCallLog).some((c) => c.startsWith('glab repo create'))).toBe(true);
    expect(readCalls(ghCallLog).some((c) => c.startsWith('gh repo create'))).toBe(false);
  });

  test('only gh authed → defaults to github (no prompt)', () => {
    makeFakeGh({});
    // No glab installed.
    const r = run([]);
    expect(r.status).toBe(0);
    expect(readCalls(ghCallLog).some((c) => c.startsWith('gh repo create'))).toBe(true);
  });

  test('only glab authed → defaults to gitlab (no prompt)', () => {
    makeFakeGlab({});
    const r = run([]);
    expect(r.status).toBe(0);
    expect(readCalls(glabCallLog).some((c) => c.startsWith('glab repo create'))).toBe(true);
  });

  test('neither authed → falls through to manual URL paste', () => {
    // No gh, no glab fakes.
    const r = run([], { input: 'https://github.com/testuser/gstack-artifacts-testuser\n' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Neither gh nor glab');
  });
});

describe('gstack-artifacts-init canonical URL storage (codex Finding #10)', () => {
  test('stores HTTPS URL canonical in ~/.gstack-artifacts-remote.txt', () => {
    makeFakeGh({ webUrl: 'https://github.com/testuser/gstack-artifacts-testuser' });
    const r = run(['--host', 'github']);
    expect(r.status).toBe(0);
    const remoteFile = path.join(tmpHome, '.gstack-artifacts-remote.txt');
    expect(fs.existsSync(remoteFile)).toBe(true);
    const stored = fs.readFileSync(remoteFile, 'utf-8').trim();
    // HTTPS, NOT SSH (codex Finding #10: canonical = HTTPS).
    expect(stored).toMatch(/^https:\/\//);
    expect(stored).toBe('https://github.com/testuser/gstack-artifacts-testuser');
  });

  test('strips trailing .git from gh repo view output', () => {
    makeFakeGh({ webUrl: 'https://github.com/testuser/gstack-artifacts-testuser.git' });
    const r = run(['--host', 'github']);
    expect(r.status).toBe(0);
    const stored = fs.readFileSync(path.join(tmpHome, '.gstack-artifacts-remote.txt'), 'utf-8').trim();
    expect(stored).toBe('https://github.com/testuser/gstack-artifacts-testuser');
  });

  test('configures git origin with SSH form (derived from canonical HTTPS)', () => {
    makeFakeGh({ webUrl: 'https://github.com/testuser/gstack-artifacts-testuser' });
    const r = run(['--host', 'github']);
    expect(r.status).toBe(0);
    const remote = spawnSync('git', ['-C', tmpHome, 'remote', 'get-url', 'origin'], { encoding: 'utf-8' });
    expect(remote.stdout.trim()).toBe('git@github.com:testuser/gstack-artifacts-testuser.git');
  });
});

describe('gstack-artifacts-init brain-admin hookup printout (codex Finding #3)', () => {
  test('--url-form-supported false prints the two-line clone-then-path form', () => {
    makeFakeGh({});
    const r = run(['--host', 'github', '--url-form-supported', 'false']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Send this to your brain admin');
    expect(r.stdout).toContain('git clone');
    expect(r.stdout).toContain('--path');
    expect(r.stdout).toContain('--federated');
    // The forward-compat hint should still appear.
    expect(r.stdout).toContain('When gbrain ships --url support');
  });

  test('--url-form-supported true prints the one-liner with --url', () => {
    makeFakeGh({});
    const r = run(['--host', 'github', '--url-form-supported', 'true']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Send this to your brain admin');
    expect(r.stdout).toContain('gbrain sources add gstack-artifacts-testuser --url');
    expect(r.stdout).not.toContain('git clone');
  });

  test('the gbrain command line uses canonical HTTPS, not SSH', () => {
    makeFakeGh({ webUrl: 'https://github.com/testuser/gstack-artifacts-testuser' });
    const r = run(['--host', 'github', '--url-form-supported', 'true']);
    expect(r.status).toBe(0);
    // Find the line with the gbrain command and check ITS URL is HTTPS.
    const gbrainLine = r.stdout
      .split('\n')
      .find((l) => l.includes('gbrain sources add'));
    expect(gbrainLine).toBeDefined();
    expect(gbrainLine).toContain('https://github.com/testuser/gstack-artifacts-testuser');
    expect(gbrainLine).not.toContain('git@github.com');
    // Note: the SSH form does appear in the printout as informational
    // (the "Push: ..." line), which is intentional — that's the URL git
    // actually uses for push.
  });
});

describe('gstack-artifacts-init idempotency', () => {
  test('--remote <url> bypasses provider selection entirely', () => {
    makeFakeGh({});
    const r = run(['--remote', 'https://github.com/testuser/gstack-artifacts-testuser']);
    expect(r.status).toBe(0);
    // gh auth was checked (still useful for provider detection) but no repo create.
    expect(readCalls(ghCallLog).some((c) => c.startsWith('gh repo create'))).toBe(false);
  });

  test('re-run with same --remote is safe (no conflict error)', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    run(['--remote', url]);
    const r2 = run(['--remote', url]);
    expect(r2.status).toBe(0);
  });

  test('re-run with DIFFERENT --remote exits 1 with conflict message', () => {
    makeFakeGh({});
    run(['--remote', 'https://github.com/testuser/gstack-artifacts-testuser']);
    const r2 = run(['--remote', 'https://github.com/other/repo']);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain('already a git repo');
  });
});
