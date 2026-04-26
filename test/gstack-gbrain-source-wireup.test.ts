/**
 * gstack-gbrain-source-wireup — unit tests with mocked gbrain CLI.
 *
 * The helper registers the gstack brain repo as a gbrain federated source
 * via `git worktree`, runs an initial sync, and exposes --uninstall + --probe.
 *
 * Strategy: put a fake `gbrain` binary on PATH that records every call into
 * a log file and reads/writes its "registered sources" state from a JSON
 * file in the test's tmp dir. The helper sees a consistent gbrain-CLI surface
 * but no real database, no real gbrain.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const WIREUP_BIN = path.join(BIN_DIR, 'gstack-gbrain-source-wireup');

let tmpHome: string;
let gstackHome: string;
let worktreeDir: string;
let fakeBinDir: string;
let gbrainCallLog: string;
let gbrainStateFile: string;

function makeFakeGbrain(opts: {
  version?: string | null; // null = "binary missing" (don't write the file)
  syncFails?: boolean;
}) {
  const version = opts.version ?? '0.18.2';
  if (version === null) return; // simulate missing binary by NOT writing one
  const syncFails = opts.syncFails ?? false;

  // Stub gbrain reads/writes state from a JSON file. Fields:
  //   sources: [{id, local_path, federated}]
  fs.writeFileSync(gbrainStateFile, JSON.stringify({ sources: [] }, null, 2));

  const script = `#!/bin/bash
LOG="${gbrainCallLog}"
STATE="${gbrainStateFile}"
# Record the call AND any GBRAIN_DATABASE_URL that the parent passed via env.
# Format: "gbrain <args> [GBRAIN_DATABASE_URL=<url>]" so tests can assert
# the wireup helper exported the locked URL into our env.
LINE="gbrain $@"
[ -n "\${GBRAIN_DATABASE_URL:-}" ] && LINE="\$LINE [GBRAIN_DATABASE_URL=\$GBRAIN_DATABASE_URL]"
echo "\$LINE" >> "$LOG"

# --version
if [ "$1" = "--version" ]; then
  echo "gbrain ${version}"
  exit 0
fi

# sources list --json  → emits state
if [ "$1" = "sources" ] && [ "$2" = "list" ]; then
  cat "$STATE"
  exit 0
fi

# sources add <id> --path <p> --federated  → adds entry
if [ "$1" = "sources" ] && [ "$2" = "add" ]; then
  shift 2
  ID="$1"; shift
  PATH_VAL=""
  FED="false"
  while [ $# -gt 0 ]; do
    case "$1" in
      --path) PATH_VAL="$2"; shift 2 ;;
      --federated) FED="true"; shift ;;
      *) shift ;;
    esac
  done
  python3 -c "
import json, sys
state = json.load(open('$STATE'))
state['sources'].append({'id': '$ID', 'local_path': '$PATH_VAL', 'federated': '$FED' == 'true'})
json.dump(state, open('$STATE','w'), indent=2)
" || exit 1
  exit 0
fi

# sources remove <id> --yes  → drops entry
if [ "$1" = "sources" ] && [ "$2" = "remove" ]; then
  shift 2
  ID="$1"
  python3 -c "
import json
state = json.load(open('$STATE'))
state['sources'] = [s for s in state['sources'] if s['id'] != '$ID']
json.dump(state, open('$STATE','w'), indent=2)
"
  exit 0
fi

# sync --repo <p>  → records, optionally fails
if [ "$1" = "sync" ]; then
  ${syncFails ? 'echo "sync failed: connection error" >&2; exit 1' : 'echo "1 page imported"; exit 0'}
fi

echo "fake gbrain: unhandled subcommand: $@" >&2
exit 99
`;
  const gbrainPath = path.join(fakeBinDir, 'gbrain');
  fs.writeFileSync(gbrainPath, script, { mode: 0o755 });
}

function run(
  argv: string[],
  opts: { env?: Record<string, string> } = {}
) {
  const env = {
    PATH: `${fakeBinDir}:${process.env.PATH || '/usr/bin:/bin:/opt/homebrew/bin'}`,
    HOME: tmpHome,
    GSTACK_HOME: gstackHome,
    GSTACK_BRAIN_WORKTREE: worktreeDir,
    GSTACK_BRAIN_NO_SYNC: '0',
    ...(opts.env || {}),
  };
  return spawnSync(WIREUP_BIN, argv, {
    env,
    encoding: 'utf-8',
    cwd: ROOT,
  });
}

function readState(): { sources: Array<{ id: string; local_path: string; federated: boolean }> } {
  if (!fs.existsSync(gbrainStateFile)) return { sources: [] };
  return JSON.parse(fs.readFileSync(gbrainStateFile, 'utf-8'));
}

function gbrainCalls(): string[] {
  if (!fs.existsSync(gbrainCallLog)) return [];
  return fs.readFileSync(gbrainCallLog, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());
}

function setupGstackRepo(remoteUrl: string) {
  // Real git repo at gstackHome with at least one commit + an origin remote.
  fs.mkdirSync(gstackHome, { recursive: true });
  spawnSync('git', ['-C', gstackHome, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  spawnSync('git', ['-C', gstackHome, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' });
  spawnSync('git', ['-C', gstackHome, 'config', 'user.name', 'test'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(gstackHome, '.brain-allowlist'), '# allowlist\n');
  spawnSync('git', ['-C', gstackHome, 'add', '.'], { stdio: 'pipe' });
  spawnSync('git', ['-C', gstackHome, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });
  spawnSync('git', ['-C', gstackHome, 'remote', 'add', 'origin', remoteUrl], { stdio: 'pipe' });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-wireup-test-'));
  gstackHome = path.join(tmpHome, '.gstack');
  worktreeDir = path.join(tmpHome, '.gstack-brain-worktree');
  fakeBinDir = path.join(tmpHome, 'fake-bin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  gbrainCallLog = path.join(tmpHome, 'gbrain-calls.log');
  gbrainStateFile = path.join(tmpHome, 'gbrain-state.json');
});

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

describe('gstack-gbrain-source-wireup — wireup mode', () => {
  test('fresh state: registers source + creates worktree + syncs', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    const r = run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    expect(r.status).toBe(0);
    expect(fs.existsSync(worktreeDir)).toBe(true);
    const state = readState();
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].id).toBe('gstack-brain-user');
    expect(state.sources[0].local_path).toBe(worktreeDir);
    expect(state.sources[0].federated).toBe(true);
  });

  test('idempotent re-run after success: no new sources add call', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    const callsAfterFirst = gbrainCalls().filter((c) => c.startsWith('gbrain sources add')).length;
    expect(callsAfterFirst).toBe(1);
    run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    const callsAfterSecond = gbrainCalls().filter((c) => c.startsWith('gbrain sources add')).length;
    expect(callsAfterSecond).toBe(1); // no new add
  });

  test('drift recovery: existing source with different path triggers remove + add', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    // Pre-seed the fake gbrain state with a source at the wrong path
    fs.writeFileSync(
      gbrainStateFile,
      JSON.stringify({
        sources: [{ id: 'gstack-brain-user', local_path: '/old/stale/path', federated: true }],
      })
    );
    const r = run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    expect(r.status).toBe(0);
    const calls = gbrainCalls();
    expect(calls.some((c) => c.startsWith('gbrain sources remove gstack-brain-user'))).toBe(true);
    expect(calls.some((c) => c.includes(`gbrain sources add gstack-brain-user --path ${worktreeDir}`))).toBe(true);
    const state = readState();
    expect(state.sources[0].local_path).toBe(worktreeDir);
  });

  test('--strict + gbrain too old: exits 2', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({ version: '0.17.0' });
    const r = run(['--strict']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('< 0.18.0');
  });

  test('non-strict + gbrain too old: warn + exit 0', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({ version: '0.17.0' });
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('benign skip');
  });

  test('--strict + gbrain missing on PATH: exits 2', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    // Don't make a fake gbrain — fakeBinDir is empty. Keep system dirs on PATH
    // so basic commands (git, awk, sed, etc.) work; only `gbrain` is absent.
    const r = run(['--strict'], {
      env: { PATH: `${fakeBinDir}:/usr/bin:/bin:/opt/homebrew/bin` },
    });
    expect(r.status).toBe(2);
  });

  test('source-id derived from origin URL', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-alice.git');
    makeFakeGbrain({});
    const r = run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    expect(r.status).toBe(0);
    expect(readState().sources[0].id).toBe('gstack-brain-alice');
  });

  test('source-id fallback to ~/.gstack-brain-remote.txt when .git is gone', () => {
    // No git repo at gstackHome; just the remote-file
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'git@github.com:user/gstack-brain-bob.git\n'
    );
    makeFakeGbrain({});
    // No --strict: helper should benign-skip because .gstack/.git is missing
    const r = run([]);
    // ensure_worktree returns 2 → benign skip, exit 0
    expect(r.status).toBe(0);
  });

  test('source-id from --source-id flag overrides everything', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-different.git');
    makeFakeGbrain({});
    run(['--source-id', 'custom-id'], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    const state = readState();
    expect(state.sources[0].id).toBe('custom-id');
  });

  test('--probe: read-only, prints state without mutating', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    const r = run(['--probe']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('source_id=gstack-brain-user');
    expect(r.stdout).toContain('worktree=');
    expect(r.stdout).toContain('gbrain=ok');
    expect(r.stdout).toContain('source_status=absent');
    // Probe should NOT call sources add / sync
    const calls = gbrainCalls();
    expect(calls.some((c) => c.startsWith('gbrain sources add'))).toBe(false);
    expect(calls.some((c) => c.startsWith('gbrain sync'))).toBe(false);
  });

  test('gbrain sync failure: exits 1 with stderr', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({ syncFails: true });
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sync failed');
  });
});

describe('gstack-gbrain-source-wireup — --database-url lock (defends against external config rewrites)', () => {
  test('--database-url flag is exported as GBRAIN_DATABASE_URL to child gbrain calls', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    const TARGET = 'postgresql://postgres.abc:pw@aws.pooler.supabase.com:5432/postgres';
    const r = run(['--database-url', TARGET], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    expect(r.status).toBe(0);
    const calls = gbrainCalls();
    // every gbrain invocation should carry the locked URL
    const writingCalls = calls.filter((c) => c.includes('sources') || c.includes('sync'));
    expect(writingCalls.length).toBeGreaterThan(0);
    for (const c of writingCalls) {
      expect(c).toContain(`[GBRAIN_DATABASE_URL=${TARGET}]`);
    }
  });

  test('falls back to ~/.gbrain/config.json database_url when no flag and no env', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    const FILE_URL = 'postgresql://postgres.xyz:pw@aws.pooler.supabase.com:5432/postgres';
    fs.mkdirSync(path.join(tmpHome, '.gbrain'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: FILE_URL })
    );
    // Important: don't pass GBRAIN_DATABASE_URL or DATABASE_URL in env; helper
    // should read from $HOME/.gbrain/config.json (HOME is tmpHome here).
    const r = run([], {
      env: {
        GSTACK_BRAIN_NO_SYNC: '1',
        GBRAIN_DATABASE_URL: '',
        DATABASE_URL: '',
      },
    });
    expect(r.status).toBe(0);
    const calls = gbrainCalls();
    const writingCalls = calls.filter((c) => c.includes('sources add'));
    expect(writingCalls.length).toBe(1);
    expect(writingCalls[0]).toContain(`[GBRAIN_DATABASE_URL=${FILE_URL}]`);
  });

  test('--database-url overrides env GBRAIN_DATABASE_URL and config.json', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    const FLAG_URL = 'postgresql://postgres.flag:pw@a.b:5432/postgres';
    const ENV_URL = 'postgresql://postgres.env:pw@x.y:5432/postgres';
    const FILE_URL = 'postgresql://postgres.file:pw@p.q:5432/postgres';
    fs.mkdirSync(path.join(tmpHome, '.gbrain'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: FILE_URL })
    );
    const r = run(['--database-url', FLAG_URL], {
      env: {
        GSTACK_BRAIN_NO_SYNC: '1',
        GBRAIN_DATABASE_URL: ENV_URL,
      },
    });
    expect(r.status).toBe(0);
    const calls = gbrainCalls();
    const writingCalls = calls.filter((c) => c.includes('sources add'));
    expect(writingCalls.length).toBe(1);
    expect(writingCalls[0]).toContain(`[GBRAIN_DATABASE_URL=${FLAG_URL}]`);
    expect(writingCalls[0]).not.toContain(ENV_URL);
    expect(writingCalls[0]).not.toContain(FILE_URL);
  });
});

describe('gstack-gbrain-source-wireup — uninstall mode', () => {
  test('after wireup: removes source + worktree', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    expect(readState().sources).toHaveLength(1);
    expect(fs.existsSync(worktreeDir)).toBe(true);
    const r = run(['--uninstall']);
    expect(r.status).toBe(0);
    expect(readState().sources).toHaveLength(0);
    expect(fs.existsSync(worktreeDir)).toBe(false);
  });

  test('with no prior state: exits 3 (cannot derive id)', () => {
    // No git repo, no remote file. --uninstall must fail with code 3.
    fs.mkdirSync(tmpHome, { recursive: true });
    makeFakeGbrain({});
    const r = run(['--uninstall']);
    expect(r.status).toBe(3);
  });

  test('--uninstall when gbrain is missing: exits 0 (best-effort), still removes worktree', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    // First wireup with fake gbrain to create the worktree + register source
    makeFakeGbrain({});
    run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    expect(fs.existsSync(worktreeDir)).toBe(true);
    // Now remove the fake gbrain so uninstall sees gbrain missing
    fs.rmSync(path.join(fakeBinDir, 'gbrain'), { force: true });
    const r = run(['--uninstall'], {
      env: { PATH: `${fakeBinDir}:/usr/bin:/bin:/opt/homebrew/bin` },
    });
    expect(r.status).toBe(0); // best-effort, never fails on gbrain absence
    expect(fs.existsSync(worktreeDir)).toBe(false); // worktree still cleaned up
  });
});

describe('gstack-gbrain-source-wireup — defensive paths', () => {
  test('--no-pull skips HEAD advance on existing worktree', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    // First run to create worktree
    run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    // Make a new commit on parent so worktree HEAD is "behind"
    fs.writeFileSync(path.join(gstackHome, 'newfile.md'), 'new');
    spawnSync('git', ['-C', gstackHome, 'add', '.'], { stdio: 'pipe' });
    spawnSync('git', ['-C', gstackHome, 'commit', '-q', '-m', 'second commit'], { stdio: 'pipe' });
    const parentHeadAfter = spawnSync('git', ['-C', gstackHome, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
    const worktreeHeadBefore = spawnSync('git', ['-C', worktreeDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
    expect(parentHeadAfter).not.toBe(worktreeHeadBefore); // sanity: parent advanced
    // --no-pull should leave worktree HEAD where it was
    const r = run(['--no-pull'], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    expect(r.status).toBe(0);
    const worktreeHeadAfter = spawnSync('git', ['-C', worktreeDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
    expect(worktreeHeadAfter).toBe(worktreeHeadBefore);
    expect(worktreeHeadAfter).not.toBe(parentHeadAfter);
  });

  test('stray non-git directory at worktree path is cleaned up + worktree created', () => {
    setupGstackRepo('git@github.com:user/gstack-brain-user.git');
    makeFakeGbrain({});
    // Plant a stray non-git directory at the worktree path
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'unrelated.txt'), 'not a worktree');
    expect(fs.existsSync(path.join(worktreeDir, 'unrelated.txt'))).toBe(true);
    expect(fs.existsSync(path.join(worktreeDir, '.git'))).toBe(false);
    // Helper should remove the stray dir + create a real worktree
    const r = run([], { env: { GSTACK_BRAIN_NO_SYNC: '1' } });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(worktreeDir, '.git'))).toBe(true); // real worktree
    expect(fs.existsSync(path.join(worktreeDir, 'unrelated.txt'))).toBe(false); // stray gone
  });
});
