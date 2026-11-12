/**
 * Scoped transcript consent across the publication path: the ingest stages
 * transcript pages under ~/.gstack/transcripts/ (remote-http mode), and
 * gstack-brain-sync purges out-of-scope staged pages and scans its unpushed
 * commits before every push, so a page outside the current consent is never
 * published. Local bare repo as the remote; stub gbrain; no network.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

const ROOT = join(import.meta.dir, '..');
const BIN = join(ROOT, 'bin');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

setDefaultTimeout(30_000);

let home: string;
let gstackHome: string;
let remote: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gstack-bscope-'));
  gstackHome = join(home, '.gstack');
  remote = join(home, 'remote.git');
  mkdirSync(gstackHome, { recursive: true });
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { timeout: 30_000 });
  const bindir = join(home, 'bin');
  mkdirSync(bindir);
  writeFileSync(join(bindir, 'gbrain'), `#!/bin/sh\ncase "$1" in\n  --help) printf 'Commands:\\n  import <dir>   Import markdown directory\\n' ;;\n  *) echo '{}' ;;\nesac\n`);
  chmodSync(join(bindir, 'gbrain'), 0o755);
  // Remote-http MCP mode: the ingest stages to ~/.gstack/transcripts/ for brain-sync to push.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { type: 'url', url: 'https://brain.example/mcp' } } }));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  HOME: home,
  GSTACK_HOME: gstackHome,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  PATH: `${join(home, 'bin')}:${process.env.PATH || ''}`,
});
const run = (cmd: string, ...args: string[]) => {
  const r = spawnSync(join(BIN, cmd), args, { encoding: 'utf-8', timeout: 60_000, cwd: home, env: env() });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const ingest = () => {
  const r = spawnSync('bun', [join(BIN, 'gstack-memory-ingest.ts'), '--bulk', '--quiet', '--sources', 'transcript'], { encoding: 'utf-8', timeout: 60_000, cwd: home, env: env() });
  return { status: r.status, err: r.stderr ?? '' };
};
const remoteFiles = () =>
  spawnSync('git', ['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf-8', timeout: 30_000 }).stdout.split('\n').filter((l) => l.startsWith('transcripts/'));
const stagedOnDisk = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.md')) out.push(relative(gstackHome, join(dir, e.name)));
    }
  };
  walk(join(gstackHome, 'transcripts'));
  return out;
};

function repo(slug: string): string {
  const dir = join(home, 'work', slug.replace('/', '-'));
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['-C', dir, 'init', '-q'], { timeout: 30_000 });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${slug}.git`], { timeout: 30_000 });
  return dir;
}

function session(id: string, cwd: string, start: string, appendNow = false): void {
  const dir = join(home, '.claude', 'projects', 'p');
  mkdirSync(dir, { recursive: true });
  let body = JSON.stringify({ type: 'user', message: { role: 'user', content: `hello ${id}` }, cwd, timestamp: start }) + '\n';
  if (appendNow) body += JSON.stringify({ type: 'user', message: { role: 'user', content: 'later' }, timestamp: iso(Date.now()) }) + '\n';
  writeFileSync(join(dir, `${id}.jsonl`), body);
}

function initArtifacts(): void {
  expect(run('gstack-artifacts-init', '--remote', remote).status).toBe(0);
  expect(run('gstack-config', 'set', 'artifacts_sync_mode', 'full').status).toBe(0);
}

/** A staged transcript page as the ingest renders it. */
function stagePage(rel: string, remoteName: string, start: string): void {
  mkdirSync(join(gstackHome, rel, '..'), { recursive: true });
  writeFileSync(join(gstackHome, rel), `---\nagent: claude-code\nsession_id: ${rel}\ngit_remote: ${remoteName}\nstart_time: ${start}\nsession_started_at: ${start}\nsource_path: /src/${rel}\ntitle: "x"\ntype: transcript\n---\n\nbody\n`);
}

