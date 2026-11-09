/**
 * rebuildFromNotes reads every refs/notes/gstack-trains note on each land and
 * first ready (lib/ship-queue-land-direct.ts). Reading them one
 * `git cat-file blob` process at a time took 15 to 21 s on the live 1,442
 * notes (reports/GSTA-461.md item 4); these tests pin one batched read and
 * prove it restores exactly the records the per-note read restored.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NOTES_REF, parseNote, rebuildFromNotes, recordPath, type AnyRecord } from '../lib/ship-queue-train-record';

const roots: string[] = [];
const saved = { root: process.env.GSTACK_STATE_ROOT, path: process.env.PATH };
afterEach(() => {
  if (saved.root === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = saved.root;
  process.env.PATH = saved.path;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const IDENTITY = { GIT_AUTHOR_NAME: 'notes-fixture', GIT_AUTHOR_EMAIL: 'notes@fixture.local', GIT_COMMITTER_NAME: 'notes-fixture', GIT_COMMITTER_EMAIL: 'notes@fixture.local' };
function run(cwd: string, args: string[], input?: string): string {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...IDENTITY } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.replace(/\n$/, '');
}

const KEY = 'example-repo';
const sha = (s: string) => createHash('sha1').update(s).digest('hex');
const at = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
const screen = { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null };
const ready = (i: number, extra: Record<string, unknown> = {}) => ({ schema: 1, kind: 'ready', repo_key: KEY, pr: String(1000 + i), head: sha(`head${i}`), base_sha: sha('base'), ready_at: at(i), screen, updated_at: at(i), ...extra });
const land = (i: number) => ({ schema: 1, kind: 'land', repo_key: KEY, pr: String(1000 + i), pin: sha(`head${i}`), base_sha: sha('base'), merge_sha: sha(`merge${i}`), tree: sha(`tree${i}`), landed_at: at(i), updated_at: at(i) });

/** The live notes' shapes: ready and land pairs, trains, a freeze, plus the notes the reader must skip or keep byte for byte. */
function noteBodies(pairs: number): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < pairs; i++) bodies.push(JSON.stringify(ready(i)), JSON.stringify(land(i)));
  for (let i = 0; i < 5; i++) bodies.push(JSON.stringify({ schema: 1, kind: 'train', nonce: `t${i}`, repo_key: KEY, state: 'merged', slots: [], updated_at: at(i) }));
  bodies.push(JSON.stringify({ schema: 1, kind: 'freeze', repo_key: KEY, reason: 'red main', cleared_at: at(9), updated_at: at(9) }, null, 2) + '\n');
  bodies.push('{"schema":1,"kind":"ready",');
  bodies.push('');
  bodies.push(JSON.stringify({ schema: 2, kind: 'ready', repo_key: KEY, pr: '1', head: sha('x'), updated_at: at(1) }));
  bodies.push(JSON.stringify(ready(9000, { note: 'café — 日本語 ✓ multibyte' })));
  bodies.push(JSON.stringify(ready(9001, { note: `${sha('fake')} blob 12\n{"schema":1}\n` })));
  return bodies;
}

/** An origin whose notes ref holds the bodies, each a raw blob (no stripspace), and a fresh clone that has fetched nothing yet. */
function fixture(bodies: string[]): { repo: string; origin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-notes-batch-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'work');
  run(root, ['init', '-q', '--bare', origin]);
  run(root, ['init', '-q', repo]);
  run(repo, ['remote', 'add', 'origin', origin]);
  process.env.GSTACK_STATE_ROOT = path.join(root, 'state');
  if (!bodies.length) return { repo, origin };
  const files = bodies.map((b, i) => { const f = path.join(root, `n${i}`); fs.writeFileSync(f, b); return f; });
  const blobs = run(origin, ['hash-object', '-w', '--stdin-paths'], files.join('\n') + '\n').split('\n');
  const tree = run(origin, ['mktree'], blobs.map((b, i) => `100644 blob ${b}\t${sha(`annotated${i}`)}`).join('\n') + '\n');
  run(origin, ['update-ref', NOTES_REF, run(origin, ['commit-tree', tree, '-m', 'Notes added by fixture'])]);
  return { repo, origin };
}

/** The reader as it was before the batch: one `git cat-file blob` per listed note, parsed by the same parseNote. */
function perNoteRecords(repo: string): AnyRecord[] {
  return run(repo, ['notes', `--ref=${NOTES_REF}`, 'list']).split('\n').map(l => l.split(' ')[0]!).filter(Boolean)
    .map(blob => parseNote(spawnSync('git', ['cat-file', 'blob', blob], { cwd: repo, encoding: 'utf8', timeout: 60_000 }).stdout.replace(/\n$/, '')))
    .filter((r): r is AnyRecord => !!r);
}

