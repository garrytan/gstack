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

import { describe, test as _test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { canRevokeReads } from './helpers/fs-caps';

// Integration tests spawn real git/gh/glab subprocesses. The default 5s
// per-test timeout is tight on developer machines; raise to 30s to match
// the brain-sync.test.ts pattern. The tests stay deterministic (fake bins,
// no network), but subprocess fork+exec under bun adds non-trivial overhead.
const test = (name: string, fn: any) => _test(name, fn, 30000);

const ROOT = path.resolve(import.meta.dir, '..');
const INIT_BIN = path.join(ROOT, 'bin', 'gstack-artifacts-init');

let tmpHome: string;
let bareRemote: string;
let fakeBinDir: string;
let ghCallLog: string;
let glabCallLog: string;

function makeFakeGh(opts: {
  authStatus?: 'ok' | 'fail';
  repoCreate?: 'success' | 'already-exists' | 'fail';
  webUrl?: string;
  gitProtocol?: 'https' | 'ssh' | 'unset';
} = {}) {
  const authStatus = opts.authStatus ?? 'ok';
  const repoCreate = opts.repoCreate ?? 'success';
  const webUrl = opts.webUrl ?? `https://github.com/testuser/gstack-artifacts-testuser`;
  const gitProtocol = opts.gitProtocol ?? 'https';
  const script = `#!/bin/bash
echo "gh $@" >> "${ghCallLog}"
case "$1" in
  auth) ${authStatus === 'ok' ? 'exit 0' : 'exit 1'} ;;
  config)
    if [ "$2" = "get" ] && [ "$3" = "git_protocol" ]; then
      ${gitProtocol === 'unset' ? 'exit 1' : `echo "${gitProtocol}"; exit 0`}
    fi
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

function makeFakeGlab(opts: {
  authStatus?: 'ok' | 'fail';
  repoCreate?: 'success' | 'fail';
  webUrl?: string;
  gitProtocol?: 'https' | 'ssh' | 'unset';
} = {}) {
  const authStatus = opts.authStatus ?? 'ok';
  const repoCreate = opts.repoCreate ?? 'success';
  const webUrl = opts.webUrl ?? 'https://gitlab.com/testuser/gstack-artifacts-testuser';
  const gitProtocol = opts.gitProtocol ?? 'https';
  const script = `#!/bin/bash
echo "glab $@" >> "${glabCallLog}"
case "$1" in
  auth) ${authStatus === 'ok' ? 'exit 0' : 'exit 1'} ;;
  config)
    if [ "$2" = "get" ] && [ "$3" = "git_protocol" ]; then
      ${gitProtocol === 'unset' ? 'exit 1' : `echo "${gitProtocol}"; exit 0`}
    fi
    ;;
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
  const realGit = spawnSync('which', ['git'], { encoding: 'utf-8', timeout: 30_000 }).stdout.trim();
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
    GIT_CONFIG_NOSYSTEM: '1',
    ...(opts.env || {}),
  };
  const res = spawnSync(INIT_BIN, argv, {
    env,
    encoding: 'utf-8',
    input: opts.input,
    cwd: ROOT,
    timeout: 30_000,
  });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    status: res.status ?? -1,
  };
}

