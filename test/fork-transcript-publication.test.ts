import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scan } from '../lib/redact-engine';

const ROOT = resolve(import.meta.dir, '..');
const BIN = join(ROOT, 'bin');
const TRANSCRIPT = 'transcripts/run-fixture/transcripts/claude-code/project/session.md';
const CURATED = 'projects/project/learnings.jsonl';
let root: string;
let home: string;
let remote: string;

function git(args: string[], cwd = home) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`fixture git failed: ${args[0]} (${result.status})`);
  return result.stdout.trim();
}

function run(bin: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(join(BIN, bin), args, {
    cwd: root,
    env: { ...process.env, HOME: home, GSTACK_HOME: home, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function config(mode?: string) {
  writeFileSync(join(home, 'config.yaml'), `artifacts_sync_mode: full\n${mode === undefined ? '' : `transcript_ingest_mode: ${mode}\n`}`);
}

function write(file: string, text: string | Uint8Array) {
  const target = join(home, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function enqueue(file: string, text: string | Uint8Array) {
  write(file, text);
  expect(run('gstack-brain-enqueue', [file]).status).toBe(0);
}

function page(body: string, extra = '') {
  return `---\ntype: transcript\ngit_remote: github.com/fixture/project\nstart_time: 2026-09-24T00:00:00Z\n${extra}---\n${body}`;
}

function recoveryEnv() {
  const dir = join(root, 'recovery-bin');
  mkdirSync(dir, { recursive: true });
  const realGit = Bun.which('git')!;
  const shim = join(dir, 'git');
  writeFileSync(shim, `#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do\n  if [ "$arg" = '--author=gstack-brain-sync' ]; then arg='--grep=^sync:'; fi\n  args+=("$arg")\ndone\nexec '${realGit}' "\${args[@]}"\n`);
  chmodSync(shim, 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

function scannerEnv(body: string) {
  const dir = join(root, 'scanner-bin');
  mkdirSync(dir, { recursive: true });
  const preload = join(root, 'scanner-preload.ts');
  writeFileSync(preload, `import { mock } from 'bun:test';\nmock.module(${JSON.stringify(join(ROOT, 'lib/redact-engine.ts'))}, () => ({ scan() { ${body} } }));\n`);
  const shim = join(dir, 'bun');
  writeFileSync(shim, `#!/bin/sh\ncase "$1" in\n  */gstack-transcript-publication.ts) exec '${process.execPath}' --preload '${preload}' "$@" ;;\n  *) exec '${process.execPath}' "$@" ;;\nesac\n`);
  chmodSync(shim, 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

function status() {
  return JSON.parse(readFileSync(join(home, '.brain-sync-status.json'), 'utf8'));
}

function queue() {
  return readdirSync(join(home, '.brain-queue.d')).filter(name => name.endsWith('.json')).sort();
}

function hook(name: string, script: string, repo = home) {
  const file = join(repo, repo === remote ? 'hooks' : '.git/hooks', name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

function localCommit(text: string) {
  write(TRANSCRIPT, page(text));
  git(['add', '-f', '--', TRANSCRIPT]);
  const tree = git(['write-tree']);
  const sha = git(['commit-tree', tree, '-p', 'HEAD', '-m', 'fixture transcript']);
  git(['reset', '-q', 'HEAD']);
  return sha;
}

function strand(text = '# safe stranded transcript\n') {
  const reject = hook('pre-receive', 'echo "403 forbidden" >&2\nexit 1', remote);
  enqueue(TRANSCRIPT, page(text));
  expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
  expect(status().status).toBe('push_failed');
  rmSync(reject);
  return git(['rev-parse', 'HEAD']);
}

function advanceRemote() {
  const other = join(root, 'other');
  git(['clone', '-q', remote, other], root);
  git(['config', '--local', 'user.name', 'Publication Fixture'], other);
  git(['config', '--local', 'user.email', 'publication-fixture@example.invalid'], other);
  mkdirSync(join(other, 'retros'), { recursive: true });
  writeFileSync(join(other, 'retros/other.md'), '# Other machine\n');
  git(['add', '-f', '--', 'retros/other.md'], other);
  git(['commit', '-q', '-m', 'fixture remote advance'], other);
  git(['push', '-q', 'origin', 'HEAD'], other);
  return git(['rev-parse', 'HEAD'], remote);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'transcript-pub-'));
  home = join(root, 'home');
  remote = join(root, 'remote.git');
  mkdirSync(home);
  git(['init', '--bare', '-q', '-b', 'main', remote], root);
  expect(run('gstack-artifacts-init', ['--remote', remote]).status).toBe(0);
  git(['config', '--local', 'user.name', 'Publication Fixture']);
  git(['config', '--local', 'user.email', 'publication-fixture@example.invalid']);
  config('incremental');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('transcript Git publication boundary', () => {
  for (const mode of [undefined, 'off', 'unknown']) {
    test(`holds queued transcripts with consent ${mode ?? 'unset'}`, () => {
      config(mode);
      const before = git(['rev-parse', 'HEAD'], remote);
      enqueue(TRANSCRIPT, page('# safe transcript\n'));
      const pending = queue();
      const result = run('gstack-brain-sync', ['--once']);
      expect(result.status).toBe(0);
      expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
      expect(queue()).toEqual(pending);
      expect(readFileSync(join(home, TRANSCRIPT), 'utf8')).toBe(page('# safe transcript\n'));
    }, 30_000);
  }

  test('holds an unsafe intermediate outgoing commit even when the final diff is clean', () => {
    const before = git(['rev-parse', 'HEAD'], remote);
    write(TRANSCRIPT, page('Contact: private.person@private.invalid\n'));
    git(['add', '-f', '--', TRANSCRIPT]);
    git(['commit', '-q', '-m', 'local transcript']);
    const unsafe = git(['rev-parse', 'HEAD']);
    write(TRANSCRIPT, page('# safe replacement\n'));
    git(['add', '-f', '--', TRANSCRIPT]);
    git(['commit', '-q', '-m', 'local replacement']);
    enqueue(CURATED, '{"insight":"safe"}\n');
    const pending = queue();
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
    expect(queue()).toEqual(pending);
    expect(git(['cat-file', '-t', unsafe])).toBe('commit');
    expect(status().status).toBe('blocked');
  }, 30_000);

  test('enabled publication sends exact serialized bytes and records its receipt', () => {
    const serialized = page('# Transcript\nRendered content.\n', 'title: A safe session\n');
    enqueue(TRANSCRIPT, serialized);
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('ok');
    expect(`${git(['show', `HEAD:${TRANSCRIPT}`], remote)}\n`).toBe(serialized);
    expect(queue()).toEqual([]);
    expect(readFileSync(join(home, 'security/egress.jsonl'), 'utf8')).toContain('curated-memory-git-push');
  }, 30_000);

  test('disabled transcripts do not disable independently permitted curated artifacts', () => {
    config('off');
    enqueue(TRANSCRIPT, page('# held transcript\n'));
    const pending = queue();
    enqueue(CURATED, '{"insight":"curated"}\n');
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('ok');
    expect(git(['ls-tree', '-r', '--name-only', 'HEAD'], remote)).toContain(CURATED);
    expect(git(['ls-tree', '-r', '--name-only', 'HEAD'], remote)).not.toContain(TRANSCRIPT);
    expect(queue()).toEqual(pending);
  }, 30_000);

  for (const [name, serialized] of [
    ['HIGH', page('# page\n', `credential: ${'AKIA'}${'Z7M2Q8R4N6W9T3Y5'}\n`)],
    ['MEDIUM', page('# page\n', 'contact: private.person@private.invalid\n')],
    ['empty', ''],
    ['oversized', 'x'.repeat(1024 * 1024 + 1)],
    ['invalid UTF-8', new Uint8Array([0xff, 0xfe])],
    ['NUL', 'safe\0hidden'],
  ] as const) {
    test(`holds ${name} serialized pages before committing without exposing content`, () => {
      const before = git(['rev-parse', 'HEAD']);
      enqueue(TRANSCRIPT, serialized);
      const pending = queue();
      const result = run('gstack-brain-sync', ['--once']);
      expect(result.status).toBe(0);
      expect(status().status).toBe('blocked');
      expect(git(['rev-parse', 'HEAD'])).toBe(before);
      expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
      expect(queue()).toEqual(pending);
      expect(`${result.stdout}${result.stderr}${JSON.stringify(status())}`).not.toContain('Z7M2Q8R4N6W9T3Y5');
      expect(`${result.stdout}${result.stderr}${JSON.stringify(status())}`).not.toContain('private.person@private.invalid');
    }, 30_000);
  }

  test('preserves the shared redactor LOW taxonomy', () => {
      const serialized = page('# Notes\nTODO(alice) fix later\n');
      expect(scan(serialized).counts.LOW).toBeGreaterThan(0);
      enqueue(TRANSCRIPT, serialized);
      expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
      expect(status().status).toBe('ok');
      expect(`${git(['show', `HEAD:${TRANSCRIPT}`], remote)}\n`).toBe(serialized);
    }, 30_000);

  test('preserves WARN-only scanner results without promoting them', () => {
    enqueue(TRANSCRIPT, page('# safe content\n'));
    const env = scannerEnv('return { findings: [{ severity: "WARN" }], counts: { HIGH: 0, MEDIUM: 0, LOW: 0, WARN: 1 }, oversize: false };');
    expect(run('gstack-brain-sync', ['--once'], env).status).toBe(0);
    expect(status().status).toBe('ok');
  }, 30_000);

  test('scans the actual index blob after a clean filter transforms safe worktree bytes', () => {
    const filter = join(root, 'filter.sh');
    writeFileSync(filter, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${page('Contact: private.person@private.invalid\n')}'\n`);
    chmodSync(filter, 0o755);
    git(['config', 'filter.fixture.clean', filter]);
    write('.gitattributes', `${TRANSCRIPT} filter=fixture\n`);
    const before = git(['rev-parse', 'HEAD']);
    enqueue(TRANSCRIPT, page('# safe working file\n'));
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
    expect(readFileSync(join(home, TRANSCRIPT), 'utf8')).toBe(page('# safe working file\n'));
  }, 30_000);

  test('rescans whole modified blobs rather than only changed diff context', () => {
    write(TRANSCRIPT, page(`Contact: private.person@private.invalid\n${'safe line\n'.repeat(100)}`));
    git(['add', '-f', '--', TRANSCRIPT]);
    git(['commit', '-q', '-m', 'fixture previously published page']);
    git(['push', '-q', 'origin', 'HEAD']);
    const before = git(['rev-parse', 'HEAD']);
    enqueue(TRANSCRIPT, `${readFileSync(join(home, TRANSCRIPT), 'utf8')}new final line\n`);
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
  }, 30_000);

  test('disabled consent holds an empty-queue recovery push without rewriting its commit', () => {
    const before = git(['rev-parse', 'HEAD'], remote);
    const stranded = strand();
    config('off');
    expect(queue()).toEqual([]);
    expect(run('gstack-brain-sync', ['--once'], recoveryEnv()).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
    expect(git(['rev-parse', 'HEAD'])).toBe(stranded);
  }, 30_000);

  test('clean stranded transcripts recover when consent remains enabled', () => {
    const stranded = strand();
    expect(run('gstack-brain-sync', ['--once'], recoveryEnv()).status).toBe(0);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(stranded);
  }, 30_000);

  test('pre-commit index substitution invalidates the verdict and preserves pending work', () => {
    const before = git(['rev-parse', 'HEAD'], remote);
    hook('pre-commit', `printf '%s' '${page('Contact: private.person@private.invalid\n')}' > '${TRANSCRIPT}'\ngit add -f -- '${TRANSCRIPT}'`);
    enqueue(TRANSCRIPT, page('# safe page\n'));
    const pending = queue();
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(queue()).toEqual(pending);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
    expect(git(['show', `HEAD:${TRANSCRIPT}`])).toContain('private.person@private.invalid');
  }, 30_000);

  test('post-commit consent revocation blocks the immediate send and preserves the queue', () => {
    const before = git(['rev-parse', 'HEAD'], remote);
    hook('post-commit', "printf 'artifacts_sync_mode: full\\ntranscript_ingest_mode: off\\n' > config.yaml");
    enqueue(TRANSCRIPT, page('# safe page\n'));
    const pending = queue();
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(queue()).toEqual(pending);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
  }, 30_000);

  test('pre-push ref substitution cannot change the exact scanned SHA sent to the expected branch', () => {
    const unsafe = localCommit('Contact: private.person@private.invalid\n');
    hook('pre-push', `git update-ref refs/heads/main '${unsafe}'`);
    enqueue(TRANSCRIPT, page('# safe page\n'));
    const pending = queue();
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(queue()).toEqual(pending);
    expect(git(['rev-parse', 'HEAD'])).toBe(unsafe);
    expect(git(['rev-parse', 'HEAD'], remote)).not.toBe(unsafe);
    expect(`${git(['show', `HEAD:${TRANSCRIPT}`], remote)}\n`).toBe(page('# safe page\n'));
    const hasUnsafe = spawnSync('git', ['-C', remote, 'cat-file', '-e', unsafe], { timeout: 30_000 });
    expect(hasUnsafe.status).not.toBe(0);
  }, 30_000);

  test('revocation after dispatch allows that batch but holds the next one', () => {
    hook('pre-receive', `printf 'artifacts_sync_mode: full\\ntranscript_ingest_mode: off\\n' > '${join(home, 'config.yaml')}'`, remote);
    enqueue(TRANSCRIPT, page('# dispatched page\n'));
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('ok');
    const sent = git(['rev-parse', 'HEAD'], remote);
    enqueue(TRANSCRIPT, page('# next page\n'));
    const pending = queue();
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(sent);
    expect(queue()).toEqual(pending);
  }, 30_000);

  test('symlink transcript objects are held instead of scanning link-target names', () => {
    write('safe.md', '# safe target\n');
    mkdirSync(dirname(join(home, TRANSCRIPT)), { recursive: true });
    symlinkSync(join(home, 'safe.md'), join(home, TRANSCRIPT));
    expect(run('gstack-brain-enqueue', [TRANSCRIPT]).status).toBe(0);
    const before = git(['rev-parse', 'HEAD']);
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
    expect(existsSync(join(home, 'safe.md'))).toBe(true);
  }, 30_000);

  for (const [name, body] of [
    ['throws', 'throw new Error("private scanner exception");'],
    ['malformed result', 'return { counts: {} };'],
  ]) {
    test(`scanner ${name} fails closed with no commit or leaked exception text`, () => {
      const before = git(['rev-parse', 'HEAD']);
      enqueue(TRANSCRIPT, page('# safe content\n'));
      const pending = queue();
      const result = run('gstack-brain-sync', ['--once'], scannerEnv(body));
      expect(result.status).toBe(0);
      expect(status().status).toBe('blocked');
      expect(queue()).toEqual(pending);
      expect(git(['rev-parse', 'HEAD'])).toBe(before);
      expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
      expect(result.stderr).not.toContain('private scanner exception');
    }, 30_000);
  }

  for (const tier of ['deny', 'read-only', 'invalid']) {
    test(`current per-remote ${tier} policy holds queued transcripts`, () => {
      write('gbrain-repo-policy.json', JSON.stringify({ _schema_version: 2, 'github.com/fixture/project': tier }));
      const before = git(['rev-parse', 'HEAD']);
      enqueue(TRANSCRIPT, page('# safe content\n'));
      const pending = queue();
      expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
      expect(status().status).toBe('blocked');
      expect(queue()).toEqual(pending);
      expect(git(['rev-parse', 'HEAD'])).toBe(before);
    }, 30_000);
  }

  test('an explicitly read-write remote retains normal publication', () => {
    write('gbrain-repo-policy.json', JSON.stringify({ _schema_version: 2, 'github.com/fixture/project': 'read-write' }));
    enqueue(TRANSCRIPT, page('# safe content\n'));
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('ok');
  }, 30_000);

  for (const enrollment of [
    { remote: 'github.com/fixture/other', since: null },
    { remote: null, since: '2026-09-25T00:00:00Z' },
    { remote: null, since: 'not-a-time' },
    null,
  ]) {
    test(`enrollment holds outside or malformed scope ${JSON.stringify(enrollment)}`, () => {
      write('.transcript-ingest-state.json', JSON.stringify({ schema_version: 1, sessions: {}, enrollment }));
      const before = git(['rev-parse', 'HEAD']);
      enqueue(TRANSCRIPT, page('# safe content\n'));
      expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
      expect(status().status).toBe('blocked');
      expect(git(['rev-parse', 'HEAD'])).toBe(before);
      expect(queue().length).toBe(1);
    }, 30_000);
  }

  test('an in-scope timestamp at the enrollment boundary is accepted', () => {
    write('.transcript-ingest-state.json', JSON.stringify({ schema_version: 1, sessions: {}, enrollment: { remote: 'github.com/fixture/project', since: '2026-09-24T00:00:00Z' } }));
    enqueue(TRANSCRIPT, page('# safe content\n'));
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('ok');
  }, 30_000);

  for (const [name, serialized] of [
    ['missing', '# old unmapped page\n'],
    ['ambiguous', page('# safe content\n', '"git_remote": github.com/fixture/other\n')],
    ['wrong type', page('# safe content\n').replace('type: transcript', 'type: learning')],
    ['invalid time', page('# safe content\n').replace('2026-09-24T00:00:00Z', 'yesterday')],
  ]) {
    test(`holds ${name} source metadata rather than trusting an older staged file`, () => {
      const before = git(['rev-parse', 'HEAD']);
      enqueue(TRANSCRIPT, serialized);
      expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
      expect(status().status).toBe('blocked');
      expect(git(['rev-parse', 'HEAD'])).toBe(before);
      expect(queue().length).toBe(1);
    }, 30_000);
  }

  test('curated staged pages retain independent consent when transcript ingestion is disabled', () => {
    config('off');
    const file = 'transcripts/run-fixture/learnings/project/entry.md';
    enqueue(file, '---\ntype: learning\n---\n# Curated memory\n');
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('ok');
    expect(git(['ls-tree', '-r', '--name-only', 'HEAD'], remote)).toContain(file);
  }, 30_000);

  test('private source-mapping controls cannot leave through an unexpected pre-staged entry', () => {
    const file = 'transcripts/run-fixture/.gstack-pages.json';
    write(file, '[]');
    git(['add', '-f', '--', file]);
    const before = git(['rev-parse', 'HEAD']);
    enqueue(CURATED, '{"insight":"safe"}\n');
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
    expect(queue().length).toBe(1);
  }, 30_000);

  test('scans secret blobs that a later unsent commit deletes entirely', () => {
    const before = git(['rev-parse', 'HEAD'], remote);
    write(TRANSCRIPT, page('Contact: private.person@private.invalid\n'));
    git(['add', '-f', '--', TRANSCRIPT]);
    git(['commit', '-q', '-m', 'fixture old transcript']);
    git(['rm', '-q', '--', TRANSCRIPT]);
    git(['commit', '-q', '-m', 'fixture removed transcript']);
    enqueue(CURATED, '{"insight":"safe"}\n');
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
    expect(queue().length).toBe(1);
  }, 30_000);

  test('a changed remote ref is fetched and merged without overwriting remote history', () => {
    const advanced = advanceRemote();
    enqueue(TRANSCRIPT, page('# safe content\n'));
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('ok');
    expect(status().message).toContain('after rebase');
    git(['merge-base', '--is-ancestor', advanced, 'HEAD'], remote);
    expect(git(['ls-tree', '-r', '--name-only', 'HEAD'], remote)).toContain(TRANSCRIPT);
  }, 30_000);

  test('fixture merge commits do not need ambient Git identity', () => {
    const emptyConfig = join(root, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    const advanced = advanceRemote();
    enqueue(TRANSCRIPT, page('# safe content\n'));
    const result = run('gstack-brain-sync', ['--once'], {
      GIT_CONFIG_SYSTEM: emptyConfig,
      GIT_CONFIG_GLOBAL: emptyConfig,
    });
    expect(result.status).toBe(0);
    expect(status().status).toBe('ok');
    expect(git(['rev-parse', 'HEAD^2'], remote)).toBe(advanced);
    expect(queue()).toEqual([]);
  });

  test('authentication-shaped remote paths do not suppress merge and consent checks', () => {
    const renamed = join(root, 'auth-permission-401-403-forbidden.git');
    renameSync(remote, renamed);
    remote = renamed;
    git(['remote', 'set-url', 'origin', remote]);
    const advanced = advanceRemote();
    hook('post-merge', "printf 'artifacts_sync_mode: full\\ntranscript_ingest_mode: off\\n' > config.yaml");
    enqueue(TRANSCRIPT, page('# safe content\n'));
    const pending = queue();
    const result = run('gstack-brain-sync', ['--once']);
    expect(result.status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(queue()).toEqual(pending);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(advanced);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('transcript_ingest_mode: off');
  }, 30_000);

  for (const message of [
    '403 Forbidden',
    'fatal: Authentication failed for the fixture remote',
    'Permission to fixture/repo denied to fixture-user.',
    'fatal: unable to access fixture: The requested URL returned error: 401',
  ]) {
    test(`genuine remote authentication failure does not retry a merge: ${message}`, () => {
      hook('pre-receive', `printf '%s\\n' '${message}' >&2\nexit 1`, remote);
      enqueue(TRANSCRIPT, page('# safe content\n'));
      expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
      expect(status().status).toBe('push_failed');
      expect(status().message).toContain('auth error');
      expect(readFileSync(join(home, 'security/egress.jsonl'), 'utf8')).not.toContain('curated-memory-git-fetch');
    }, 30_000);
  }

  test('consent is rechecked before the post-merge retry push', () => {
    const advanced = advanceRemote();
    hook('post-merge', "printf 'artifacts_sync_mode: full\\ntranscript_ingest_mode: off\\n' > config.yaml");
    enqueue(TRANSCRIPT, page('# safe content\n'));
    const pending = queue();
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(queue()).toEqual(pending);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(advanced);
  }, 30_000);

  test('the queue lock prevents a cooperating second publisher from consuming pending work', () => {
    enqueue(TRANSCRIPT, page('# safe content\n'));
    mkdirSync(join(home, '.brain-sync.lock.d'));
    write('.brain-sync.lock.d/pid', `${process.pid}\n`);
    const before = git(['rev-parse', 'HEAD']);
    const pending = queue();
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(queue()).toEqual(pending);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
  }, 30_000);

  test('incomplete history fails closed instead of scanning a shallow tip only', () => {
    write('.git/shallow', `${git(['rev-parse', 'HEAD'])}\n`);
    enqueue(TRANSCRIPT, page('# safe content\n'));
    const before = git(['rev-parse', 'HEAD']);
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
    expect(queue().length).toBe(1);
  }, 30_000);

  test('a missing queued transcript stays pending for manual recovery', () => {
    enqueue(TRANSCRIPT, page('# safe content\n'));
    rmSync(join(home, TRANSCRIPT));
    const pending = queue();
    const before = git(['rev-parse', 'HEAD']);
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(queue()).toEqual(pending);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
  }, 30_000);

  test('an unavailable outgoing blob fails closed without consuming unrelated pending work', () => {
    write(TRANSCRIPT, page('# legacy content\n'));
    git(['add', '-f', '--', TRANSCRIPT]);
    git(['commit', '-q', '-m', 'fixture legacy transcript']);
    const oid = git(['rev-parse', `HEAD:${TRANSCRIPT}`]);
    rmSync(join(home, '.git/objects', oid.slice(0, 2), oid.slice(2)));
    enqueue(CURATED, '{"insight":"safe"}\n');
    const pending = queue();
    const before = git(['rev-parse', 'HEAD'], remote);
    expect(run('gstack-brain-sync', ['--once']).status).toBe(0);
    expect(status().status).toBe('blocked');
    expect(queue()).toEqual(pending);
    expect(git(['rev-parse', 'HEAD'], remote)).toBe(before);
  }, 30_000);
});
