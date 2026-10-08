/**
 * gstack-brain-sync removals (artifacts_sync_removals): off by default, a
 * synced file gone from disk stays published; on, the drain publishes its
 * removal, and a drain that would remove more than 20 files at once publishes
 * none of them until `--publish-removals --yes`. Temp GSTACK_HOME, local bare
 * remote; no network.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

let home: string;
let remote: string;

function run(argv: string[]) {
  const r = spawnSync(path.join(ROOT, 'bin', argv[0]), argv.slice(1), {
    env: { ...process.env, HOME: home, GSTACK_HOME: home },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? -1 };
}

const remoteFiles = () =>
  spawnSync('git', ['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf-8', timeout: 30_000 })
    .stdout.split('\n').filter((p) => p.startsWith('projects/') || p.startsWith('transcripts/'));
const status = () => JSON.parse(fs.readFileSync(path.join(home, '.brain-sync-status.json'), 'utf-8'));

function write(p: string, body = '# doc\n') {
  fs.mkdirSync(path.dirname(path.join(home, p)), { recursive: true });
  fs.writeFileSync(path.join(home, p), body);
}

function syncAll(files: string[]) {
  for (const f of files) write(f);
  for (const f of files) run(['gstack-brain-enqueue', f]);
  const r = run(['gstack-brain-sync', '--once']);
  expect(r.status).toBe(0);
  expect(remoteFiles()).toEqual(expect.arrayContaining(files));
}

const designs = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `projects/${dir}/designs/d${i}.md`);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-removals-home-'));
  remote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-removals-remote-'));
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { timeout: 30_000 });
  expect(run(['gstack-artifacts-init', '--remote', remote]).status).toBe(0);
  run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

describe('artifacts_sync_removals', () => {
  test('off by default: a deleted synced file stays published', () => {
    expect(run(['gstack-config', 'get', 'artifacts_sync_removals']).stdout.trim()).toBe('off');
    syncAll(['projects/p/designs/a.md', 'projects/p/designs/b.md']);
    fs.rmSync(path.join(home, 'projects/p/designs/a.md'));
    run(['gstack-brain-sync', '--once']);
    expect(remoteFiles()).toContain('projects/p/designs/a.md');
  });

  test('on: a slug migration removes the old copies with the queue empty or not', () => {
    run(['gstack-config', 'set', 'artifacts_sync_removals', 'on']);
    syncAll(['projects/acme/designs/x.md', 'projects/acme/designs/y.md']);
    fs.renameSync(path.join(home, 'projects/acme'), path.join(home, 'projects/owner-acme'));
    run(['gstack-brain-sync', '--discover-new']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(remoteFiles().sort()).toEqual(['projects/owner-acme/designs/x.md', 'projects/owner-acme/designs/y.md']);
    expect(status().message).toContain('published 2 removal(s)');

    fs.rmSync(path.join(home, 'projects/owner-acme/designs/y.md'));
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(remoteFiles()).toEqual(['projects/owner-acme/designs/x.md']);
    expect(status().status).toBe('ok');
  });

  test('on: tracked files outside the allowlist and transcript pages are never removed', () => {
    run(['gstack-config', 'set', 'artifacts_sync_removals', 'on']);
    syncAll(['projects/p/designs/a.md']);
    write('projects/p/notes.txt');
    write('transcripts/run-1/s1.md');
    spawnSync('git', ['-C', home, 'add', '-f', 'projects/p/notes.txt', 'transcripts/run-1/s1.md'], { timeout: 30_000 });
    spawnSync('git', ['-C', home, '-c', 'user.email=u@example.com', '-c', 'user.name=u', 'commit', '-qm', 'manual'], { timeout: 30_000 });
    spawnSync('git', ['-C', home, 'push', '-q', 'origin', 'HEAD'], { timeout: 30_000 });
    for (const p of ['projects/p/notes.txt', 'transcripts/run-1/s1.md', 'projects/p/designs/a.md']) fs.rmSync(path.join(home, p));
    run(['gstack-brain-sync', '--once']);
    expect(remoteFiles().sort()).toEqual(['projects/p/notes.txt', 'transcripts/run-1/s1.md']);
  });

  test('on: a decision log goes only together with its active snapshot', () => {
    run(['gstack-config', 'set', 'artifacts_sync_removals', 'on']);
    const LOG = 'projects/p/decisions.jsonl';
    const SNAP = 'projects/p/decisions.active.json';
    write(SNAP, JSON.stringify([{ id: 'a', kind: 'decide', note: '' }]));
    write(LOG, JSON.stringify({ id: 'a', kind: 'decide', decision: 'd a', scope: 'repo', date: '2026-10-01', source: 'user' }) + '\n');
    run(['gstack-brain-enqueue', LOG]);
    run(['gstack-brain-sync', '--once']);
    expect(remoteFiles()).toEqual(expect.arrayContaining([LOG, SNAP]));
    fs.rmSync(path.join(home, LOG));
    run(['gstack-brain-sync', '--once']);
    expect(remoteFiles()).toEqual(expect.arrayContaining([LOG, SNAP]));
    fs.rmSync(path.join(home, SNAP));
    run(['gstack-brain-sync', '--once']);
    expect(remoteFiles()).toEqual([]);
  });

  test('on: more than 20 removals at once publishes none until --publish-removals --yes', () => {
    run(['gstack-config', 'set', 'artifacts_sync_removals', 'on']);
    const files = designs('big', 21);
    syncAll(files);
    fs.rmSync(path.join(home, 'projects/big'), { recursive: true });
    const drain = run(['gstack-brain-sync', '--once']);
    expect(drain.stderr).toContain('holding 21 removal(s), more than 20 at once');
    expect(remoteFiles().sort()).toEqual([...files].sort());
    expect(status().message).toContain('none of the removals were published');

    const listed = run(['gstack-brain-sync', '--publish-removals']);
    expect(listed.stdout).toContain('21 synced file(s) are gone from disk:');
    expect(listed.stdout).toContain('  projects/big/designs/d0.md');
    expect(remoteFiles()).toHaveLength(21);

    const published = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(published.status).toBe(0);
    expect(published.stdout).toContain('published 21 removal(s)');
    expect(remoteFiles()).toEqual([]);
  });

  test('--publish-removals --yes works with the setting off and only touches removals', () => {
    syncAll(['projects/p/designs/a.md', 'projects/p/designs/b.md']);
    fs.rmSync(path.join(home, 'projects/p/designs/a.md'));
    write('projects/p/designs/b.md', '# changed, not yet synced\n');
    const r = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(r.status).toBe(0);
    expect(remoteFiles()).toEqual(['projects/p/designs/b.md']);
    const remoteB = spawnSync('git', ['--git-dir=' + remote, 'show', 'main:projects/p/designs/b.md'], { encoding: 'utf-8', timeout: 30_000 });
    expect(remoteB.stdout).toBe('# doc\n');
    expect(run(['gstack-brain-sync', '--publish-removals', '--yes']).stdout).toContain('no removals to publish');
  });

  test('config rejects values other than on and off', () => {
    const r = run(['gstack-config', 'set', 'artifacts_sync_removals', 'yes']);
    expect(r.stderr).toContain("artifacts_sync_removals 'yes' not recognized");
    expect(run(['gstack-config', 'get', 'artifacts_sync_removals']).stdout.trim()).toBe('off');
  });
});
