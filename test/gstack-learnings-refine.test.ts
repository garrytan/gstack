import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-learnings-refine');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-refine-home-'));
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-refine-cwd-'));
// gstack-slug derives slug from git remote (none here) → falls back to basename of cwd.
const slug = path.basename(tmpCwd).replace(/[^a-zA-Z0-9._-]/g, '');
const projDir = path.join(tmpHome, 'projects', slug);
const learnFile = path.join(projDir, 'learnings.jsonl');

function run(args: string[]): string {
  return execFileSync(BIN, args, {
    env: { ...process.env, GSTACK_HOME: tmpHome },
    cwd: tmpCwd,
    encoding: 'utf-8',
  });
}
function runJson(args: string[]): any {
  return JSON.parse(run([...args, '--json'])).report[0];
}
function write(entries: any[]) {
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(learnFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// Two reworded pitfalls about the SAME lesson (different keys) — the case exact
// key+type dedup misses. Char-trigram recall rescues low word-cosine here.
const PITFALL_A = { ts: '2026-05-01T00:00:00Z', skill: 'test', type: 'pitfall', key: 'sa-thread-a', insight: 'SQLAlchemy sessions are not thread safe; use engine not session under asyncio.to_thread from the chat loop.', confidence: 8, source: 'observed', trusted: false, files: ['a.py'] };
const PITFALL_B = { ts: '2026-05-02T00:00:00Z', skill: 'test', type: 'pitfall', key: 'sa-thread-b', insight: 'When running under asyncio.to_thread pass engine rather than session because SQLAlchemy session objects are not threadsafe.', confidence: 6, source: 'inferred', trusted: false, files: ['b.py'] };
const UNRELATED = { ts: '2026-05-03T00:00:00Z', skill: 'test', type: 'pattern', key: 'css-grid', insight: 'Use CSS grid template areas for the dashboard layout reflow on mobile.', confidence: 5, source: 'observed', trusted: false, files: [] };
// Moderately-similar pair (gray zone, ~0.6) — should surface under --review, never merge.
const MOD_P = { ts: '2026-05-04T00:00:00Z', skill: 'test', type: 'pitfall', key: 'pool-p', insight: 'Database connection pool exhaustion happens when async tasks hold connections across await points without releasing them.', confidence: 8, source: 'observed', trusted: false, files: [] };
const MOD_Q = { ts: '2026-05-05T00:00:00Z', skill: 'test', type: 'pitfall', key: 'pool-q', insight: 'Release the database connection before awaiting long operations or the connection pool will exhaust under load.', confidence: 6, source: 'observed', trusted: false, files: [] };

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('gstack-learnings-refine semantic dedup (dry-run)', () => {
  test('clusters a reworded same-type near-duplicate that exact key+type dedup misses', () => {
    write([PITFALL_A, PITFALL_B, UNRELATED]);
    const r = runJson([]);
    expect(r.clusters.length).toBe(1);
    expect(r.semanticDropped).toBe(1);
    // survivor is the higher effective-confidence row, not the lower one
    expect(r.clusters[0].survivor.key).toBe('sa-thread-a');
  });

  test('leaves unrelated insights alone', () => {
    write([PITFALL_A, PITFALL_B, UNRELATED]);
    const merged = runJson([]).clusters.flatMap((c: any) => [c.survivor.key, ...c.members.map((m: any) => m.key)]);
    expect(merged).not.toContain('css-grid');
  });

  test('compacts exact key+type duplicates (latest winner)', () => {
    write([
      { ...UNRELATED, key: 'sse', ts: '2026-04-01T00:00:00Z', insight: 'older phrasing' },
      { ...UNRELATED, key: 'sse', ts: '2026-05-03T00:00:00Z', insight: 'newer phrasing wins' },
      PITFALL_A,
    ]);
    expect(runJson([]).exactDropped).toBe(1);
  });

  test('does not merge a cross-type near-duplicate by default, but does with --cross-type', () => {
    const asPref = { ...PITFALL_B, type: 'preference', key: 'sa-thread-pref' };
    write([PITFALL_A, asPref, UNRELATED]);
    expect(runJson([]).semanticDropped).toBe(0);
    expect(runJson(['--cross-type']).semanticDropped).toBe(1);
  });
});

describe('gstack-learnings-refine --apply', () => {
  test('merges the near-dup: removes the loser, unions files, bumps confidence to cluster max', () => {
    write([PITFALL_A, PITFALL_B, UNRELATED]);
    run(['--apply']);
    const rows = fs.readFileSync(learnFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(['css-grid', 'sa-thread-a']);
    const survivor = rows.find((r) => r.key === 'sa-thread-a');
    expect(survivor.files.sort()).toEqual(['a.py', 'b.py']); // unioned
    expect(survivor.confidence).toBe(8); // cluster max raw confidence
    expect(fs.existsSync(`${learnFile}.bak`)).toBe(true);
  });

  test('is idempotent: a second --apply changes nothing', () => {
    write([PITFALL_A, PITFALL_B, UNRELATED]);
    run(['--apply']);
    const after1 = fs.readFileSync(learnFile, 'utf-8');
    run(['--apply']);
    expect(fs.readFileSync(learnFile, 'utf-8')).toBe(after1);
  });

  test('never rewrites a file containing an unparseable line', () => {
    fs.mkdirSync(projDir, { recursive: true });
    const good = JSON.stringify(PITFALL_A);
    const good2 = JSON.stringify(PITFALL_B);
    fs.writeFileSync(learnFile, `${good}\n{ this is not json\n${good2}\n`);
    const before = fs.readFileSync(learnFile, 'utf-8');
    run(['--apply']);
    expect(fs.readFileSync(learnFile, 'utf-8')).toBe(before); // untouched
  });
});

describe('gstack-learnings-refine --review (gray zone)', () => {
  test('surfaces a moderately-similar pair below the merge bar without merging it', () => {
    write([MOD_P, MOD_Q, UNRELATED]);
    const r = runJson(['--review', '--review-floor', '0.45']);
    expect(r.semanticDropped).toBe(0); // gray zone never auto-merges
    const pair = (r.reviewPairs || []).find((p: any) => [p.a.key, p.b.key].sort().join() === 'pool-p,pool-q');
    expect(pair).toBeTruthy();
    expect(pair.sim).toBeLessThan(0.70);
    expect(pair.sim).toBeGreaterThanOrEqual(0.45);
  });

  test('excludes an already-merged member from the review list', () => {
    write([PITFALL_A, PITFALL_B, MOD_P, MOD_Q]);
    const r = runJson(['--review', '--review-floor', '0.30']);
    const reviewKeys = (r.reviewPairs || []).flatMap((p: any) => [p.a.key, p.b.key]);
    expect(reviewKeys).not.toContain('sa-thread-b'); // merged into sa-thread-a, so not a candidate
  });
});

describe('gstack-learnings-refine --min-entries (lazy-on-overflow)', () => {
  test('skips a file with fewer live rows than the threshold', () => {
    write([PITFALL_A, PITFALL_B, UNRELATED]);
    const out = JSON.parse(run(['--min-entries', '10', '--json']));
    expect(out.report.length).toBe(0);
  });
});