function writtenRecords(): Record<string, unknown> {
  const dir = path.join(process.env.GSTACK_STATE_ROOT!, 'ship-queue');
  const out: Record<string, unknown> = {};
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = JSON.parse(fs.readFileSync(p, 'utf8')); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** A git on PATH that logs each invocation's arguments, so a test can count processes; failBatch makes `cat-file --batch` exit 128. */
function countingGit(root: string, failBatch = false): string {
  const real = path.join(spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim(), 'git');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'git.log');
  fs.mkdirSync(bin, { recursive: true });
  const fail = failBatch ? `case "$*" in "cat-file --batch"*) exit 128;; esac\n` : '';
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\n${fail}exec '${real}' "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${saved.path}`;
  return log;
}

describe('rebuildFromNotes reads the notes in one batch', () => {
  // Value: protects=land --pin and the first ready stay fast as notes grow (15 to 21 s on 1,442 live notes, past the 120 s command timeout in about three months, which leaves the land lock held);
  // fails_when=the reader spawns one git process per note again; why_new=no test counted the reader's processes; seam=a logging git on PATH; no_claim=wall time on a loaded machine
  test('several hundred notes are read by a single git cat-file process', () => {
    const { repo } = fixture(noteBodies(200));
    const log = countingGit(path.dirname(repo));
    const r = rebuildFromNotes(repo, 'origin');
    const catFiles = fs.readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('cat-file'));
    expect(catFiles.length).toBe(1);
    expect(r).toMatchObject({ read: 408, fetched: true });
  }, 60_000);

  // Value: protects=land and the freeze lock refuse instead of reading an empty queue when the one batch read fails;
  // fails_when=readBlobs ignores the batch process's exit status again; why_new=one failed batch drops every note at once, where one failed per-note read dropped one; seam=a git on PATH whose cat-file --batch exits 128; no_claim=timeouts and maxBuffer overruns, which take the same status path
  test('a failed batch read reports fetched false and restores nothing', () => {
    const { repo } = fixture(noteBodies(3));
    countingGit(path.dirname(repo), true);
    expect(rebuildFromNotes(repo, 'origin')).toMatchObject({ restored: 0, read: 0, fetched: false });
    expect(writtenRecords()).toEqual({});
  }, 60_000);

  // Value: protects=the batched read restores exactly what the per-note read restored, so no land or ready sees different queue state;
  // fails_when=the batch parser mis-sizes a multibyte or header-like body, keeps a malformed, empty or wrong-schema note, or reorders duplicate records; why_new=nothing compared the reader against the per-note read;
  // seam=a bare origin whose notes are raw blobs; no_claim=notes merge conflicts (fetchNotes)
  test('the batch restores the same records as the per-note read, skipping malformed, empty and wrong-schema notes', () => {
    const duplicates = [JSON.stringify(ready(9002, { updated_at: at(1) })), JSON.stringify(ready(9002, { updated_at: at(2), note: 'second copy' }))];
    const { repo } = fixture([...noteBodies(200), ...duplicates]);
    const r = rebuildFromNotes(repo, 'origin');
    const expected = perNoteRecords(repo);
    expect(expected.length).toBe(410);
    const byPath: Record<string, unknown> = {};
    for (const rec of expected) byPath[recordPath(rec)] = rec;
    expect(writtenRecords()).toEqual(byPath);
    expect(r).toEqual({ restored: 410, read: 410, detail: 'notes fetched', fetched: true });
    const multibyte = expected.find(x => x.kind === 'ready' && x.pr === '10000') as { note?: string } | undefined;
    expect(multibyte?.note).toBe('café — 日本語 ✓ multibyte');
  }, 60_000);

  // Value: protects=today's rebuild rules (a local record at least as new as its note is kept; a second rebuild restores nothing; no notes ref reads nothing);
  // fails_when=the batch changes which records count as fresh or fails on an empty ref; why_new=these paths had no direct test; seam=the state root's record files; no_claim=the push side (persist)
  test('a newer local record is kept, a repeat rebuild restores nothing, and an origin without notes reads nothing', () => {
    const { repo } = fixture(noteBodies(3));
    const mine = { ...ready(0), updated_at: at(999), note: 'local copy' } as unknown as AnyRecord;
    fs.mkdirSync(path.dirname(recordPath(mine)), { recursive: true });
    fs.writeFileSync(recordPath(mine), JSON.stringify(mine));
    expect(rebuildFromNotes(repo, 'origin')).toMatchObject({ restored: 13, read: 14 });
    expect(JSON.parse(fs.readFileSync(recordPath(mine), 'utf8')).note).toBe('local copy');
    expect(rebuildFromNotes(repo, 'origin')).toMatchObject({ restored: 0, read: 14, detail: 'notes current' });
    const empty = fixture([]);
    expect(rebuildFromNotes(empty.repo, 'origin')).toEqual({ restored: 0, read: 0, detail: `origin has no ${NOTES_REF} yet`, fetched: true });
  }, 60_000);
});