function gitInFixture(argv: string[]) {
  return spawnSync('git', argv, {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function readCalls(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
}

function expectNoAllowlistTemps() {
  expect(fs.readdirSync(tmpHome).filter((name) => name.startsWith('.brain-allowlist.'))).toEqual([]);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-init-'));
  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-bare-'));
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-fake-bin-'));
  ghCallLog = path.join(fakeBinDir, 'gh-calls.log');
  glabCallLog = path.join(fakeBinDir, 'glab-calls.log');
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', bareRemote], { timeout: 30_000 });
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
    makeFakeGh({ authStatus: 'fail' });
    makeFakeGlab({});
    const r = run([]);
    expect(r.status).toBe(0);
    expect(readCalls(glabCallLog).some((c) => c.startsWith('glab repo create'))).toBe(true);
  });

  test('neither authed → falls through to manual URL paste', () => {
    makeFakeGh({ authStatus: 'fail' });
    makeFakeGlab({ authStatus: 'fail' });
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

  test('configures git origin with HTTPS when gh git_protocol is https', () => {
    makeFakeGh({ webUrl: 'https://github.com/testuser/gstack-artifacts-testuser' });
    const r = run(['--host', 'github']);
    expect(r.status).toBe(0);
    const remote = gitInFixture(['-C', tmpHome, 'remote', 'get-url', 'origin']);
    expect(remote.stdout.trim()).toBe('https://github.com/testuser/gstack-artifacts-testuser');
  });

  test('configures git origin with SSH when gh git_protocol is ssh', () => {
    makeFakeGh({
      webUrl: 'https://github.com/testuser/gstack-artifacts-testuser',
      gitProtocol: 'ssh',
    });
    const r = run(['--host', 'github']);
    expect(r.status).toBe(0);
    const remote = gitInFixture(['-C', tmpHome, 'remote', 'get-url', 'origin']);
    expect(remote.stdout.trim()).toBe('git@github.com:testuser/gstack-artifacts-testuser.git');
  });

  test('defaults provider-created remotes to HTTPS when git_protocol is unset', () => {
    makeFakeGh({ gitProtocol: 'unset' });
    const r = run(['--host', 'github']);
    expect(r.status).toBe(0);
    const remote = gitInFixture(['-C', tmpHome, 'remote', 'get-url', 'origin']);
    expect(remote.stdout.trim()).toBe('https://github.com/testuser/gstack-artifacts-testuser');
  });

  test('honors glab git_protocol when configured', () => {
    makeFakeGlab({ gitProtocol: 'ssh' });
    const r = run(['--host', 'gitlab']);
    expect(r.status).toBe(0);
    const remote = gitInFixture(['-C', tmpHome, 'remote', 'get-url', 'origin']);
    expect(remote.stdout.trim()).toBe('git@gitlab.com:testuser/gstack-artifacts-testuser.git');
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
    // The Push line follows the provider CLI preference independently.
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

  test('explicit HTTPS --remote stays HTTPS even when gh prefers SSH', () => {
    makeFakeGh({ gitProtocol: 'ssh' });
    const r = run(['--remote', 'https://github.com/testuser/gstack-artifacts-testuser']);
    expect(r.status).toBe(0);
    const remote = gitInFixture(['-C', tmpHome, 'remote', 'get-url', 'origin']);
    expect(remote.stdout.trim()).toBe('https://github.com/testuser/gstack-artifacts-testuser');
  });

  test('--push-protocol overrides the inferred protocol', () => {
    makeFakeGh({ gitProtocol: 'https' });
    const r = run([
      '--remote',
      'https://github.com/testuser/gstack-artifacts-testuser',
      '--push-protocol',
      'ssh',
    ]);
    expect(r.status).toBe(0);
    const remote = gitInFixture(['-C', tmpHome, 'remote', 'get-url', 'origin']);
    expect(remote.stdout.trim()).toBe('git@github.com:testuser/gstack-artifacts-testuser.git');
  });

  test('rejects an invalid --push-protocol value', () => {
    makeFakeGh({});
    const r = run(['--push-protocol', 'ftp']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('expected auto|https|ssh');
  });

  test('re-run with same --remote is safe (no conflict error)', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    run(['--remote', url]);
    const r2 = run(['--remote', url]);
    expect(r2.status).toBe(0);
  });

  test('re-run preserves the user allowlist suffix byte-for-byte', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    const marker = '# ---- USER ADDITIONS BELOW ---- (survives re-init; above is managed)\n';
    const suffix = '\n# user comment\n\ncustom/path-*.jsonl';
    const original = fs.readFileSync(allowlist, 'utf-8');
    fs.writeFileSync(allowlist, original.replace('projects/*/timeline.jsonl', 'projects/*/stale-managed-path.jsonl'));
    fs.chmodSync(allowlist, 0o600);
    fs.appendFileSync(allowlist, suffix);

    expect(run(['--remote', url]).status).toBe(0);
    const updated = fs.readFileSync(allowlist);
    expect(updated.subarray(updated.indexOf(marker) + Buffer.byteLength(marker))).toEqual(Buffer.from(suffix));
    expect(updated.toString().split(marker).length - 1).toBe(1);
    expect(updated.toString()).toContain('projects/*/timeline.jsonl');
    expect(updated.toString()).not.toContain('projects/*/stale-managed-path.jsonl');
    expect(fs.statSync(allowlist).mode & 0o777).toBe(0o600);
    expectNoAllowlistTemps();
  });

  test('empty allowlist is initialized with only the current managed rules', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    fs.writeFileSync(allowlist, '');

    expect(run(['--remote', url]).status).toBe(0);
    const updated = fs.readFileSync(allowlist, 'utf-8');
    expect(updated).toContain('projects/*/timeline.jsonl');
    expect(updated.split('# ---- USER ADDITIONS BELOW ----').length - 1).toBe(1);
    expectNoAllowlistTemps();
  });

  test('marker-only file without a final newline is refreshed without duplication', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    const marker = '# ---- USER ADDITIONS BELOW ---- (survives re-init; above is managed)';
    fs.writeFileSync(allowlist, marker);

    expect(run(['--remote', url]).status).toBe(0);
    const updated = fs.readFileSync(allowlist, 'utf-8');
    expect(updated.split(marker).length - 1).toBe(1);
    expect(updated.endsWith('\n')).toBe(true);
    expectNoAllowlistTemps();
  });

  test('duplicate managed markers are refused without changing the file', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    const original = fs.readFileSync(allowlist);
    fs.appendFileSync(allowlist, original.subarray(original.indexOf(Buffer.from('# ---- USER ADDITIONS BELOW ----'))));
    const ambiguous = fs.readFileSync(allowlist);

    const r = run(['--remote', url]);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(allowlist)).toEqual(ambiguous);
    expectNoAllowlistTemps();
  });

  test('markerless legacy allowlist is retained and re-init refuses ambiguity', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    const legacy = Buffer.from('# user rules\ncustom/legacy.jsonl');
    fs.writeFileSync(allowlist, legacy);

    const r = run(['--remote', url]);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(allowlist)).toEqual(legacy);
    expectNoAllowlistTemps();
  });

  test('failed allowlist replacement leaves the old file intact', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    fs.appendFileSync(allowlist, '\ncustom/failure-control.jsonl');
    const previous = fs.readFileSync(allowlist);
    const fakeMv = path.join(fakeBinDir, 'mv');
    fs.writeFileSync(fakeMv, `#!/bin/bash\nlast=\"\"\nfor arg in \"$@\"; do last=\"$arg\"; done\nif [ \"$last\" = \"$GSTACK_HOME/.brain-allowlist\" ]; then exit 73; fi\nexec /bin/mv \"$@\"\n`, { mode: 0o755 });

    const r = run(['--remote', url]);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(allowlist)).toEqual(previous);
    expectNoAllowlistTemps();
  });

  test('allowlist read failure leaves the old file intact', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    fs.appendFileSync(allowlist, '\ncustom/read-failure-control.jsonl');
    const previous = fs.readFileSync(allowlist);
    const fakeGrep = path.join(fakeBinDir, 'grep');
    fs.writeFileSync(fakeGrep, `#!/bin/bash\nfor arg in \"$@\"; do if [ \"$arg\" = \"$GSTACK_HOME/.brain-allowlist\" ]; then exit 2; fi; done\nexec /bin/grep \"$@\"\n`, { mode: 0o755 });

    const r = run(['--remote', url]);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(allowlist)).toEqual(previous);
    expectNoAllowlistTemps();
  });

  _test.skipIf(!canRevokeReads())('real unreadable allowlist is preserved when chmod blocks reads', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    fs.appendFileSync(allowlist, '\ncustom/unreadable-control.jsonl');
    const previous = fs.readFileSync(allowlist);
    fs.chmodSync(allowlist, 0);

    try {
      const r = run(['--remote', url]);
      expect(r.status).not.toBe(0);
      expectNoAllowlistTemps();
    } finally {
      fs.chmodSync(allowlist, 0o600);
    }
    expect(fs.readFileSync(allowlist)).toEqual(previous);
  }, 30_000);

  test('partial allowlist assembly failure preserves the original and cleans temporary files', () => {
    makeFakeGh({});
    const url = 'https://github.com/testuser/gstack-artifacts-testuser';
    expect(run(['--remote', url]).status).toBe(0);
    const allowlist = path.join(tmpHome, '.brain-allowlist');
    fs.appendFileSync(allowlist, '\ncustom/assembly-failure-control.jsonl');
    const previous = fs.readFileSync(allowlist);
    const fakeCat = path.join(fakeBinDir, 'cat');
    fs.writeFileSync(fakeCat, [
      '#!/bin/bash',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    "$GSTACK_HOME"/.brain-allowlist.*)',
      '      if /bin/grep -qF \'# Canonical allowlist of paths that gstack-brain-sync will publish.\' "$arg"; then /bin/head -c 32 "$arg"; exit 73; fi',
      '      ;;',
      '  esac',
      'done',
      'exec /bin/cat "$@"',
      '',
    ].join('\n'), { mode: 0o755 });

    const r = run(['--remote', url]);
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(allowlist)).toEqual(previous);
    expectNoAllowlistTemps();
  });

  test('re-run with DIFFERENT --remote exits 1 with conflict message', () => {
    makeFakeGh({});
    run(['--remote', 'https://github.com/testuser/gstack-artifacts-testuser']);
    const r2 = run(['--remote', 'https://github.com/other/repo']);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain('already a git repo');
  });
});
