import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { spawn, spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = process.cwd();
const HELPER = join(REPO_ROOT, 'bin', 'gstack-gbrain-capability-check');

let root: string;
let fixtureRepo: string;
let fakeGbrain: string;
let slugFile: string;
let callLog: string;
let sourceIdFile: string;
let sourcePathFile: string;
let putReadyFile: string;
let autopilotActiveFile: string;
let versionCountFile: string;
let markerFile: string;
let fixtureHelper: string;

function git(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: fixtureRepo,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function status(): string {
  return git(['status', '--short']);
}

function helperEnv(mode: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GBRAIN_BIN: fakeGbrain,
    BUN_BIN: process.execPath,
    GBRAIN_HOME: root,
    GSTACK_HOME: join(root, 'gstack-state'),
    GSTACK_GBRAIN_CAPABILITY_RETRY_DELAY_SECONDS: '0',
    FIXTURE_MODE: mode,
    FIXTURE_REPO: fixtureRepo,
    FIXTURE_SLUG_FILE: slugFile,
    FIXTURE_CALL_LOG: callLog,
    FIXTURE_SOURCE_ID_FILE: sourceIdFile,
    FIXTURE_SOURCE_PATH_FILE: sourcePathFile,
    FIXTURE_PUT_READY_FILE: putReadyFile,
    FIXTURE_AUTOPILOT_ACTIVE_FILE: autopilotActiveFile,
    FIXTURE_VERSION_COUNT_FILE: versionCountFile,
    FIXTURE_MARKER_FILE: markerFile,
    FIXTURE_EXPECT_DATABASE_ROUTING_CLEARED: '1',
    FIXTURE_EXPECT_OUTSIDE_PROJECT_CWD: '1',
  };
}

function runHelper(mode: string) {
  return spawnSync(fixtureHelper, [], {
    cwd: fixtureRepo,
    encoding: 'utf8',
    env: helperEnv(mode),
  });
}

function sourcePath(): string {
  return readFileSync(sourcePathFile, 'utf8').trim();
}

function generatedPath(): string {
  const slug = readFileSync(slugFile, 'utf8').trim();
  return join(sourcePath(), `${slug}.md`);
}

function writeThinClientConfig(layout: 'current' | 'legacy' = 'current'): void {
  if (layout === 'legacy') {
    rmSync(join(root, '.gbrain', 'config.json'), { force: true });
  }
  const dir = layout === 'current' ? join(root, '.gbrain') : root;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      engine: 'postgres',
      remote_mcp: {
        mcp_url: 'https://brain.example.invalid/mcp',
        issuer_url: 'https://brain.example.invalid',
      },
    }),
  );
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gstack-gbrain-capability-test-'));
  fixtureRepo = join(root, 'repo');
  mkdirSync(fixtureRepo);
  slugFile = join(root, 'slug');
  callLog = join(root, 'calls.log');
  sourceIdFile = join(root, 'source-id');
  sourcePathFile = join(root, 'source-path');
  putReadyFile = join(root, 'put-ready');
  autopilotActiveFile = join(root, 'autopilot-active');
  versionCountFile = join(root, 'version-count');
  markerFile = join(root, 'put-marker');
  fakeGbrain = join(root, 'fake-gbrain');
  mkdirSync(join(root, '.gbrain'), { recursive: true });
  writeFileSync(
    join(root, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite') }),
  );
  const fixtureInstall = join(root, 'gstack-install');
  const fixtureBin = join(fixtureInstall, 'bin');
  const fixtureLib = join(fixtureInstall, 'lib');
  mkdirSync(fixtureBin, { recursive: true });
  cpSync(join(REPO_ROOT, 'lib'), fixtureLib, { recursive: true });
  fixtureHelper = join(fixtureBin, 'gstack-gbrain-capability-check');
  writeFileSync(fixtureHelper, readFileSync(HELPER));
  chmodSync(fixtureHelper, 0o755);
  writeFileSync(
    join(fixtureLib, 'gbrain-guards.ts'),
    `import { existsSync } from 'fs';
export function detectAutopilot(env: NodeJS.ProcessEnv) {
  return existsSync(env.FIXTURE_AUTOPILOT_ACTIVE_FILE ?? '')
    ? { active: true, signal: 'fixture:autopilot' }
    : { active: false, signal: null };
}
export function gbrainSourceRemoveConfirmationArgsForIdentity(identity: string) {
  const match = identity.match(/\\b(\\d+)\\.(\\d+)\\.(\\d+)/);
  if (!match) return ['--confirm-destructive'];
  const version = match.slice(1, 4).map(Number);
  return version[0] === 0 && (version[1] < 26 || (version[1] === 26 && version[2] < 5))
    ? ['--yes']
    : ['--confirm-destructive'];
}
`,
  );
  writeFileSync(
    fakeGbrain,
    `#!/usr/bin/env bash
set -u
if [ "\${FIXTURE_EXPECT_DATABASE_ROUTING_CLEARED:-0}" = "1" ] && \
   { [ -n "\${DATABASE_URL:-}" ] || [ -n "\${GBRAIN_DATABASE_URL:-}" ]; }; then
  printf 'database-routing-not-cleared\n' >&2
  exit 15
fi
if [ -n "\${FIXTURE_EXPECTED_DATABASE_URL:-}" ] && \
   { [ "\${DATABASE_URL:-}" != "$FIXTURE_EXPECTED_DATABASE_URL" ] || \
     [ "\${GBRAIN_DATABASE_URL:-}" != "$FIXTURE_EXPECTED_DATABASE_URL" ]; }; then
  printf 'wrong-database-url\n' >&2
  exit 15
fi
if [ "\${FIXTURE_EXPECT_OUTSIDE_PROJECT_CWD:-0}" = "1" ]; then
  case "$PWD" in
    "$FIXTURE_REPO"|"$FIXTURE_REPO"/*)
      printf 'project-cwd-not-isolated\n' >&2
      exit 16
      ;;
  esac
fi
cmd="\${1:-}"
if [ "$cmd" = "--version" ]; then
  if [ "\${FIXTURE_MODE:-}" = "autopilot-confirmation-race" ]; then
    count=0
    [ -f "$FIXTURE_VERSION_COUNT_FILE" ] && count=$(cat "$FIXTURE_VERSION_COUNT_FILE")
    count=$((count + 1))
    printf '%s\n' "$count" > "$FIXTURE_VERSION_COUNT_FILE"
    if [ "$count" -eq 2 ]; then : > "$FIXTURE_AUTOPILOT_ACTIVE_FILE"; fi
  fi
  if [ "\${FIXTURE_MODE:-}" = "legacy-confirm-unsupported" ]; then
    echo "gbrain 0.25.9"
  elif [ "\${FIXTURE_MODE:-}" = "unknown-version" ]; then
    echo "gbrain development-build"
  else
    echo "gbrain 0.42.56.0"
  fi
  exit 0
fi
case "$cmd" in
  doctor)
    printf 'doctor\n' >> "$FIXTURE_CALL_LOG"
    if [ "\${FIXTURE_MODE:-}" = "remote-missing-write" ]; then
      printf '%s\n' '{"mode":"thin-client","status":"ok","oauth_scope":"read","checks":[{"name":"oauth_client_scopes_probe","status":"ok","detail":{"granted":"read","read_ok":true,"admin_ok":false}}]}'
    elif [ "\${FIXTURE_MODE:-}" = "remote-admin-only" ]; then
      printf '%s\n' '{"mode":"thin-client","status":"ok","oauth_scope":"admin","checks":[{"name":"oauth_client_scopes_probe","status":"ok","detail":{"granted":"admin","read_ok":true,"admin_ok":true}}]}'
    else
      printf '%s\n' '{"mode":"thin-client","status":"ok","oauth_scope":"read,write,admin","checks":[{"name":"oauth_client_scopes_probe","status":"ok","detail":{"granted":"read,write,admin","read_ok":true,"admin_ok":true}}]}'
    fi
    ;;
  sources)
    sub="\${2:-}"
    case "$sub" in
      add)
        id="$3"
        path=""
        shift 3
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "--path" ]; then path="$2"; shift 2; else shift; fi
        done
        printf 'sources-add:%s\n' "$id" >> "$FIXTURE_CALL_LOG"
        if [ "\${FIXTURE_MODE:-}" = "source-collision" ]; then
          printf '%s\n' "$id" > "$FIXTURE_SOURCE_ID_FILE"
          printf '%s\n' "$FIXTURE_REPO/pre-existing-source" > "$FIXTURE_SOURCE_PATH_FILE"
          exit 6
        fi
        printf '%s\n' "$id" > "$FIXTURE_SOURCE_ID_FILE"
        printf '%s\n' "$path" > "$FIXTURE_SOURCE_PATH_FILE"
        if [ "\${FIXTURE_MODE:-}" = "source-add-late-failure" ]; then exit 7; fi
        ;;
      list)
        if [ "\${FIXTURE_MODE:-}" = "source-list-failure" ]; then exit 13; fi
        if [ "\${FIXTURE_MODE:-}" = "source-list-empty-object" ]; then printf '%s\n' '{}'; exit 0; fi
        if [ "\${FIXTURE_MODE:-}" = "source-list-null" ]; then printf '%s\n' '{"sources":null}'; exit 0; fi
        if [ "\${FIXTURE_MODE:-}" = "source-list-error-envelope" ]; then printf '%s\n' '{"error":"denied"}'; exit 0; fi
        if [ -f "$FIXTURE_SOURCE_ID_FILE" ] && [ -f "$FIXTURE_SOURCE_PATH_FILE" ]; then
          id=$(cat "$FIXTURE_SOURCE_ID_FILE")
          path=$(cat "$FIXTURE_SOURCE_PATH_FILE")
          if [ "\${FIXTURE_MODE:-}" = "bare-array-list" ]; then
            printf '[{"id":"%s","local_path":"%s"}]\n' "$id" "$path"
          else
            printf '{"sources":[{"id":"%s","local_path":"%s"}]}\n' "$id" "$path"
          fi
        else
          if [ "\${FIXTURE_MODE:-}" = "bare-array-list" ]; then
            printf '%s\n' '[]'
          else
            printf '%s\n' '{"sources":[]}'
          fi
        fi
        ;;
      remove)
        id="$3"
        printf 'sources-remove:%s:%s\n' "$id" "\${4:-}" >> "$FIXTURE_CALL_LOG"
        if [ "\${FIXTURE_MODE:-}" = "legacy-confirm-unsupported" ] && [ "\${4:-}" != "--yes" ]; then exit 2; fi
        if [ "\${FIXTURE_MODE:-}" = "unknown-version" ] && [ "\${4:-}" != "--confirm-destructive" ]; then exit 2; fi
        if [ "\${FIXTURE_MODE:-}" = "source-remove-failure" ]; then exit 12; fi
        rm -f "$FIXTURE_SOURCE_ID_FILE"
        ;;
      *) exit 9 ;;
    esac
    ;;
  put)
    slug="$2"
    path=$(cat "$FIXTURE_SOURCE_PATH_FILE")
    marker=$(cat)
    printf '%s\n' "$marker" > "$FIXTURE_MARKER_FILE"
    printf '%s\n' "$slug" > "$FIXTURE_SLUG_FILE"
    printf '%s\n' "$marker" > "$path/$slug.md"
    printf 'put:%s\n' "$slug" >> "$FIXTURE_CALL_LOG"
    if [ "\${FIXTURE_MODE:-}" = "put-block" ]; then
      : > "$FIXTURE_PUT_READY_FILE"
      while :; do sleep 1; done
    fi
    if [ "\${FIXTURE_MODE:-}" = "put-failure-no-json" ]; then exit 7; fi
    printf '{"slug":"%s","write_through":{"written":true,"path":"%s"}}\n' "$slug" "$path/$slug.md"
    ;;
  search)
    if [ "\${FIXTURE_MODE:-}" = "remote-success" ] || [ "\${FIXTURE_MODE:-}" = "remote-missing-write" ] || [ "\${FIXTURE_MODE:-}" = "remote-admin-only" ]; then
      printf 'remote-search\n' >> "$FIXTURE_CALL_LOG"
      exit 0
    fi
    slug=$(cat "$FIXTURE_SLUG_FILE")
    printf 'search:%s\n' "$slug" >> "$FIXTURE_CALL_LOG"
    if [ "\${FIXTURE_MODE:-}" = "search-failure" ]; then exit 8; fi
    if [ "\${FIXTURE_MODE:-}" = "autopilot-race" ]; then : > "$FIXTURE_AUTOPILOT_ACTIVE_FILE"; fi
    printf '[1.0] %s -- probe\n' "$slug"
    ;;
  *)
    exit 9
    ;;
esac
`,
  );
  chmodSync(fakeGbrain, 0o755);

  git(['init', '-q']);
  git(['config', 'user.email', 'gstack-test@example.invalid']);
  git(['config', 'user.name', 'gstack test']);
  writeFileSync(join(fixtureRepo, 'tracked.txt'), 'baseline\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-qm', 'fixture']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('gstack-gbrain-capability-check', () => {
  test('sync-gbrain generated contract delegates to the isolated helper', () => {
    const template = readFileSync(join(REPO_ROOT, 'sync-gbrain', 'SKILL.md.tmpl'), 'utf8');
    const generated = readFileSync(join(REPO_ROOT, 'sync-gbrain', 'SKILL.md'), 'utf8');

    expect(template).toContain('{{BIN_DIR}}/gstack-gbrain-capability-check');
    expect(generated).toContain('bin/gstack-gbrain-capability-check');
    for (const content of [template, generated]) {
      expect(content).not.toContain('gbrain delete "$SLUG"');
      expect(content).not.toContain('gbrain put "$SLUG"');
    }
    expect(readFileSync(HELPER, 'utf8')).toContain('detectAutopilot');
  });

  test('successful local probe uses a private source and restores exact git status', () => {
    writeFileSync(join(fixtureRepo, 'tracked.txt'), 'baseline\npre-existing dirty change\n');
    const before = status();

    const result = runHelper('success');

    expect(result.status).toBe(0);
    expect(status()).toBe(before);
    expect(readFileSync(join(fixtureRepo, 'tracked.txt'), 'utf8')).toContain('pre-existing dirty change');
    expect(readFileSync(callLog, 'utf8')).toContain('sources-add:');
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
    expect(readFileSync(markerFile, 'utf8')).toContain('gstack-capability-probe:_capability_check_');
    expect(existsSync(sourcePath())).toBe(false);
  });

  test('every gbrain command uses the configured database despite inherited and project dotenv conflicts', () => {
    const configuredDatabase = 'postgresql://gbrain.invalid:5432/canonical';
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    writeFileSync(
      join(root, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: configuredDatabase }),
    );
    writeFileSync(
      join(fixtureRepo, '.env.local'),
      'DATABASE_URL=postgresql://project.invalid:5432/wrong-project\n',
    );
    const before = status();

    const result = spawnSync(fixtureHelper, [], {
      cwd: fixtureRepo,
      encoding: 'utf8',
      env: {
        ...helperEnv('success'),
        DATABASE_URL: 'postgresql://caller.invalid:5432/wrong-caller',
        GBRAIN_DATABASE_URL: 'postgresql://caller.invalid:5432/also-wrong',
        FIXTURE_EXPECTED_DATABASE_URL: configuredDatabase,
        FIXTURE_EXPECT_DATABASE_ROUTING_CLEARED: '0',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
    expect(status()).toBe(before);
  });

  test('project dotenv cannot inject GBRAIN_HOME or GSTACK_HOME before isolation', () => {
    const actualHome = join(root, 'actual-home');
    const actualState = join(actualHome, '.gbrain');
    const foreignHome = join(root, 'foreign-brain-parent');
    const foreignState = join(foreignHome, '.gbrain');
    mkdirSync(actualState, { recursive: true });
    mkdirSync(foreignState, { recursive: true });
    writeFileSync(
      join(actualState, 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: join(actualState, 'brain.pglite') }),
    );
    writeFileSync(
      join(foreignState, 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: 'postgresql://foreign.invalid/wrong-brain' }),
    );
    writeFileSync(
      join(fixtureRepo, '.env.local'),
      `GBRAIN_HOME=${foreignHome}\nGSTACK_HOME=${join(fixtureRepo, 'dotenv-gstack-state')}\n`,
    );

    const env = {
      ...helperEnv('success'),
      HOME: actualHome,
    };
    delete env.GBRAIN_HOME;
    delete env.GSTACK_HOME;
    const result = spawnSync(fixtureHelper, [], {
      cwd: fixtureRepo,
      encoding: 'utf8',
      env,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
    expect(existsSync(join(fixtureRepo, 'dotenv-gstack-state'))).toBe(false);
  });

  test('PGLite probe clears hostile caller routing and leaves project dotenv scope', () => {
    writeFileSync(
      join(fixtureRepo, '.env.local'),
      'DATABASE_URL=postgresql://project.invalid:5432/wrong-project\n',
    );
    const before = status();

    const result = spawnSync(fixtureHelper, [], {
      cwd: fixtureRepo,
      encoding: 'utf8',
      env: {
        ...helperEnv('success'),
        DATABASE_URL: 'postgresql://caller.invalid:5432/wrong-caller',
        GBRAIN_DATABASE_URL: 'postgresql://caller.invalid:5432/also-wrong',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
    expect(status()).toBe(before);
  });

  test('missing and malformed active configs fail before any gbrain mutation', () => {
    const configPath = join(root, '.gbrain', 'config.json');
    for (const setup of [
      () => rmSync(configPath, { force: true }),
      () => writeFileSync(configPath, '{broken'),
    ]) {
      setup();
      rmSync(callLog, { force: true });
      const result = spawnSync(fixtureHelper, [], {
        cwd: fixtureRepo,
        encoding: 'utf8',
        env: {
          ...helperEnv('success'),
          DATABASE_URL: 'postgresql://caller.invalid:5432/wrong-caller',
          GBRAIN_DATABASE_URL: 'postgresql://caller.invalid:5432/also-wrong',
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('active gbrain config is missing or malformed');
      expect(existsSync(callLog)).toBe(false);
    }
  });

  test('external-host bin symlink resolves the physical sibling guard module', () => {
    const runtimeRoot = join(root, 'external-runtime');
    mkdirSync(runtimeRoot);
    symlinkSync(join(root, 'gstack-install', 'bin'), join(runtimeRoot, 'bin'));

    const result = spawnSync(join(runtimeRoot, 'bin', 'gstack-gbrain-capability-check'), [], {
      cwd: fixtureRepo,
      encoding: 'utf8',
      env: helperEnv('success'),
    });

    expect(result.status).toBe(0);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
  });

  test('caller TMPDIR inside the checkout cannot receive probe files', () => {
    const result = spawnSync(fixtureHelper, [], {
      cwd: fixtureRepo,
      encoding: 'utf8',
      env: { ...helperEnv('success'), TMPDIR: fixtureRepo },
    });

    expect(result.status).toBe(0);
    expect(sourcePath()).toStartWith(realpathSync(join(root, '.gstack-capability-tmp')));
    expect(sourcePath()).not.toStartWith(fixtureRepo);
    expect(status()).toBe('');
  });

  test('Git-backed GSTACK_HOME keeps probe scratch space outside that repository', () => {
    const stateRoot = join(root, 'gstack-state');
    mkdirSync(stateRoot, { recursive: true });
    const init = spawnSync('git', ['init', '-q'], { cwd: stateRoot, encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);

    const result = runHelper('success');

    expect(result.status, result.stderr).toBe(0);
    expect(sourcePath()).toStartWith(realpathSync(join(root, '.gstack-capability-tmp')));
    expect(sourcePath()).not.toStartWith(realpathSync(stateRoot));
    expect(spawnSync('git', ['status', '--short'], { cwd: stateRoot, encoding: 'utf8' }).stdout).toBe('');
  });

  test('GSTACK_HOME inside the checkout is rejected before creating directories', () => {
    const nestedState = join(fixtureRepo, 'would-dirty-checkout');
    const before = status();
    const result = spawnSync(fixtureHelper, [], {
      cwd: fixtureRepo,
      encoding: 'utf8',
      env: { ...helperEnv('success'), GSTACK_HOME: nestedState },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing temp root inside Git worktree');
    expect(existsSync(nestedState)).toBe(false);
    expect(status()).toBe(before);
  });

  test('failed search removes the temporary source and preserves dirty files', () => {
    writeFileSync(join(fixtureRepo, 'untracked-user-file.txt'), 'keep me\n');
    const before = status();

    const result = runHelper('search-failure');

    expect(result.status).not.toBe(0);
    expect(status()).toBe(before);
    expect(readFileSync(join(fixtureRepo, 'untracked-user-file.txt'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(callLog, 'utf8').match(/search:/g)?.length).toBe(3);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
    expect(existsSync(sourcePath())).toBe(false);
  });

  test('put failure before JSON still cleans its page, source, and temp directory', () => {
    const before = status();

    const result = runHelper('put-failure-no-json');
    const path = generatedPath();

    expect(result.status).not.toBe(0);
    expect(status()).toBe(before);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
  });

  test('late source-add failure is recovered only when id and path match', () => {
    const result = runHelper('source-add-late-failure');
    const path = sourcePath();

    expect(result.status).not.toBe(0);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
    expect(existsSync(path)).toBe(false);
  });

  test('bare-array source readback still removes the owned source and directory', () => {
    const result = runHelper('bare-array-list');
    const path = sourcePath();

    expect(result.status).toBe(0);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
    expect(existsSync(path)).toBe(false);
  });

  test('cleanup uses the v0.20 --yes contract only for a positively identified legacy CLI', () => {
    const result = runHelper('legacy-confirm-unsupported');
    const path = sourcePath();

    expect(result.status).toBe(0);
    expect(readFileSync(callLog, 'utf8').match(/sources-remove:/g)?.length).toBe(1);
    expect(readFileSync(callLog, 'utf8')).toContain(':--yes');
    expect(existsSync(path)).toBe(false);
  });

  test('unknown gbrain identity keeps the current fail-closed remove contract', () => {
    const result = runHelper('unknown-version');
    const path = sourcePath();

    expect(result.status).toBe(0);
    expect(readFileSync(callLog, 'utf8')).toContain(':--confirm-destructive');
    expect(existsSync(path)).toBe(false);
  });

  test('active autopilot refuses before any temporary source is created', () => {
    writeFileSync(autopilotActiveFile, 'active\n');
    const before = status();

    const result = runHelper('success');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('autopilot active');
    expect(status()).toBe(before);
    expect(existsSync(callLog)).toBe(false);
  });

  test('autopilot starting during the probe blocks remove and preserves recovery state', () => {
    const result = runHelper('autopilot-race');
    const path = sourcePath();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('autopilot active');
    expect(readFileSync(callLog, 'utf8')).not.toContain('sources-remove:');
    expect(existsSync(path)).toBe(true);
  });

  test('autopilot starting during the confirmation probe blocks remove', () => {
    const result = runHelper('autopilot-confirmation-race');
    const path = sourcePath();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('autopilot active');
    expect(readFileSync(callLog, 'utf8')).not.toContain('sources-remove:');
    expect(existsSync(path)).toBe(true);
  });

  test('source id collision never removes the pre-existing source', () => {
    const result = runHelper('source-collision');

    expect(result.status).not.toBe(0);
    expect(readFileSync(callLog, 'utf8')).not.toContain('sources-remove:');
    expect(readFileSync(sourcePathFile, 'utf8')).toContain('pre-existing-source');
  });

  test('parent-only SIGTERM terminates the active child before isolated cleanup', async () => {
    const before = status();
    const child = spawn(fixtureHelper, [], {
      cwd: fixtureRepo,
      env: helperEnv('put-block'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForFile(putReadyFile);
    const path = sourcePath();
    process.kill(child.pid ?? 0, 'SIGTERM');
    const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));

    expect(exit).not.toBe(0);
    expect(status()).toBe(before);
    expect(readFileSync(callLog, 'utf8')).toContain('sources-remove:');
    expect(existsSync(path)).toBe(false);
  });

  test('thin-client probe is read-only and accepts live read plus granted write scope', () => {
    writeThinClientConfig();
    const before = status();

    const result = runHelper('remote-success');

    expect(result.status).toBe(0);
    expect(status()).toBe(before);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).toContain('doctor');
    expect(calls).toContain('remote-search');
    expect(calls).not.toContain('sources-add:');
    expect(calls).not.toContain('put:');
  });

  test('stale direct-layout thin-client config is rejected before any remote call', () => {
    writeThinClientConfig('legacy');

    const result = runHelper('remote-success');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(join(root, '.gbrain', 'config.json'));
    expect(existsSync(callLog)).toBe(false);
  });

  test('thin-client probe accepts admin because the gbrain scope lattice implies write', () => {
    writeThinClientConfig();

    const result = runHelper('remote-admin-only');

    expect(result.status).toBe(0);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).toContain('doctor');
    expect(calls).toContain('remote-search');
    expect(calls).not.toContain('sources-add:');
    expect(calls).not.toContain('put:');
  });

  test('thin-client probe fails closed when granted write scope is absent', () => {
    writeThinClientConfig();
    const before = status();

    const result = runHelper('remote-missing-write');

    expect(result.status).not.toBe(0);
    expect(status()).toBe(before);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).toContain('doctor');
    expect(calls).not.toContain('remote-search');
    expect(calls).not.toContain('sources-add:');
    expect(calls).not.toContain('put:');
  });

  test('cleanup failure is surfaced and preserves the recovery directory', () => {
    const result = runHelper('source-remove-failure');
    const path = sourcePath();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed to remove owned temporary source');
    expect(existsSync(path)).toBe(true);
  });

  test('source readback failure fails closed and preserves the recovery directory', () => {
    const result = runHelper('source-list-failure');
    const path = sourcePath();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not verify temporary source cleanup');
    expect(readFileSync(callLog, 'utf8')).not.toContain('sources-remove:');
    expect(existsSync(path)).toBe(true);
  });

  test('unsupported successful source-list JSON fails closed and preserves recovery state', () => {
    for (const mode of [
      'source-list-empty-object',
      'source-list-null',
      'source-list-error-envelope',
    ]) {
      rmSync(callLog, { force: true });
      rmSync(sourceIdFile, { force: true });
      rmSync(sourcePathFile, { force: true });
      const result = runHelper(mode);
      const path = sourcePath();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('could not verify temporary source cleanup');
      expect(readFileSync(callLog, 'utf8')).not.toContain('sources-remove:');
      expect(existsSync(path)).toBe(true);
    }
  });
});