describe.skipIf(process.platform === 'win32')('scoped consent end to end', () => {
  test('new@: a pre-cutoff session appended later is never staged or pushed; a new one is', () => {
    initArtifacts();
    const now = Date.now();
    expect(run('gstack-config', 'set', 'transcript_ingest_mode', `new@${iso(now - DAY)}`).status).toBe(0);
    const app = repo('acme/app');
    session('preappend0001', app, iso(now - 2 * DAY), true);
    session('postcutoff001', app, iso(now - 60_000));
    expect(ingest().status).toBe(0);
    expect(stagedOnDisk().join('\n')).not.toMatch(/preappend000/);
    expect(stagedOnDisk().join('\n')).toMatch(/postcutoff00/);
    expect(run('gstack-brain-sync', '--discover-new').status).toBe(0);
    expect(run('gstack-brain-sync', '--once').status).toBe(0);
    expect(remoteFiles().join('\n')).toMatch(/postcutoff00/);
    expect(remoteFiles().join('\n')).not.toMatch(/preappend000/);
  });

  test('allow, stage, revoke, allow: the purge removes the page and its fingerprint, so an unchanged source re-stages', () => {
    const app = repo('acme/app');
    repo('acme/web');
    session('appsession001', app, iso(Date.now()));
    expect(run('gstack-config', 'set', 'transcript_ingest_mode', 'all').status).toBe(0);
    expect(run('gstack-config', 'set', 'transcript_repos', 'github.com/acme/app').status).toBe(0);
    expect(ingest().status).toBe(0);
    expect(stagedOnDisk()).toHaveLength(1);
    const statePath = join(gstackHome, '.transcript-ingest-state.json');
    expect(Object.keys(JSON.parse(readFileSync(statePath, 'utf-8')).sessions)).toHaveLength(1);

    expect(run('gstack-config', 'set', 'transcript_repos', 'github.com/acme/web').status).toBe(0);
    const revoked = ingest();
    expect(revoked.err).toContain('[memory-ingest] removed 1 staged transcript pages outside the new scope');
    expect(stagedOnDisk()).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(statePath, 'utf-8')).sessions)).toEqual([]);

    expect(run('gstack-config', 'set', 'transcript_repos', 'github.com/acme/app').status).toBe(0);
    expect(ingest().status).toBe(0);
    expect(stagedOnDisk()).toHaveLength(1);
  });
});

describe.skipIf(process.platform === 'win32')('the unpublished range is scanned before every push', () => {
  function strandCommit(): void {
    initArtifacts();
    expect(run('gstack-config', 'set', 'transcript_ingest_mode', 'all').status).toBe(0);
    stagePage('transcripts/run-1-1/app.md', 'github.com/acme/app', iso(Date.now()));
    stagePage('transcripts/run-1-1/web.md', 'github.com/acme/web', iso(Date.now()));
    run('gstack-brain-enqueue', 'transcripts/run-1-1/app.md');
    run('gstack-brain-enqueue', 'transcripts/run-1-1/web.md');
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    expect(run('gstack-brain-sync', '--once').status).toBe(0);
    expect(remoteFiles()).toEqual([]);
    rmSync(hook);
    writeFileSync(join(gstackHome, '.brain-last-push-attempt'), '0');
  }

  test('failed push, narrower allowlist, retry: the excluded page is rewritten out and purged; the rest pushes', () => {
    strandCommit();
    expect(run('gstack-config', 'set', 'transcript_repos', 'github.com/acme/app').status).toBe(0);
    const retry = run('gstack-brain-sync', '--once');
    expect(retry.status).toBe(0);
    expect(retry.err).toContain('removed 1 excluded transcript pages from unpublished sync commits');
    expect(remoteFiles()).toEqual(['transcripts/run-1-1/app.md']);
    expect(existsSync(join(gstackHome, 'transcripts/run-1-1/web.md'))).toBe(false);
    const log = spawnSync('git', ['--git-dir=' + remote, 'log', '--format=%an %s', 'main'], { encoding: 'utf-8', timeout: 30_000 }).stdout;
    expect(log).toContain('rewritten without 1 excluded transcript page(s)');
  });

  test('failed push, then off: nothing transcript is pushed; pages wait on disk and in the queue until consent returns', () => {
    strandCommit();
    expect(run('gstack-config', 'set', 'transcript_ingest_mode', 'off').status).toBe(0);
    const retry = run('gstack-brain-sync', '--once');
    expect(retry.status).toBe(0);
    expect(retry.err).toContain('removed 2 excluded transcript pages from unpublished sync commits');
    expect(remoteFiles()).toEqual([]);
    expect(stagedOnDisk().sort()).toEqual(['transcripts/run-1-1/app.md', 'transcripts/run-1-1/web.md']);

    expect(run('gstack-config', 'set', 'transcript_ingest_mode', 'all').status).toBe(0);
    expect(run('gstack-brain-sync', '--once').status).toBe(0);
    expect(remoteFiles().sort()).toEqual(['transcripts/run-1-1/app.md', 'transcripts/run-1-1/web.md']);
  });
});
